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

Вторая половина кита — те же четыре боевых клипа, перенесённые на скелет
кота из `assets/rusty.blend`: `cat_run / cat_aim / cat_fire / cat_die`. Свои
в перестрелке — Ржавый, и стрелять он должен позами Mixamo, а не пылесосить.
Скелет кота Mixamo-совместим по именам, но не по rest-позе (руки в A-позе,
нет Spine2 и пальцев), поэтому перенос — через мировые дельты поворотов с
выравниванием направлений костей, а не копированием локальных кватернионов.
"""

import glob
import os
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "mixamo", "unit")
BLEND = os.path.join(ROOT, "assets", "unit.blend")
GLB = os.path.join(ROOT, "public", "models", "unit-kit.glb")
CAT_BLEND = os.path.join(ROOT, "assets", "rusty.blend")
CAT_RIG = "rusty_rig"
# Клипы, которые переносятся на кота. Idle у кота свой, из его кита.
CAT_CLIPS = ("run", "aim", "fire", "die")

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
    return act


# --------------------------------------------------------------------------
# Перенос на кота
# --------------------------------------------------------------------------

def append_cat_rig():
    """Скелет кота из эталона — без мешей и без его клипов: они в его ките."""
    if not os.path.exists(CAT_BLEND):
        sys.exit(f"нет {CAT_BLEND}: сначала npm run assets (кит кота)")
    before = set(bpy.data.objects)
    bpy.ops.wm.append(
        filepath=os.path.join(CAT_BLEND, "Object", CAT_RIG),
        directory=os.path.join(CAT_BLEND, "Object"),
        filename=CAT_RIG,
    )
    rigs = [o for o in bpy.data.objects if o not in before and o.type == "ARMATURE"]
    if len(rigs) != 1:
        sys.exit(f"в {CAT_BLEND} не нашлась арматура {CAT_RIG}")
    rig = rigs[0]
    rig.name = "cat_rig"
    # Клипы кота приехали вместе с NLA — снять, иначе экспорт положит их в
    # кит юнитов под теми же именами, что у Y Bot.
    old = set()
    if rig.animation_data is not None:
        for t in rig.animation_data.nla_tracks:
            for st in t.strips:
                if st.action is not None:
                    old.add(st.action)
        rig.animation_data_clear()
    for act in old:
        if act.users == 0 or act.use_fake_user:
            bpy.data.actions.remove(act)
    rig.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    return rig


def rot3(m):
    return m.to_3x3().normalized()


def retarget(src, src_act, dst, name, first, last, scale):
    """Клип `src_act` со скелета `src` — на скелет `dst`, экшеном `name`.

    Для каждой кости-тёзки: мировая дельта поворота источника от его
    rest-позы применяется к rest-позе приёмника, предварительно повёрнутой
    так, чтобы направление кости совпало с источником (A-поза → T-поза).
    Пропущенные в приёмнике кости (Spine2, пальцы) не теряются: дельта
    мировая, потомок несёт её в себе. Бёдра переносят и смещение — в
    масштабе роста.
    """
    ad = src.animation_data
    ad.action = src_act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = src_act.slots[0]

    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    dad = dst.animation_data or dst.animation_data_create()
    dad.action = act
    if hasattr(dad, "action_slot") and dad.action_slot is None:
        dad.action_slot = act.slots.new(id_type="OBJECT", name=dst.name)

    src_world = src.matrix_world
    dst_world = dst.matrix_world
    dst_world_inv = dst_world.inverted()
    pairs = []
    # Порядок — родители раньше детей: поза потомка считается от позы родителя.
    # Голова не переносится — как и в клипах самого кота: у него короткая
    # шея и огромная голова, и запрокинутая по-человечески голова читается
    # как оторванная. Голова идёт за шеей; взгляд — дело рантайма.
    for bone in dst.data.bones:
        if bone.name not in src.data.bones or bone.name == RIG + "Head":
            continue
        depth = 0
        p = bone.parent
        while p is not None:
            depth += 1
            p = p.parent
        pairs.append((depth, bone.name))
    pairs.sort()
    names = [n for _, n in pairs]

    corr = {}
    for n in names:
        sb = src.data.bones[n]
        db = dst.data.bones[n]
        d_src = (rot3(src_world) @ (sb.tail_local - sb.head_local)).normalized()
        d_dst = (rot3(dst_world) @ (db.tail_local - db.head_local)).normalized()
        corr[n] = d_dst.rotation_difference(d_src).to_matrix()

    hips = RIG + "Hips"
    src_hips_rest = (src_world @ src.data.bones[hips].matrix_local).to_translation()
    dst_hips_rest = (dst_world @ dst.data.bones[hips].matrix_local).to_translation()
    # По вертикали — в масштабе высоты бёдер, а не роста: лежащее тело —
    # это бёдра у самого пола, и после масштаба по росту у коротконогого
    # кота они уходили под пол. По горизонтали — по росту, как и шаг.
    scale_v = dst_hips_rest.z / src_hips_rest.z
    scale_xy = Vector((scale, scale, scale_v))

    for f in range(int(first), int(last) + 1):
        bpy.context.scene.frame_set(f)
        pose = {}
        for n in names:
            sb = src.data.bones[n]
            spb = src.pose.bones[n]
            db = dst.data.bones[n]
            dpb = dst.pose.bones[n]

            delta = rot3(src_world @ spb.matrix) @ rot3(src_world @ sb.matrix_local).inverted()
            target_rot = delta @ corr[n] @ rot3(dst_world @ db.matrix_local)
            target_arm = (rot3(dst_world_inv) @ target_rot).to_4x4()

            if db.parent is None or db.parent.name not in pose:
                base = db.matrix_local.copy()
            else:
                base = pose[db.parent.name] @ (db.parent.matrix_local.inverted() @ db.matrix_local)
            if n == hips:
                moved = (src_world @ spb.matrix).to_translation() - src_hips_rest
                moved = Vector((moved.x * scale_xy.x, moved.y * scale_xy.y, moved.z * scale_xy.z))
                target_arm.translation = dst_world_inv @ (dst_hips_rest + moved)
            else:
                target_arm.translation = base.to_translation()
            pose[n] = target_arm

            basis = base.inverted() @ target_arm
            dpb.rotation_mode = "QUATERNION"
            dpb.rotation_quaternion = basis.to_quaternion()
            dpb.keyframe_insert("rotation_quaternion", frame=f)
            if n == hips:
                dpb.location = basis.to_translation()
                dpb.keyframe_insert("location", frame=f)

    ad.action = None
    dad.action = None
    for pb in dst.pose.bones:
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
    return act


def cat_clips(unit_rig, cat, clip_actions, unit_height):
    """Четыре боевых клипа — на кота, полосами NLA `cat_*`."""
    cat_h = max((cat.matrix_world @ b.tail_local).z for b in cat.data.bones)
    scale = cat_h / unit_height
    dad = cat.animation_data or cat.animation_data_create()
    for name in CAT_CLIPS:
        src_act = clip_actions[name]
        first, last = src_act.frame_range
        act = retarget(unit_rig, src_act, cat, f"cat_{name}", first, last, scale)
        if name == "run":
            act["foot_speed"] = foot_speed(cat, act, first, last)
            log(f"cat_run: ноги {act['foot_speed']:.2f} ед/с")
        track = dad.nla_tracks.new()
        track.name = f"cat_{name}"
        strip = track.strips.new(f"cat_{name}", int(first), act)
        strip.action_frame_start, strip.action_frame_end = first, last
        track.mute = True
        log(f"клип cat_{name}: перенесён")
    dad.action = None


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

    actions = {}
    for name, (path, loop) in clip_files.items():
        actions[name] = adopt(rig, path, name, loop)

    log(f"юнит: {tris_of(body)} тр.")
    cat = append_cat_rig()
    cat_clips(rig, cat, actions, HEIGHT)
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
