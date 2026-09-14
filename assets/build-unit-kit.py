"""
Кит юнитов из Mixamo: один скелет, пять клипов — и `unit-kit.glb`.

    blender --background --python assets/build-unit-kit.py

Вход — папка `assets/mixamo/unit/`: персонаж в T-позе со скином и клипы,
скачанные для того же персонажа (см. FILES). Клипы можно качать без скина,
«In Place» для бега — желательно, но не обязательно: горизонтальный ход
бёдер здесь всё равно вырезается, движение по земле даёт симуляция.

Выход: `assets/unit.blend` (эталон) и `public/models/unit-kit.glb`.

Контракт с кодом (проверяется `tests/unit-kit.test.ts`):
  узел меша `unit_body`, кости `mixamorig:*`, клипы idle / run / aim /
  fire / die, у `run` в extras `foot_speed` — скорость опорной стопы, по
  которой рендер подбирает timeScale, чтобы ноги не скользили.

Текстур нет: материал один и плоский, цвет стороны кладёт рендер.
"""

import glob
import os
import sys

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "mixamo", "unit")
BLEND = os.path.join(ROOT, "assets", "unit.blend")
GLB = os.path.join(ROOT, "public", "models", "unit-kit.glb")

RIG = "mixamorig:"
FPS = 30

# Рост юнита от подошв до макушки, м. Кот — 1.20; юнит чуть выше, но
# клетка всё ещё метр, и в проём он должен помещаться.
HEIGHT = 1.35

# Бюджет треугольников на всего юнита: Mixamo-персонажи приходят с 10–25k,
# на нашем масштабе это неразличимо от двух тысяч.
TRIS = 2200

# Имя клипа → подстроки имени файла (без учёта регистра): все из `need`,
# ни одной из `avoid`. Порядок — порядок в ките. Файл персонажа — тот, что
# не подошёл ни одному клипу, либо `character*.fbx`.
FILES = [
    ("idle", ("idle",), ("aim",), True),
    ("run", ("run",), (), True),
    ("aim", ("aim",), (), True),
    ("fire", ("fir",), (), False),
    ("die", ("d", "ing"), (), False),
]
DIE_ALT = (("death",), ())


def log(msg):
    print(f"  {msg}")


def fbx_files():
    files = sorted(glob.glob(os.path.join(SRC, "*.fbx")) + glob.glob(os.path.join(SRC, "*.FBX")))
    if not files:
        sys.exit(f"в {SRC} нет FBX: положите персонажа и клипы из Mixamo")
    return files


def pick(files, need, avoid=()):
    """Первый файл, в имени которого есть все `need` и нет ни одного `avoid`."""
    for f in files:
        name = os.path.basename(f).lower()
        if all(n in name for n in need) and not any(a in name for a in avoid):
            return f
    return None


def import_fbx(path):
    """Импорт с очисткой: возвращает (арматура, меши) из этого файла."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(
        filepath=path,
        use_anim=True,
        ignore_leaf_bones=True,
        automatic_bone_orientation=False,
        use_custom_normals=False,
    )
    new = [o for o in bpy.data.objects if o not in before]
    rigs = [o for o in new if o.type == "ARMATURE"]
    meshes = [o for o in new if o.type == "MESH"]
    if len(rigs) != 1:
        sys.exit(f"{os.path.basename(path)}: ожидалась одна арматура, найдено {len(rigs)}")
    return rigs[0], meshes


def normalise_names(rig):
    """Mixamo иногда нумерует префикс (`mixamorig1:`); контракт — без номера."""
    for b in rig.data.bones:
        if b.name.startswith("mixamorig") and not b.name.startswith(RIG):
            b.name = RIG + b.name.split(":", 1)[1]


def delete(objects):
    for o in objects:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Armature):
                bpy.data.armatures.remove(data)


def height_of(meshes):
    zs = []
    for m in meshes:
        for v in m.data.vertices:
            zs.append((m.matrix_world @ v.co).z)
    return max(zs) - min(zs), min(zs)


def fit(rig, meshes):
    """Рост — HEIGHT, подошвы — на нуле. Масштаб остаётся на объекте
    арматуры: применять его нельзя — смещения бёдер в клипах живут в
    локальных единицах костей и после применения прыгнули бы."""
    h, z0 = height_of(meshes)
    k = HEIGHT / h
    rig.scale = rig.scale * k
    rig.location.z -= z0 * k
    bpy.context.view_layer.update()
    log(f"рост {h:.2f} → {HEIGHT:.2f}, масштаб арматуры {rig.scale.x:.4f}")


def one_mesh(meshes, rig):
    """Все меши персонажа — в один `unit_body` с плоским материалом."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = "unit_body"
    body.data.name = "unit_body"
    body.data.materials.clear()
    mat = bpy.data.materials.new("unit")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.6, 0.6, 0.6, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.9
    body.data.materials.append(mat)
    # Атрибуты, которые Mixamo тащит с собой, но ките не нужны.
    for uv in list(body.data.uv_layers):
        body.data.uv_layers.remove(uv)
    for ca in list(body.data.color_attributes):
        body.data.color_attributes.remove(ca)
    return body


def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(body):
    before = tris_of(body)
    if before <= TRIS:
        log(f"{before} тр., децимация не нужна")
        return
    mod = body.modifiers.new("decimate", "DECIMATE")
    mod.ratio = TRIS / before
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=mod.name)
    log(f"децимация: {before} → {tris_of(body)} тр.")


def strip_root_motion(act):
    """Горизонтальный ход бёдер — из клипа вон. Локальная ось Y бедра
    смотрит вверх по кости; X и Z — по земле."""
    path = f'pose.bones["{RIG}Hips"].location'
    fcs = fcurves_of(act)
    for fc in list(fcs):
        if fc.data_path == path and fc.array_index in (0, 2):
            fcs.remove(fc)


def fcurves_of(act):
    if hasattr(act, "layers") and act.layers:
        return act.layers[0].strips[0].channelbag(act.slots[0]).fcurves
    return act.fcurves


def foot_speed(rig, act, first, last):
    """Скорость опорной стопы, ед/с: в каждом кадре — медленнейшая из двух
    стоп (она на земле), среднее по циклу. Не зависит от фазы контакта,
    в отличие от расчёта кота, где кадр 0 — контакт по построению."""
    ad = rig.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots[0]
    feet = [rig.pose.bones[RIG + "LeftFoot"], rig.pose.bones[RIG + "RightFoot"]]
    prev = None
    speeds = []
    for f in range(int(first), int(last) + 1):
        bpy.context.scene.frame_set(f)
        cur = [(rig.matrix_world @ b.head).xy.copy() for b in feet]
        if prev is not None:
            speeds.append(min((cur[i] - prev[i]).length for i in range(2)) * FPS)
        prev = cur
    ad.action = None
    return sum(speeds) / len(speeds) if speeds else 0.0


def adopt(rig, path, name, loop):
    """Клип из файла — на главный скелет. Кости те же, поэтому экшен
    переносится как есть; временная арматура удаляется."""
    tmp_rig, tmp_meshes = import_fbx(path)
    normalise_names(tmp_rig)
    act = tmp_rig.animation_data.action if tmp_rig.animation_data else None
    if act is None:
        sys.exit(f"{os.path.basename(path)}: в файле нет анимации")
    act.name = name
    act.use_fake_user = True
    delete(tmp_meshes + [tmp_rig])
    first, last = act.frame_range
    if name == "run":
        strip_root_motion(act)
        act["foot_speed"] = foot_speed(rig, act, first, last)
        log(f"{name}: ноги {act['foot_speed']:.2f} ед/с")
    ad = rig.animation_data or rig.animation_data_create()
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(first), act)
    strip.action_frame_start, strip.action_frame_end = first, last
    track.mute = True
    log(f"клип {name}: {(last - first) / FPS:.2f} с{'' if loop else ', однократный'}")


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.render.fps = FPS

    files = fbx_files()
    clip_files = {}
    for name, need, avoid, loop in FILES:
        f = pick(files, need, avoid)
        if f is None and name == "die":
            f = pick(files, *DIE_ALT)
        if f is None:
            sys.exit(f"нет файла для клипа {name} (в имени: {' и '.join(need)})")
        clip_files[name] = (f, loop)
    used = {f for f, _ in clip_files.values()}
    character = pick(files, ("character",)) or next((f for f in files if f not in used), None)
    if character is None:
        sys.exit("нет файла персонажа: T-поза со скином, не совпадающая по имени с клипами")
    log(f"персонаж: {os.path.basename(character)}")

    rig, meshes = import_fbx(character)
    normalise_names(rig)
    rig.name = "unit_rig"
    if rig.animation_data is not None:
        rig.animation_data.action = None
    if not meshes:
        sys.exit("у персонажа нет меша: качайте его «with skin»")
    fit(rig, meshes)
    body = one_mesh(meshes, rig)
    decimate(body)

    for name, (path, loop) in clip_files.items():
        adopt(rig, path, name, loop)

    log(f"юнит: {tris_of(body)} тр.")
    os.makedirs(os.path.dirname(GLB), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_skins=True,
        export_vertex_color="NONE",
        export_materials="EXPORT",
        export_image_format="NONE",
        export_animations=True,
        export_extras=True,
        export_animation_mode="ACTIONS",
        export_frame_range=False,
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=False,
        export_draco_mesh_compression_enable=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"эталон: {BLEND}")
    print(f"кит: {GLB}")


if __name__ == "__main__":
    main()
