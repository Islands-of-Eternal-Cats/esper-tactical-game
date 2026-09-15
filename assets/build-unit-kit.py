"""
Кит юнитов: кот, риггнутый в Mixamo, пять его клипов — и `unit-kit.glb`.

    blender --background --python assets/build-unit-kit.py

Вход — папка `assets/mixamo/cat/`: кот со скелетом и скином из авториггера
Mixamo (`assets/export-for-mixamo.py` готовит для него меш) и клипы,
скачанные *для этого кота* (см. FILES). Клипы — без скина, «In Place» для
бега желательно, но не обязательно: горизонтальный ход бёдер здесь всё
равно вырезается, движение по земле даёт симуляция.

Переноса анимаций нет: скелет построен по мешу кота, и клипы Mixamo
ретаргетит на него сам. Раньше здесь был Y Bot и перенос его клипов на
самодельный скелет кота через мировые дельты — руки приходили не туда.

Выход: `assets/unit.blend` (эталон) и `public/models/unit-kit.glb`.

Контракт с кодом (проверяется `tests/unit-kit.test.ts`):
  узел меша `unit_body`, кости `mixamorig:*` и `tail_*`, клипы idle / run /
  aim / fire / die, у `run` в extras `foot_speed` — скорость опорной стопы,
  по которой рендер подбирает timeScale, чтобы ноги не скользили.

Карта кота остаётся: обе стороны — коты, сторону рендер кладёт оттенком.
Хвост авториггер не знает: его кости и веса — из эталона `rusty.blend`.
"""

import glob
import os
import sys

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Два типа тела — два скелета, два набора клипов. Свои — кот, противник —
# Y Bot; у каждого свои клипы, скачанные для него: перенос не нужен.
CHARACTERS = [
    # (папка, префикс клипов, имя скелета, имя меша, рост, плоский цвет или None — своя карта)
    ("cat", "cat_", "cat_rig", "cat_body", 1.20, None),
    ("unit", "", "unit_rig", "unit_body", 1.35, (0.6, 0.6, 0.6, 1.0)),
]
BLEND = os.path.join(ROOT, "assets", "unit.blend")
GLB = os.path.join(ROOT, "public", "models", "unit-kit.glb")
CAT_BLEND = os.path.join(ROOT, "assets", "rusty.blend")
CAT_RIG = "rusty_rig"

RIG = "mixamorig:"
FPS = 30

# Бюджет треугольников Y Bot: приходит с 55k, на нашем масштабе это
# неразличимо от двух тысяч. Кот идёт родной сеткой (~5,5k).
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


def fbx_files(src):
    files = sorted(glob.glob(os.path.join(src, "*.fbx")) + glob.glob(os.path.join(src, "*.FBX")))
    if not files:
        sys.exit(f"в {src} нет FBX: положите персонажа и клипы из Mixamo")
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


def to_tpose(rig, meshes):
    """Rest-поза персонажа — T-поза, как у клипов.

    Mixamo отдаёт персонажа с bind-позой, в которой он был загружен (у кота —
    A-поза), а T-позу кладёт однокадровым клипом. Клипы же записаны от
    T-позы: положить их на A-позу — руки уходят к лицу (проверено: плечо
    расходится на 58°). Поэтому однокадровый клип запекается в rest-позу и в
    меш, и дальше всё считается от T.
    """
    ad = rig.animation_data
    act = ad.action if ad is not None else None
    if act is None or (act.frame_range[1] - act.frame_range[0]) > 2:
        log("персонаж без однокадровой T-позы — rest-поза как есть")
        return
    bpy.context.scene.frame_set(int(act.frame_range[0]))
    bpy.context.view_layer.update()
    for m in meshes:
        for mod in [x for x in m.modifiers if x.type == "ARMATURE"]:
            bpy.context.view_layer.objects.active = m
            bpy.ops.object.modifier_apply(modifier=mod.name)
        mod = m.modifiers.new("armature", "ARMATURE")
        mod.object = rig
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    ad.action = None
    bpy.data.actions.remove(act)
    log("rest-поза → T-поза из однокадрового клипа")


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


def fit(rig, meshes, height):
    """Рост — height, подошвы — на нуле. Масштаб остаётся на объекте
    арматуры: применять его нельзя — смещения бёдер в клипах живут в
    локальных единицах костей и после применения прыгнули бы."""
    h, z0 = height_of(meshes)
    k = height / h
    rig.scale = rig.scale * k
    rig.location.z -= z0 * k
    bpy.context.view_layer.update()
    log(f"рост {h:.2f} → {height:.2f}, масштаб арматуры {rig.scale.x:.4f}")


def one_mesh(meshes, rig, name, flat):
    """Все меши персонажа — в один меш `name`. `flat` — плоский цвет
    (Y Bot: сторону кладёт рендер); None — материал и карта как пришли (кот)."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = name
    body.data.name = name
    if flat is not None:
        body.data.materials.clear()
        mat = bpy.data.materials.new(name + "_flat")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            bsdf.inputs["Base Color"].default_value = flat
            bsdf.inputs["Roughness"].default_value = 0.9
        body.data.materials.append(mat)
        for uv in list(body.data.uv_layers):
            body.data.uv_layers.remove(uv)
    else:
        for mat in body.data.materials:
            if mat is None:
                continue
            mat.name = name + "_skin"
            bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.use_nodes else None
            if bsdf is not None:
                bsdf.inputs["Roughness"].default_value = 0.9
                bsdf.inputs["Metallic"].default_value = 0.0
        for img in bpy.data.images:
            if img.users > 0 and not img.packed_file and img.filepath:
                img.pack()
    for ca in list(body.data.color_attributes):
        body.data.color_attributes.remove(ca)
    return body


def soften_shoulders(body, rig):
    """Веса плеч и рук — сгладить.

    Автовеса Mixamo на толстой куртке кота режут сустав резко: рука,
    поднятая вперёд в прицеле, ломала рукав складкой у плеча. Несколько
    проходов сглаживания по группам плеча и плечевой кости растягивают
    переход на соседние вершины — сустав гнётся, а не переламывается.
    """
    groups = [RIG + n for n in ("LeftShoulder", "RightShoulder", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm")]
    names = {g.name for g in body.vertex_groups}
    groups = [g for g in groups if g in names]
    if not groups:
        return
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    for g in groups:
        body.vertex_groups.active_index = body.vertex_groups[g].index
        bpy.ops.object.vertex_group_smooth(group_select_mode="ACTIVE", factor=0.5, repeat=6, expand=0.5)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"плечи: веса сглажены ({len(groups)} групп)")


def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(body, tris):
    before = tris_of(body)
    if before <= tris:
        log(f"{before} тр., децимация не нужна")
        return
    mod = body.modifiers.new("decimate", "DECIMATE")
    mod.ratio = tris / before
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


def adopt(rig, path, name, loop, prefix):
    """Клип из файла — на скелет `rig`. Кости те же, поэтому экшен
    переносится как есть; временная арматура удаляется. Экшен зовётся
    `prefix + name`: у двух скелетов клипы лежат в одном файле."""
    tmp_rig, tmp_meshes = import_fbx(path)
    normalise_names(tmp_rig)
    act = tmp_rig.animation_data.action if tmp_rig.animation_data else None
    if act is None:
        sys.exit(f"{os.path.basename(path)}: в файле нет анимации")
    act.name = prefix + name
    act.use_fake_user = True
    delete(tmp_meshes + [tmp_rig])
    first, last = act.frame_range
    name = act.name
    if name.endswith("run"):
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
# Хвост
# --------------------------------------------------------------------------

X_AXIS = Vector((1.0, 0.0, 0.0))
Z_AXIS = Vector((0.0, 0.0, 1.0))

# Как хвост живёт в каждом клипе: волн за клип, размах вбок, подъём.
# Волна одна на цикл бега (два шага), в покое — медленная и мелкая,
# при смерти хвост опадает и замирает.
TAIL_WAVES = {
    "idle": (2.0, 0.6, 0.15),
    "run": (1.0, 1.0, 0.0),
    "aim": (1.0, 0.35, 0.1),
    "fire": (0.25, 0.35, 0.1),
    "die": (0.0, 0.0, -0.6),
}


def to_bone(pb, turns):
    """Повороты вокруг мировых осей → кватернион в базисе кости (как в ките кота)."""
    q = Quaternion((1.0, 0.0, 0.0, 0.0))
    for axis, angle in turns:
        q = Quaternion(axis, angle) @ q
    m = pb.bone.matrix_local.to_quaternion()
    return m.inverted() @ q @ m


def wag_tail(rig, act, name, first, last):
    """Хвост — в клип Mixamo, где его нет: одна волна с отставанием по звеньям,
    та же, что у кота во дворе (`tail()` в build-character-kit.py)."""
    waves, gain, lift0 = TAIL_WAVES.get(name, (1.0, 0.5, 0.1))
    ad = rig.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots[0]
    bones = [rig.pose.bones[f"tail_{i}"] for i in (1, 2, 3)]
    swing = (0.16, 0.22, 0.26)
    rise = (0.10, 0.16, 0.22)
    n = max(1, int(last) - int(first))
    for f in range(int(first), int(last) + 1):
        t = (f - int(first)) / n
        phase = 2.0 * math.pi * waves * t
        side = math.sin(phase) * gain
        lift = lift0 + 0.12 * (1.0 - math.cos(2.0 * phase)) * gain
        if name == "die":
            # Опадает за первую треть клипа и лежит.
            k = min(1.0, t * 3.0)
            side = 0.0
            lift = lift0 * k
        for i, pb in enumerate(bones):
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = to_bone(pb, [(Z_AXIS, side * swing[i]), (X_AXIS, lift * rise[i])])
            pb.keyframe_insert("rotation_quaternion", frame=f)
    ad.action = None
    for pb in bones:
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)

def graft_tail(rig, body, keep_actions):
    """Хвост из эталона — на скелет Mixamo.

    Авториггер о хвосте не знает и раздаёт его вершины ближайшей ноге — хвост
    махал бы вместе с бедром. Порядок вершин Mixamo сохраняет (проверено:
    расхождение 0), поэтому веса хвоста переносятся из `rusty.blend` по
    индексу, а кости `tail_*` встают под бёдра в тех же мировых точках.
    """
    if not os.path.exists(CAT_BLEND):
        sys.exit(f"нет {CAT_BLEND}: сначала npm run assets (кит кота)")
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(CAT_BLEND, link=False) as (src, dst):
        dst.objects = [CAT_RIG, "body_stocky"]
    added = [o for o in bpy.data.objects if o not in before]
    old_rig = next(o for o in added if o.type == "ARMATURE")
    old_body = next(o for o in added if o.type == "MESH")
    if len(old_body.data.vertices) > len(body.data.vertices):
        sys.exit("корпус эталона больше меша Mixamo: порядок вершин не тот")

    tails = [b for b in old_rig.data.bones if b.name.startswith("tail_")]
    tails.sort(key=lambda b: b.name)
    world_inv = rig.matrix_world.inverted()
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    for b in tails:
        nb = eb.new(b.name)
        nb.head = world_inv @ (old_rig.matrix_world @ b.head_local)
        nb.tail = world_inv @ (old_rig.matrix_world @ b.tail_local)
        nb.parent = eb[b.parent.name if b.parent.name in eb else RIG + "Hips"]
    bpy.ops.object.mode_set(mode="OBJECT")

    names = [b.name for b in tails]
    groups = {n: body.vertex_groups.new(name=n) for n in names}
    moved = 0
    for v in old_body.data.vertices:
        weights = []
        for g in v.groups:
            n = old_body.vertex_groups[g.group].name
            if n in groups and g.weight > 0.0:
                weights.append((n, g.weight))
        if not weights:
            continue
        total = sum(w for _, w in weights)
        nv = body.data.vertices[v.index]
        for g in list(nv.groups):
            body.vertex_groups[g.group].remove([v.index])
        for n, w in weights:
            groups[n].add([v.index], w / total, "REPLACE")
        moved += 1
    delete([old_body, old_rig])
    # Вместе с эталоном приехали его клипы (idle, walk, haul…): они в его
    # ките, здесь им не место — иначе экспорт положит их в кит юнитов.
    for act in list(bpy.data.actions):
        if act not in keep_actions:
            bpy.data.actions.remove(act)
    log(f"хвост: {len(tails)} кости, {moved} вершин")


def build_character(folder, prefix, rig_name, body_name, height, flat):
    src = os.path.join(ROOT, "assets", "mixamo", folder)
    files = fbx_files(src)
    clip_files = {}
    for name, need, avoid, loop in FILES:
        f = pick(files, need, avoid)
        if f is None and name == "die":
            f = pick(files, *DIE_ALT)
        if f is None and name == "idle":
            # Без Rifle Idle кит собирается, но стоять юнит будет в прицеле.
            f = pick(files, ("aim",))
            log(f"ВНИМАНИЕ: в {folder} нет Rifle Idle — покой временно из прицела; скачайте Rifle Idle")
        if f is None:
            sys.exit(f"{folder}: нет файла для клипа {name} (в имени: {' и '.join(need)})")
        clip_files[name] = (f, loop)
    used = {f for f, _ in clip_files.values()}
    character = pick(files, ("for-mixamo",)) or pick(files, ("character",)) or next((f for f in files if f not in used), None)
    if character is None:
        sys.exit(f"{folder}: нет файла персонажа со скином, не совпадающего по имени с клипами")
    log(f"персонаж {folder}: {os.path.basename(character)}")

    rig, meshes = import_fbx(character)
    normalise_names(rig)
    rig.name = rig_name
    if not meshes:
        sys.exit("у персонажа нет меша: качайте его «with skin»")
    to_tpose(rig, meshes)
    fit(rig, meshes, height)
    body = one_mesh(meshes, rig, body_name, flat)
    decimate(body, TRIS if flat is not None else 10_000)
    if flat is None:
        soften_shoulders(body, rig)
        graft_tail(rig, body, set(bpy.data.actions))
    for name, (path, loop) in clip_files.items():
        act = adopt(rig, path, name, loop, prefix)
        if flat is None:
            first, last = act.frame_range
            wag_tail(rig, act, name, first, last)
    log(f"{body_name}: {tris_of(body)} тр.")


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.render.fps = FPS

    for spec in CHARACTERS:
        build_character(*spec)

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
        export_image_format="JPEG",
        export_jpeg_quality=80,
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
