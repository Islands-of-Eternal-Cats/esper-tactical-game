"""
Эталон кота: скелет, части, сокеты — и `character-kit.glb` из него.

Техплан требует один эталонный файл, из которого копией создаются все новые
части: одна съехавшая bind-поза ломает всех котов сразу и обнаруживается после
того, как сделано двенадцать голов. Это правило процедурное, поэтому эталон
здесь строится скриптом — тогда оно проверяемо, а не соблюдается на честном
слове.

    blender --background --python assets/build-character-kit.py

Пишет `assets/rusty.blend` (эталон) и `public/models/character-kit.glb`.

Оси: X вправо, -Y вперёд (лицо кота), Z вверх. Экспортёр приводит это к
glTF +Y вверх; кот смотрит в +Z, как капсула в рендере до шага 6.

Имена мешей — часть контракта с кодом, по ним гасится видимость:
`head_rusty`, `body_stocky`, `gear_vacuum`, `held_vacuum`.
Скелет — Mixamo-совместимый (`mixamorig:*`), чтобы клипы локомоции
ретаргетились без правки имён. Хвост и уши — своя цепочка: в humanoid-ригах
их нет, Mixamo не даст ничего.
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, "assets", "rusty.blend")
GLB = os.path.join(ROOT, "public", "models", "character-kit.glb")

# Палитра — та же, что в src/render/palette.ts. Текстур нет ни одной: кот
# красится цветом вершин с мокапов, RUSTY — запасной цвет там, куда ни один
# ракурс не достал.
RUSTY = (0.76, 0.44, 0.23, 1.0)
GEAR = (0.21, 0.31, 0.36, 1.0)

RIG = "mixamorig:"

# --------------------------------------------------------------------------
# Ориентиры. Меш сгенерирован по мокапам (Hunyuan3D, см. assets/gen/), его
# пропорции — не пропорции болванки: ноги длиннее, плечи выше. Скелет
# подгоняется под меш, а не наоборот: иначе автовеса тянут колено бедром.
#
# Всё в метрах после нормировки: кот от подошвы до кончиков ушей — HEIGHT.
# --------------------------------------------------------------------------

HEIGHT = 1.20

# Ориентиры сняты по сечениям меша Tripo (после нормировки): колено — по
# наколенникам, пах — где сходятся ноги, плечи — где сужается силуэт над
# руками. Руки висят ниже, чем у Hunyuan-меша: кисти на 0.48, а не 0.52.
L = {
    "ankle": 0.05, "knee": 0.33, "crotch": 0.45, "hips": 0.62,
    "spine": 0.76, "chest": 0.90, "neck": 0.96, "skull": 1.10,
    "leg_x": 0.11, "foot_fwd": -0.12,
    "shoulder_x": 0.20, "shoulder_z": 0.88,
    "elbow": (0.28, -0.02, 0.70), "wrist": (0.34, -0.04, 0.55), "hand": (0.35, -0.04, 0.48),
    # Хвост Tripo висит вниз и чуть влево (в +X), кончик у щиколоток.
    "tail": [(0.04, 0.18, 0.58), (0.10, 0.21, 0.42), (0.15, 0.23, 0.26), (0.24, 0.28, 0.10)],
    "ear": ((0.07, -0.07, 1.12), (0.085, -0.07, 1.20)),
}

# --------------------------------------------------------------------------
# Скелет. head → tail, родитель, срастаться ли с родителем.
# --------------------------------------------------------------------------

def mirrored(name, head, tail, parent, connect):
    """Пара костей левой и правой стороны. Кот смотрит в -Y, значит лево — +X.

    В `parent` `{s}` подставляется стороной: `"{s}Arm"` — своя сторона,
    `"Spine1"` — общая кость.
    """
    out = []
    for side, sx in (("Left", 1.0), ("Right", -1.0)):
        out.append((
            RIG + side + name,
            (head[0] * sx, head[1], head[2]),
            (tail[0] * sx, tail[1], tail[2]),
            RIG + parent.format(s=side),
            connect,
        ))
    return out


BONES = [
    (RIG + "Hips", (0, 0, L["crotch"]), (0, 0, L["hips"]), None, False),
    (RIG + "Spine", (0, 0, L["hips"]), (0, 0, L["spine"]), RIG + "Hips", True),
    (RIG + "Spine1", (0, 0, L["spine"]), (0, 0, L["chest"]), RIG + "Spine", True),
    (RIG + "Neck", (0, 0, L["chest"]), (0, 0, L["neck"]), RIG + "Spine1", True),
    (RIG + "Head", (0, 0, L["neck"]), (0, 0, L["skull"]), RIG + "Neck", True),
]
BONES += mirrored("Shoulder", (0.06, 0, L["shoulder_z"]), (L["shoulder_x"], 0, L["shoulder_z"]), "Spine1", False)
# Руки — в A-позе, как на мокапах: меш так сгенерирован, и веса лягут ровно.
# Клипы опускают их постоянным приведением, см. ARM_ADDUCT.
BONES += mirrored("Arm", (L["shoulder_x"], 0, L["shoulder_z"]), L["elbow"], "{s}Shoulder", True)
BONES += mirrored("ForeArm", L["elbow"], L["wrist"], "{s}Arm", True)
BONES += mirrored("Hand", L["wrist"], L["hand"], "{s}ForeArm", True)
BONES += mirrored("UpLeg", (L["leg_x"], 0, L["crotch"]), (L["leg_x"], 0, L["knee"]), "Hips", False)
BONES += mirrored("Leg", (L["leg_x"], 0, L["knee"]), (L["leg_x"], 0, L["ankle"]), "{s}UpLeg", True)
BONES += mirrored("Foot", (L["leg_x"], 0, L["ankle"]), (L["leg_x"], L["foot_fwd"], 0.02), "{s}Leg", True)

# Вне humanoid: хвост и уши. Хвост — дугой в сторону, как на мокапе сбоку.
T = L["tail"]
BONES += [
    ("tail_1", T[0], T[1], RIG + "Hips", False),
    ("tail_2", T[1], T[2], "tail_1", True),
    ("tail_3", T[2], T[3], "tail_2", True),
    ("ear_l", L["ear"][0], L["ear"][1], RIG + "Head", False),
    ("ear_r", (-L["ear"][0][0],) + L["ear"][0][1:], (-L["ear"][1][0],) + L["ear"][1][1:], RIG + "Head", False),
]
# Сокеты: пропс крепится к кости и риггинга не требует вообще.
HAND_R = (-L["hand"][0], -0.03, L["hand"][2])
SOCKETS = [
    ("socket_hand_r", HAND_R, (HAND_R[0], HAND_R[1] - 0.12, HAND_R[2]), RIG + "RightHand"),
    # Ранец сидит на пояснице, у ремня — не между лопатками: кость Spine.
    ("socket_back", (0, 0.12, L["spine"] - 0.04), (0, 0.24, L["spine"] - 0.04), RIG + "Spine"),
]


def build_armature():
    arm = bpy.data.armatures.new("rusty_rig")
    obj = bpy.data.objects.new("rusty_rig", arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name, head, tail, parent, connect in BONES:
        b = arm.edit_bones.new(name)
        b.head, b.tail = Vector(head), Vector(tail)
        if parent is not None:
            b.parent = arm.edit_bones[parent]
            b.use_connect = connect
    for name, head, tail, parent in SOCKETS:
        b = arm.edit_bones.new(name)
        b.head, b.tail = Vector(head), Vector(tail)
        b.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    # Сокет не деформирует: иначе автовеса отдадут ему кусок ладони.
    for name, *_ in SOCKETS:
        arm.bones[name].use_deform = False
    return obj


# --------------------------------------------------------------------------
# Геометрия кота: меш Tripo по мокапам, assets/gen/tripo/ — OBJ с развёрткой
# и картой цвета. Здесь он нормируется, красится (цвет вершин — из карты,
# запасной) и режется на голову и корпус. Ремеша и проекции нет: Tripo отдаёт
# чистую топологию на 5.4k треугольников и текстуру без призраков ракурсов —
# Hunyuan-путь с ремешем и проектором в numpy жил здесь до него.
# Пропсы по-прежнему коробки — на сокетах их и так не видно.
# --------------------------------------------------------------------------

GEN_DIR = os.path.join(ROOT, "assets", "gen", "tripo")
GEN = os.path.join(GEN_DIR, "rusty.obj")
GEN_TEXTURE = os.path.join(GEN_DIR, "rusty_basecolor.jpg")
# Разметка граней по частям — сегментация Tripo (AssetHub, part_segmentation
# «balanced») того же меша: 21 часть, ровно наши 5409 граней, сопоставлены по
# центроидам. По ней хвост — это хвост, а не «рыжее в радиусе», подсумки
# висят на своей кости жёстко, а голова отделяется по швам, не по высоте.
GEN_PARTS = os.path.join(GEN_DIR, "parts.json")
PART = {
    "jacket": 0, "glove_r": 1, "pants": 2, "head": 3, "hood": 4,
    "boot_l": 5, "boot_r": 6, "thigh_pouch_l": 7, "glove_l": 8, "tail": 9,
    "thigh_pouch_r": 10, "belt_pouch_front": 11, "belt_pouch_side": 12,
    "belt_pouch_back": 13, "chest_tag": 14,
}
# Мелочь на морде (глаза, усы): 15–20, по 3–5 граней — идёт с головой.
HEAD_PARTS = {PART["head"], 15, 16, 17, 18, 19, 20}
# Жёсткие детали: вся часть — на одной кости, ей нечего гнуть. Сторона у
# бедренных подсумков — по знаку X центроида, чтобы не путать лево и право.
RIGID_PARTS = {
    PART["thigh_pouch_l"]: "UpLeg", PART["thigh_pouch_r"]: "UpLeg",
    PART["belt_pouch_front"]: RIG + "Hips", PART["belt_pouch_side"]: RIG + "Hips",
    PART["belt_pouch_back"]: RIG + "Hips", PART["chest_tag"]: RIG + "Spine1",
}


def load_parts(obj):
    """Часть каждой грани — в атрибут `part`, чтобы пережить нарезку меша."""
    import json

    labels = json.load(open(GEN_PARTS))["faces"]
    me = obj.data
    if len(labels) != len(me.polygons):
        sys.exit(f"parts.json: {len(labels)} граней, в меше {len(me.polygons)}")
    attr = me.attributes.new("part", "INT", "FACE")
    attr.data.foreach_set("value", labels)


def part_of_faces(obj):
    """Список: часть каждой грани."""
    attr = obj.data.attributes["part"]
    out = [0] * len(attr.data)
    attr.data.foreach_get("value", out)
    return out


def vertex_parts(obj):
    """Множество частей, к граням которых принадлежит каждая вершина."""
    parts = part_of_faces(obj)
    out = [set() for _ in obj.data.vertices]
    for poly, part in zip(obj.data.polygons, parts):
        for v in poly.vertices:
            out[v].add(part)
    return out


def import_gen():
    """Меш Tripo, нормированный: подошва на z=0, уши на HEIGHT, центр корпуса
    в нуле по X и Y (хвост и руки в центровку не входят)."""
    if not os.path.exists(GEN):
        sys.exit(f"нет {GEN}")
    before = set(bpy.data.objects)
    # OBJ у Tripo Y-вверх; импортёр разворачивает в Z-вверх поворотом объекта.
    bpy.ops.wm.obj_import(filepath=GEN)
    meshes = [o for o in set(bpy.data.objects) - before if o.type == "MESH"]
    obj = meshes[0]
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    me = obj.data
    zs = [v.co.z for v in me.vertices]
    zmin, zmax = min(zs), max(zs)
    k = HEIGHT / (zmax - zmin)
    torso = [v.co for v in me.vertices if abs(v.co.z - (zmin + zmax) / 2) < 0.02 * (zmax - zmin)]
    core = [c for c in torso if abs(c.x) < 0.15 * (zmax - zmin)]
    yc = (min(c.y for c in core) + max(c.y for c in core)) / 2
    xc = (min(c.x for c in core) + max(c.x for c in core)) / 2
    for v in me.vertices:
        v.co = Vector(((v.co.x - xc) * k, (v.co.y - yc) * k, (v.co.z - zmin) * k))
    for poly in me.polygons:
        poly.use_smooth = True
    return obj


def load_texture():
    """Карта цвета Tripo — запакованной в .blend, чтобы эталон был один файл."""
    img = bpy.data.images.load(GEN_TEXTURE)
    img.name = "rusty_albedo"
    img.pack()
    return img


def paint_from_texture(obj, img):
    """Цвет вершин из карты — запасной: если картинка до рендера не доехала,
    кот всё равно цветной. Вершина берёт цвет по своей UV."""
    import numpy as np

    me = obj.data
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uv = me.uv_layers.active.data
    colours = np.zeros((len(me.vertices), 4), dtype=np.float32)
    counts = np.zeros(len(me.vertices), dtype=np.float32)
    for loop in me.loops:
        u, v = uv[loop.index].uv
        col = int(min(max(u, 0.0), 0.9999) * w)
        row = int(min(max(v, 0.0), 0.9999) * h)
        colours[loop.vertex_index] += px[row, col]
        counts[loop.vertex_index] += 1.0
    colours /= np.maximum(counts, 1.0)[:, None]
    colours[:, 3] = 1.0
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", colours.ravel())
    me.color_attributes.active_color = attr


def split_head(obj):
    """Голова и корпус — разные меши: у них разные хозяева (порода vs
    архетип), и по имени код гасит видимость. Граница — по частям
    сегментации: морда с ушами отдельно, капюшон остаётся на корпусе."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for poly, part in zip(obj.data.polygons, part_of_faces(obj)):
        poly.select = part in HEAD_PARTS
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    head = [o for o in bpy.context.selected_objects if o != obj][0]
    return obj, head


def vertex_colour_material(name):
    """Материал, который рисует цвет вершин. Экспортёр кладёт COLOR_0 только
    если материал на него ссылается."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes["Principled BSDF"]
    col = nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Col"
    mat.node_tree.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def textured_material(name, atlas):
    """Материал кита: альбедо из атласа. Цвет вершин в меш всё равно уходит
    (COLOR_0), но материал на него не ссылается — иначе три перемножит
    текстуру с цветом вершин, и кот потемнеет вдвое."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes["Principled BSDF"]
    it = nodes.new("ShaderNodeTexImage")
    it.image = atlas
    mat.node_tree.links.new(it.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def build_cat(rig):
    """Корпус и голова из сгенерированного меша, с весами от скелета."""
    obj = import_gen()
    load_parts(obj)
    atlas = load_texture()
    obj.data.materials.clear()
    obj.data.materials.append(textured_material("rusty_skin", atlas))

    body, head = split_head(obj)
    body.name = body.data.name = "body_stocky"
    head.name = head.data.name = "head_rusty"

    # Автовеса: тепловая диффузия от костей. Сокеты помечены как
    # недеформирующие и веса не получают.
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    head.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    for obj in (body, head):
        if not obj.vertex_groups:
            sys.exit(f"{obj.name}: автовеса не легли")
    confine_tail(body, rig)
    pin_rigid_parts(body, rig)
    for obj in (body, head):
        fill_orphans(obj, rig)
    paint_from_texture(body, atlas)
    paint_from_texture(head, atlas)
    return body, head


def pin_rigid_parts(obj, rig):
    """Жёсткие детали — на одной кости целиком.

    Тепловая диффузия делит подсумок между тазом и бедром, и при махе ноги
    он тянется, а бирка на груди без весов вовсе. Вершины, все грани которых
    в жёсткой части, получают одну кость с весом 1; вершины на шве с одеждой
    оставляют веса диффузии — так шов не рвётся.
    """
    parts = part_of_faces(obj)
    per_vertex = vertex_parts(obj)
    centroid = {}
    for poly, part in zip(obj.data.polygons, parts):
        if part in RIGID_PARTS:
            centroid.setdefault(part, []).append(poly.center.x)
    for part, bone in RIGID_PARTS.items():
        if part not in centroid:
            continue
        if bone == "UpLeg":
            side = "Left" if sum(centroid[part]) > 0 else "Right"
            bone = RIG + side + "UpLeg"
        group = obj.vertex_groups[bone]
        moved = 0
        for v in obj.data.vertices:
            if per_vertex[v.index] != {part}:
                continue
            for g in obj.vertex_groups:
                g.remove([v.index])
            group.add([v.index], 1.0, "REPLACE")
            moved += 1
        print(f"  часть {part} → {bone.replace(RIG, '')}: {moved} вершин жёстко")


def fill_orphans(obj, rig):
    """Вершина без весов — ближайшей кости.

    Тепловая диффузия не добирается до отдельных замкнутых деталек (бирка
    на нагрудном ремне), а вершина без весов остаётся в bind-позе и висит в
    воздухе, когда кот двигается. Страховка на выходе: каждая вершина хоть
    кому-то принадлежит.
    """
    from mathutils.geometry import intersect_point_line

    bones = [b for b in rig.data.bones if b.use_deform]
    orphans = [v for v in obj.data.vertices if sum(ge.weight for ge in v.groups) < 0.01]
    for v in orphans:
        nearest = min(bones, key=lambda b: (intersect_point_line(v.co, b.head_local, b.tail_local)[0] - v.co).length)
        obj.vertex_groups[nearest.name].add([v.index], 1.0, "REPLACE")
    if orphans:
        print(f"  {obj.name}: {len(orphans)} вершин без весов → ближайшая кость")


def confine_tail(obj, rig):
    """Хвостовые кости тянут только хвост.

    Корень хвоста стоит у самой спины, и тепловая диффузия отдаёт ему всё
    рядом — подсумок на заду улетал вслед за хвостом. Хвост — часть 9
    сегментации; у вершин вне её хвостовые веса снимаются, остаток
    нормируется. Снимать можно только тем, у кого есть другие кости: иначе
    вершина без весов останется в bind-позе и повиснет в воздухе.
    """
    groups = {g.name: g for g in obj.vertex_groups if g.name.startswith("tail_")}
    if not groups:
        return
    tail_ids = {g.index for g in groups.values()}
    per_vertex = vertex_parts(obj)
    for v in obj.data.vertices:
        if PART["tail"] in per_vertex[v.index]:
            continue
        total = sum(ge.weight for ge in v.groups if ge.group not in tail_ids)
        if total <= 0.0:
            continue
        for g in groups.values():
            g.remove([v.index])
        for ge in v.groups:
            obj.vertex_groups[ge.group].add([v.index], ge.weight / total, "REPLACE")
PROP_TRIS = 800
PROP_TEXTURE = 512


def import_prop(name, filename, length, grip_top=True, align=True, origin="grip", tris=PROP_TRIS):
    """Сгенерированный пропс (Tripo text→3D через AssetHub) под сокет.

    `align` — выровнять по главной оси (PCA по вершинам): рукоятью вверх,
    если `grip_top` — рукоять там, где сечение тоньше. Без `align` модель
    остаётся как сгенерирована (ранец уже стоит вертикально, лямками к
    спине). Начало координат — `grip`: в хвате чуть ниже верха, за него
    держит сокет ладони; `bottom`: в центре дна, им пропс ставится на сокет.
    Длина нормируется, карта ужимается до PROP_TEXTURE, полигоны — под
    PROP_TRIS.
    """
    import numpy as np

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(GEN_DIR, filename))
    meshes = [o for o in set(bpy.data.objects) - before if o.type == "MESH"]
    obj = meshes[0]
    for o in set(bpy.data.objects) - before:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.name = obj.data.name = name

    me = obj.data
    pts = np.array([v.co[:] for v in me.vertices])
    centre = pts.mean(axis=0)
    if align:
        _, _, vt = np.linalg.svd(pts - centre, full_matrices=False)
        axis = vt[0]
        along = (pts - centre) @ axis
        # Толщина концов: разброс поперёк оси у крайних 15 % длины.
        lo, hi = along.min(), along.max()
        def girth(mask):
            q = pts[mask] - centre
            return np.linalg.norm(q - np.outer(q @ axis, axis), axis=1).mean()
        thin_end_positive = girth(along > hi - 0.15 * (hi - lo)) < girth(along < lo + 0.15 * (hi - lo))
        if thin_end_positive != grip_top:
            axis = -axis
        rot = Vector(axis.tolist()).rotation_difference(Vector((0, 0, 1)))
    else:
        lo, hi = pts[:, 2].min(), pts[:, 2].max()
        # Как сгенерировано, только на четверть оборота: у Tripo широкая
        # панель с полосой смотрит в +X, а снаружи, со спины, должна быть
        # видна она — лямки уходят вбок, под руку.
        rot = Quaternion((0.0, 0.0, 1.0), math.pi / 2)
    k = length / (hi - lo)
    for v in me.vertices:
        v.co = rot @ ((v.co - Vector(centre.tolist())) * k)
    zs = [v.co.z for v in me.vertices]
    shift = max(zs) - 0.06 * length if origin == "grip" else min(zs)
    for v in me.vertices:
        v.co.z -= shift
    if origin == "bottom":
        # Ранец ставится спиной к спине: ближняя грань (min Y) — в нуле, а
        # не центроид, который лямки утягивают наружу. Лямки, свисающие
        # ближе корпуса бака, в расчёт не идут — берётся 5-й процентиль.
        ys = sorted(v.co.y for v in me.vertices)
        front = ys[len(ys) // 20]
        for v in me.vertices:
            v.co.y -= front
    for poly in me.polygons:
        poly.use_smooth = True

    now = sum(len(p.vertices) - 2 for p in me.polygons)
    if now > tris:
        d = obj.modifiers.new("dec", "DECIMATE")
        d.ratio = tris / now
        bpy.ops.object.modifier_apply(modifier="dec")

    for mat in me.materials:
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image is not None:
                img = node.image
                img.name = name + "_albedo"
                if img.size[0] > PROP_TEXTURE:
                    img.scale(PROP_TEXTURE, PROP_TEXTURE)
                img.pack()
    return obj


def build_prop(name, parts, mat):
    verts, faces = [], []
    for pv, pf, _ in parts:
        off = len(verts)
        verts.extend(pv)
        faces.extend(tuple(i + off for i in f) for f in pf)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = False
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def box(centre, size, bone):
    cx, cy, cz = centre
    sx, sy, sz = (s / 2 for s in size)
    verts = [
        (cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz),
        (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
        (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz),
        (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz),
    ]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces, bone


def flat_material(name, colour):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = colour
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = colour  # тот же цвет во вьюпорте и в превью
    return mat


def socket(obj, rig, bone, where, tilt=(0.0, 0.0, 0.0)):
    """Пропс на сокете: ни весов, ни стыков, ни совпадающей bind-позы.

    Родитель по кости отсчитывается от её хвоста и разворачивает оси, поэтому
    положение задаётся мировой матрицей — Blender сам приводит её к базису.
    """
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    obj.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()
    obj.matrix_world = Matrix.Translation(Vector(where)) @ Euler(tilt).to_matrix().to_4x4()


# --------------------------------------------------------------------------
# Клипы. Ключевые позы, а не синус: контакт и пронос ставятся руками, между
# ними интерполирует Blender. Синус в рантайме давал ровный поплавок без
# опоры на землю, и никакими коэффициентами это не лечится.
#
# Позы задаются поворотами вокруг МИРОВЫХ осей (X вправо, -Y вперёд, Z вверх)
# и переводятся в базис кости: думать в осях кости, которая смотрит вниз и с
# произвольным roll, нельзя — ошибка знака там неотличима от ошибки позы.
# --------------------------------------------------------------------------

FPS = 30
X, Y, Z = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


# Rest-поза рук — A-поза мокапа. В клипах руки опущены: постоянное приведение
# к корпусу вокруг вертикали, поверх него — поза. Плечи в клипах не ключуются,
# поэтому кость плеча всегда должна быть в списке затронутых.
ARM_ADDUCT = {
    RIG + "LeftArm": [(Y, 0.24)],
    RIG + "RightArm": [(Y, -0.24)],
}


def to_bone(pb, turns):
    """Список поворотов вокруг мировых осей → кватернион в базисе кости.

    Порядок применения — как записан: следующий поворот идёт поверх
    предыдущих, вокруг мировой оси, а не унесённой предыдущим поворотом.
    """
    q = Quaternion((1.0, 0.0, 0.0, 0.0))
    for axis, angle in turns:
        q = Quaternion(axis, angle) @ q
    m = pb.bone.matrix_local.to_quaternion()
    return m.inverted() @ q @ m


def tail(side, lift, gain=1.0):
    """Хвост: одна волна с отставанием по звеньям. Живёт во всех клипах."""
    return {
        "tail_1": [(Z, side * 0.16 * gain), (X, lift * 0.10)],
        "tail_2": [(Z, side * 0.22 * gain), (X, lift * 0.16)],
        "tail_3": [(Z, side * 0.26 * gain), (X, lift * 0.22)],
    }


def leg(side, hip, knee, ankle):
    """Нога одной стороны. Вперёд — отрицательный поворот вокруг X."""
    return {
        RIG + side + "UpLeg": [(X, hip)],
        RIG + side + "Leg": [(X, knee)],
        RIG + side + "Foot": [(X, ankle)],
    }


def arm(side, swing, elbow):
    return {
        RIG + side + "Arm": [(X, swing)],
        RIG + side + "ForeArm": [(X, elbow)],
    }


def spine(lean, twist=0.0, rise=0.0):
    """Корпус: наклон вперёд, скрутка плеч и подъём таза.

    Таз двигается смещением кости, а не всей фигуры: позицию кота в мире
    ведёт код, и root motion в клипе с ней воевал бы.
    """
    return {
        RIG + "Hips": [(Z, -twist)],
        RIG + "Spine": [(X, lean * 0.45)],
        RIG + "Spine1": [(X, lean * 0.55), (Z, twist * 1.4)],
        # Голову клипы не трогают: её рысканье — внимание кота, им управляет
        # рантайм, и трек в клипе затирал бы взгляд.
        RIG + "Neck": [(X, -lean * 0.8)],
        "@rise": rise,
    }


def merge(*parts):
    out = {}
    for p in parts:
        out.update(p)
    return out


# --- походка ---------------------------------------------------------------
#
# Не четыре позы, а формула по фазе. Контакт — экстремум, и если ставить его
# ключом, Безье в нём замирает: нога стоит, корпус едет. А на самом деле в
# контакте опорная нога вращается с постоянной скоростью — стопа прижата к
# земле, тело проезжает над ней. Поэтому опора линейна, мах — с разгоном,
# и ключи стоят каждые несколько кадров: стык поз спрятан внутри формулы.

def smooth(t):
    """Плавный 0→1 без полки на концах: мах ноги разгоняется и тормозит."""
    return t * t * (3.0 - 2.0 * t)


THIGH = L["crotch"] - L["knee"]
SHIN = L["knee"] - L["ankle"]
# Постоянный присед в шаге: колени всегда чуть согнуты. Ноги у кота короткие
# (треть роста), и на прямой ноге стопа до земли на широком шаге не достаёт —
# IK подтягивает её вверх, и она дёргается у контакта. Заодно так ходят тяжёлые.
CROUCH = 0.03
# Просвет стопы в махе: подошва ботинка на 2 см ниже кости носка.
SWING_LIFT = 0.07


def leg_ik(fwd, depth):
    """Углы бедра и колена, чтобы стопа встала в точку: `fwd` вперёд от
    таза (в -Y), `depth` вниз. Двухзвенная IK по теореме косинусов."""
    reach = THIGH + SHIN - 1e-3
    d = min(math.hypot(fwd, depth), reach)
    cos_hip = (THIGH * THIGH + d * d - SHIN * SHIN) / (2.0 * THIGH * d)
    cos_knee = (THIGH * THIGH + SHIN * SHIN - d * d) / (2.0 * THIGH * SHIN)
    alpha = math.acos(max(-1.0, min(1.0, cos_hip)))
    gamma = math.acos(max(-1.0, min(1.0, cos_knee)))
    # Вперёд — отрицательный поворот вокруг X; колено гнётся назад — положительный.
    hip = -(math.atan2(fwd, depth) + alpha)
    knee = math.pi - gamma
    return hip, knee


def leg_at(phase, front, rise):
    """Углы ноги по фазе её цикла: 0 — контакт, 0.5 — отрыв.

    Опора — стопа приклеена к земле и едет назад с постоянной скоростью,
    углы от неё через IK: без этого угол бедра линеен, а стопа — нет
    (синус), и она подскальзывает к краям опоры. `rise` — подъём таза:
    нога в контакте короче, в проносе длиннее.
    """
    depth = THIGH + SHIN + rise
    back = front * 0.75
    # Стопа — дочь голени: её наклон в мире = бедро + колено + голеностоп.
    # В опоре подошва лежит на асфальте плоско, значит голеностоп гасит
    # наклон ноги целиком; иначе носок уходит в землю, когда голень
    # наклоняется вперёд к отталкиванию.
    if phase < 0.5:
        t = phase / 0.5
        hip, knee = leg_ik(front - (front + back) * t, depth)
        return hip, knee, -(hip + knee)
    # Мах — тоже IK, по положению стопы: назад→вперёд с разгоном и дугой
    # вверх с просветом. По углам мах перед контактом ронял носок под
    # землю: углы сходились к контакту раньше, чем стопа поднималась.
    # Носок после отрыва свисает и к контакту снова выравнивается.
    t = (phase - 0.5) / 0.5
    fwd = -back + (front + back) * smooth(t)
    lift = SWING_LIFT * math.sin(math.pi * t)
    hip, knee = leg_ik(fwd, depth - lift)
    pitch = 0.35 * math.sin(math.pi * t) * (1.0 - t)
    return hip, knee, pitch - (hip + knee)


def stride_front(p):
    """Вынос стопы вперёд — константа цикла: не шире, чем нога достаёт в
    контакте, где таз ниже всего. Пересчёт по фазе ломал бы линейность."""
    reach = THIGH + SHIN - 2e-3
    deepest = THIGH + SHIN - CROUCH - p["bob"]
    limit = math.sqrt(max(0.0, reach * reach - deepest * deepest)) * 0.98
    return min((THIGH + SHIN) * math.sin(p["stride"]), limit)


def stride_at(phase, p):
    """Поза всего кота в фазе цикла (0..1): левая нога в контакте на 0."""
    two_pi = 2.0 * math.pi
    front = stride_front(p)
    # Руки навстречу своим ногам; таз ниже всего в контакте, выше — в проносе.
    swing = math.cos(two_pi * phase)
    rise = -CROUCH - p["bob"] * math.cos(2.0 * two_pi * phase)
    lh, lk, la = leg_at(phase % 1.0, front, rise)
    rh, rk, ra = leg_at((phase + 0.5) % 1.0, front, rise)
    lean = p["lean"] * (1.0 + 0.15 * (1.0 - math.cos(2.0 * two_pi * phase)) / 2.0)
    pose = merge(
        spine(lean, twist=-0.09 * swing, rise=rise),
        leg("Left", lh, lk, la),
        leg("Right", rh, rk, ra),
        arm("Left", p["arms"] * swing, -0.30 - 0.10 * abs(swing)),
        arm("Right", -p["arms"] * swing, -0.30 - 0.10 * abs(swing)),
        tail(math.sin(two_pi * phase), 0.12 * (1.0 - math.cos(2.0 * two_pi * phase)), p["tail"]),
    )
    if p.get("hold_right"):
        # Правая лапа держит раструб: махать ей нельзя, иначе пропс летает.
        pose.update(arm("Right", -0.42, -0.75))
    return pose


def gait(p):
    """Цикл шага ключами каждые `every` кадров. Последний кадр = первый."""
    frames = p["step"] * 4
    every = p["every"]
    return [(1 + f, stride_at(f / frames, p)) for f in range(0, frames + 1, every)]


# Шаг шире, чем «естественный» для этих ног: скорость ног в клипе должна
# быть близка к скорости земли (клетка за WALK_MS_PER_CELL), остаток
# добирает рендер через timeScale по foot_speed из extras клипа. Чем ближе
# они изначально, тем меньше рендеру крутить темп — и тем меньше кот семенит.
# Цикл 1.2 с — ~100 шагов в минуту: тяжёлый кот, а не котёнок. Быстрее
# 0.8 с он семенил при том же размахе.
WALK = {"stride": 0.70, "arms": 0.40, "lean": 0.12, "bob": 0.026, "tail": 1.0, "step": 9, "every": 1}
# Тащит кот с той же скоростью земли, что и идёт (симуляция их не
# различает), поэтому цикл той же длины: иначе рендер удваивал бы темп.
HAUL = {"stride": 0.60, "arms": 0.18, "lean": 0.26, "bob": 0.032, "tail": 0.35,
        "step": 9, "every": 1, "hold_right": True}


# --- работа и разгрузка ----------------------------------------------------

def standing(rise, fwd_l=0.0, fwd_r=0.0):
    """Обе ноги на земле при заданном подъёме таза — через IK, как в шаге.

    Стоячие позы раньше задавались углами «на глаз»: таз приседал, колени
    гнулись примерно, и ботинки уходили под асфальт. Здесь стопа стоит на
    земле по построению, а подошва плоская: голеностоп гасит наклон ноги.
    """
    out = {}
    for side, fwd in (("Left", fwd_l), ("Right", fwd_r)):
        hip, knee = leg_ik(fwd, THIGH + SHIN + rise)
        out.update(leg(side, hip, knee, -(hip + knee)))
    return out


def vacuum(sweep, dip):
    """Взмах пылесосом. Ведётся рука: раструб сидит в сокете ладони.

    Медленно и широко: частая мелкая дрожь читается не работой, а тиком.
    """
    return merge(
        spine(0.30, twist=sweep * 0.20, rise=-CROUCH - 0.02 - dip),
        {
            # Взмах — вокруг вертикали: рука уже вынесена вперёд, и поворот
            # вокруг Y (оси «вперёд») её не разводит в стороны, а закручивает.
            RIG + "RightArm": [(X, -0.55), (Z, sweep * 0.60)],
            RIG + "RightForeArm": [(X, -0.50)],
            RIG + "LeftArm": [(X, -0.30), (Z, -0.14)],
            RIG + "LeftForeArm": [(X, -0.55)],
        },
        # Стойка шире шага: левая нога чуть впереди, правая — под раструбом.
        standing(-CROUCH - 0.02 - dip, fwd_l=0.06, fwd_r=-0.04),
        tail(-sweep, -0.2, 0.8),
    )


def WORK():
    return [
        (1, vacuum(-1.0, 0.0)),
        (13, vacuum(0.0, 0.012)),
        (25, vacuum(1.0, 0.0)),
        (37, vacuum(0.0, 0.012)),
        (49, vacuum(-1.0, 0.0)),
    ]


def dumping(t):
    """Разгрузка: присесть, поднять раструб над контейнером, наклонить, вернуть."""
    return merge(
        spine(0.22 - t * 0.42, rise=-CROUCH - 0.05 + t * 0.05),
        {
            RIG + "RightArm": [(X, -0.35 - t * 1.05)],
            RIG + "RightForeArm": [(X, -0.55 - t * 0.35)],
            RIG + "LeftArm": [(X, -0.20 - t * 0.35)],
            RIG + "LeftForeArm": [(X, -0.40)],
        },
        standing(-CROUCH - 0.05 + t * 0.05, fwd_l=0.05, fwd_r=0.05),
        tail(0.0, -0.6 + t * 1.2, 1.0),
    )


def DUMP():
    return [(1, dumping(0.0)), (16, dumping(0.75)), (31, dumping(1.0)),
            (46, dumping(0.45)), (61, dumping(0.0))]


# --- покой -----------------------------------------------------------------

def breathing(t, side, ear):
    """Покой: дыхание, перенос веса и живой хвост. Кот не статуя и не дрожит."""
    return merge(
        spine(0.03 + t * 0.035, twist=side * 0.03, rise=-CROUCH + t * 0.010),
        arm("Left", 0.0, -0.16),
        arm("Right", 0.0, -0.16),
        standing(-CROUCH + t * 0.010),
        tail(side, 0.15 + t * 0.2, 1.0),
        {"ear_l": [(X, ear)], "ear_r": [(X, ear * 0.6)]},
    )


def IDLE():
    """Дыхание и хвост — в противофазе. Если на стыке цикла все каналы разом
    в экстремуме, кот замирает целиком, и стык виден как пауза; поэтому
    там, где дыхание на выдохе, хвост проходит через середину и движется."""
    return [(1, breathing(0.0, 0.0, 0.0)), (25, breathing(1.0, 1.0, 0.0)),
            (49, breathing(0.0, 0.0, -0.22)), (61, breathing(0.4, -0.6, 0.0)),
            (73, breathing(1.0, -1.0, 0.0)), (97, breathing(0.0, 0.0, 0.0))]


CLIPS = [("idle", IDLE), ("walk", lambda: gait(WALK)), ("haul", lambda: gait(HAUL)),
         ("work", WORK), ("dump", DUMP)]


def fcurves_of(act):
    """Кривые экшена. С Blender 4.4 они лежат в слоях и мешках каналов слота,
    а не прямо в экшене, и старого пути `act.fcurves` больше нет."""
    if hasattr(act, "fcurves"):
        return list(act.fcurves)
    out = []
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                out.extend(bag.fcurves)
    return out


def cyclic_handles(fc):
    """Хэндлы Безье с учётом зацикливания.

    У первого и последнего ключа автохэндлы плоские: соседа с одной стороны
    нет. Скорость на концах клипа падает до нуля, и на стыке цикла кот
    притормаживает — при ×0.1 это видно. Модификатор Cycles в фоне на
    расчёт хэндлов не влияет, поэтому соседи подставляются руками: ключи
    из соседних периодов, хэндлы считаются по ним, фиксируются как FREE, а
    подставные ключи убираются.
    """
    pts = fc.keyframe_points
    if len(pts) < 3:
        return
    for kp in pts:
        kp.interpolation = "BEZIER"
        kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
    # Координаты — в числа до вставки: ссылки на точки после insert
    # указывают в сдвинутые слоты массива.
    period = pts[-1].co.x - pts[0].co.x
    x_prev, y_prev = pts[-2].co.x - period, pts[-2].co.y
    x_next, y_next = pts[1].co.x + period, pts[1].co.y
    pts.insert(x_prev, y_prev)
    pts.insert(x_next, y_next)
    fc.update()
    # После insert точки пересортированы: концы цикла теперь вторая и
    # предпоследняя.
    for kp in (pts[1], pts[-2]):
        kp.handle_left_type = kp.handle_right_type = "FREE"
    pts.remove(pts[-1])
    pts.remove(pts[0])
    fc.update()


def bake(rig, name, keys):
    """Экшен из ключевых поз. Ключуются только затронутые кости.

    Иначе в GLB уезжает трек на каждую кость каждого клипа, и кит толстеет
    вдвое ни на что.
    """
    touched = sorted({b for _, pose in keys for b in pose if not b.startswith("@")})
    act = bpy.data.actions.new(name)
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots.new(id_type="OBJECT", name=rig.name)

    hips = rig.pose.bones[RIG + "Hips"]
    # Знак кватерниона на предыдущем ключе той же кости. `q` и `-q` — один
    # поворот, но Blender интерполирует покомпонентно: если у соседних
    # ключей знак разошёлся, путь идёт через ноль, и кость делает полный
    # оборот вместо короткого пути. Ноги на 360° — ровно это.
    last = {}
    for frame, pose in keys:
        for pb in rig.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
            pb.location = Vector((0.0, 0.0, 0.0))
        for name_b in touched:
            pb = rig.pose.bones[name_b]
            q = to_bone(pb, ARM_ADDUCT.get(name_b, []) + pose.get(name_b, []))
            if name_b in last and q.dot(last[name_b]) < 0.0:
                q.negate()
            last[name_b] = q.copy()
            pb.rotation_quaternion = q
        # Подъём таза — в базисе его кости: она смотрит вверх, но полагаться
        # на это на глаз не стоит.
        rise = pose.get("@rise", 0.0)
        m = hips.bone.matrix_local.to_quaternion()
        hips.location = m.inverted() @ Vector((0.0, 0.0, rise))

        # Ключи со нуля: клип, начатый с кадра 1, в glTF стартует с 0.03 с, и
        # при зацикливании этот огрызок читается запинкой.
        for name_b in touched:
            rig.pose.bones[name_b].keyframe_insert("rotation_quaternion", frame=frame - 1)
        hips.keyframe_insert("location", frame=frame - 1)

    for fc in fcurves_of(act):
        cyclic_handles(fc)
    act.use_cyclic = True
    act.use_fake_user = True
    return act, keys[-1][0]


def foot_speed(rig, act, last):
    """Скорость опорной стопы в клипе, ед/с.

    Уезжает в extras клипа: рендер делит на неё скорость земли и получает
    timeScale, при котором ноги не скользят. Считается по запечённому клипу,
    а не по параметрам позы, — любая правка шага учитывается.

    Мерить надо лодыжку и только на опоре: носок в махе описывает дугу шире,
    чем лодыжка проходит по земле, и размах за цикл завышал скорость на
    треть — тело обгоняло стопы.
    """
    ad = rig.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots[0]
    foot = rig.pose.bones[RIG + "LeftFoot"]
    ys = []
    for f in range(0, last):
        bpy.context.scene.frame_set(f)
        ys.append((rig.matrix_world @ foot.head).y)
    # Левая нога в контакте на кадре 0, опора — первая половина цикла.
    stance = (last - 1) // 2
    travel = sum(abs(ys[i + 1] - ys[i]) for i in range(stance))
    return travel / (stance / FPS)


def build_clips(rig):
    """Все клипы — экшенами и полосами NLA: экспортёр берёт их как отдельные."""
    ad = rig.animation_data or rig.animation_data_create()
    for name, make in CLIPS:
        act, last = bake(rig, name, make())
        if name in ("walk", "haul"):
            act["foot_speed"] = foot_speed(rig, act, last)
            print(f"  {name}: ноги {act['foot_speed']:.2f} ед/с")
        track = ad.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, act)
        strip.action_frame_start, strip.action_frame_end = 0, last - 1
        track.mute = True
        print(f"  клип {name}: {last - 1} кадров, {(last - 1) / FPS:.2f} с, "
              f"{len(fcurves_of(act))} кривых")
    ad.action = None
    # Сброс позы: последний ключ остаётся на костях и после снятия экшена,
    # а сокеты дальше ставятся от rest-позы.
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        pb.location = Vector((0.0, 0.0, 0.0))
    bpy.context.view_layer.update()


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.render.fps = FPS

    m_gear = flat_material("gear", GEAR)

    rig = build_armature()
    body, head = build_cat(rig)

    # Пылесос: ранец на спине и раструб в правой лапе. Рабочий цикл строится
    # от предмета, поэтому предмет существует как отдельный объект в сокете.
    held = import_prop("held_vacuum", "held_vacuum.glb", length=0.62)
    # Бак с лямками и клёпкой на 800 треугольниках становится угловатым.
    gear = import_prop("gear_vacuum", "gear_vacuum.glb", length=0.40, align=False, origin="bottom", tris=1500)
    build_clips(rig)

    socket(held, rig, "socket_hand_r", (HAND_R[0], HAND_R[1] - 0.06, HAND_R[2] + 0.02), (0.35, 0, 0))
    # Дно бака — у ремня, ближняя грань — на поверхности спины. Спина
    # наклонная (у ремня ~0.07, у плеч ~0.12), поэтому бак ещё и откинут
    # верхом назад на те же ~7°, иначе внизу щель.
    socket(gear, rig, "socket_back", (0, 0.07, L["hips"] - 0.02), (-0.12, 0, 0))

    tris = 0
    for obj in (body, head, held, gear):
        tris += sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"  {obj.name}: {sum(len(p.vertices) - 2 for p in obj.data.polygons)} тр.")
    print(f"  кот целиком: {tris} тр.")

    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        # Атлас — JPEG: альфы нет, 1024² в PNG весил бы мегабайт с лишним.
        export_image_format="JPEG",
        export_jpeg_quality=85,
        export_yup=True,
        export_apply=True,
        export_skins=True,
        export_vertex_color="ACTIVE",
        export_animations=True,
        export_extras=True,
        export_animation_mode="ACTIONS",
        export_frame_range=False,
        # Сэмплировать, а не отдавать кривые Безье: с CUBICSPLINE экспортёр
        # переподписывает кватернионы между ключами (q и -q), а three в
        # сплайновом интерполянте кратчайший путь не ищет — нога делала
        # оборот на 360°. Линейный slerp в three знак учитывает.
        export_force_sampling=True,
        export_optimize_animation_size=True,
        # Сэмплирование пишет трек на каждую кость, включая голову и сокеты;
        # неанимированные выбрасываются — голова остаётся за рантаймом.
        export_optimize_animation_keep_anim_armature=False,
        export_draco_mesh_compression_enable=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"эталон: {BLEND}")
    print(f"кит:    {GLB}  {os.path.getsize(GLB) / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
