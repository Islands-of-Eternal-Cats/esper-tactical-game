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

# Палитра — та же, что в src/render/palette.ts. Текстур нет ни одной.
RUSTY = (0.76, 0.44, 0.23, 1.0)
RUSTY_HEAD = (0.85, 0.55, 0.31, 1.0)
GEAR = (0.21, 0.31, 0.36, 1.0)

RIG = "mixamorig:"

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
    (RIG + "Hips", (0, 0, 0.40), (0, 0, 0.54), None, False),
    (RIG + "Spine", (0, 0, 0.54), (0, 0, 0.68), RIG + "Hips", True),
    (RIG + "Spine1", (0, 0, 0.68), (0, 0, 0.82), RIG + "Spine", True),
    (RIG + "Neck", (0, 0, 0.82), (0, 0, 0.88), RIG + "Spine1", True),
    (RIG + "Head", (0, 0, 0.88), (0, 0, 1.06), RIG + "Neck", True),
]
BONES += mirrored("Shoulder", (0.06, 0, 0.78), (0.26, 0, 0.78), "Spine1", False)
BONES += mirrored("Arm", (0.26, 0, 0.78), (0.27, 0, 0.60), "{s}Shoulder", True)
BONES += mirrored("ForeArm", (0.27, 0, 0.60), (0.28, 0, 0.45), "{s}Arm", True)
BONES += mirrored("Hand", (0.28, 0, 0.45), (0.28, 0, 0.37), "{s}ForeArm", True)
BONES += mirrored("UpLeg", (0.13, 0, 0.40), (0.13, 0, 0.23), "Hips", False)
BONES += mirrored("Leg", (0.13, 0, 0.23), (0.13, 0, 0.07), "{s}UpLeg", True)
BONES += mirrored("Foot", (0.13, 0, 0.07), (0.13, -0.13, 0.03), "{s}Leg", True)

# Вне humanoid: хвост и уши. Пружина или синус с отставанием — на рантайме.
BONES += [
    ("tail_1", (0, 0.15, 0.45), (0, 0.34, 0.50), RIG + "Hips", False),
    ("tail_2", (0, 0.34, 0.50), (0, 0.44, 0.64), "tail_1", True),
    ("tail_3", (0, 0.44, 0.64), (0, 0.42, 0.80), "tail_2", True),
    ("ear_l", (0.10, 0.02, 1.06), (0.12, 0.03, 1.20), RIG + "Head", False),
    ("ear_r", (-0.10, 0.02, 1.06), (-0.12, 0.03, 1.20), RIG + "Head", False),
    # Сокеты: пропс крепится к кости и риггинга не требует вообще.
    ("socket_hand_r", (-0.28, -0.08, 0.40), (-0.28, -0.20, 0.40), RIG + "RightHand", False),
    ("socket_back", (0, 0.18, 0.74), (0, 0.30, 0.74), RIG + "Spine1", False),
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
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


# --------------------------------------------------------------------------
# Геометрия. Коробки и пирамидки: на дистанции камеры этого достаточно,
# а топология остаётся чистой — к ней крепится скелет.
# --------------------------------------------------------------------------

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


def wedge(base, apex, half, bone):
    """Ухо: четырёхгранная пирамидка. Дешевле конуса и читается силуэтом."""
    bx, by, bz = base
    verts = [
        (bx - half, by - half, bz), (bx + half, by - half, bz),
        (bx + half, by + half, bz), (bx - half, by + half, bz), apex,
    ]
    faces = [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return verts, faces, bone


def mesh_from(name, parts, material):
    """Сборка меша из кусков: каждый кусок жёстко привязан к одной кости."""
    verts, faces, groups = [], [], {}
    for pv, pf, bone in parts:
        off = len(verts)
        groups.setdefault(bone, []).extend(range(off, off + len(pv)))
        verts.extend(pv)
        faces.extend(tuple(i + off for i in f) for f in pf)

    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    # Плоская заливка: форма читается затенением по нормали, текстур нет.
    me.materials.append(material)
    for poly in me.polygons:
        poly.use_smooth = False

    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    for bone, idx in groups.items():
        obj.vertex_groups.new(name=bone).add(idx, 1.0, "REPLACE")
    return obj


def flat_material(name, colour):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = colour
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = colour  # тот же цвет во вьюпорте и в превью
    return mat


def build_body(mat):
    """Массивность — одеждой, а не телом: архетип корпуса здесь ровно один.

    Руки и ноги стоят снаружи корпуса с зазором: слипшийся силуэт на
    изометрии читается сплошным блоком, и никакая анимация это не спасает.
    """
    p = [
        box((0, 0, 0.47), (0.38, 0.28, 0.16), RIG + "Hips"),
        box((0, -0.01, 0.61), (0.40, 0.29, 0.14), RIG + "Spine"),
        box((0, -0.02, 0.75), (0.40, 0.30, 0.16), RIG + "Spine1"),
    ]
    for side, sx in (("Left", 1.0), ("Right", -1.0)):
        p += [
            box((sx * 0.265, 0, 0.70), (0.11, 0.13, 0.19), RIG + side + "Arm"),
            box((sx * 0.275, 0, 0.525), (0.09, 0.11, 0.16), RIG + side + "ForeArm"),
            box((sx * 0.28, -0.01, 0.40), (0.10, 0.12, 0.11), RIG + side + "Hand"),
            box((sx * 0.13, 0, 0.315), (0.15, 0.17, 0.18), RIG + side + "UpLeg"),
            box((sx * 0.13, 0, 0.15), (0.13, 0.15, 0.17), RIG + side + "Leg"),
            box((sx * 0.13, -0.06, 0.035), (0.14, 0.26, 0.07), RIG + side + "Foot"),
        ]
    p += [
        box((0, 0.245, 0.475), (0.09, 0.21, 0.10), "tail_1"),
        box((0, 0.39, 0.57), (0.07, 0.13, 0.17), "tail_2"),
        box((0, 0.43, 0.72), (0.05, 0.08, 0.16), "tail_3"),
    ]
    return mesh_from("body_stocky", p, mat)


def build_head(mat):
    """Идентичность несёт голова: порода, уши, морда. Уникальна на кота."""
    p = [
        box((0, 0, 0.99), (0.34, 0.32, 0.30), RIG + "Head"),
        # Морда: без неё поворот головы не виден вообще.
        box((0, -0.19, 0.95), (0.18, 0.10, 0.14), RIG + "Head"),
        wedge((0.10, 0.02, 1.08), (0.12, 0.03, 1.22), 0.06, "ear_l"),
        wedge((-0.10, 0.02, 1.08), (-0.12, 0.03, 1.22), 0.06, "ear_r"),
    ]
    return mesh_from("head_rusty", p, mat)


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

def contact(front, p):
    """Контакт: передняя нога встала на пятку, задняя доталкивает."""
    back = "Right" if front == "Left" else "Left"
    sign = 1.0 if front == "Left" else -1.0
    return merge(
        spine(p["lean"], twist=-0.09 * sign, rise=-p["bob"]),
        leg(front, -p["stride"], 0.10, 0.12),
        leg(back, p["stride"] * 0.75, p["stride"] * 1.05, -0.22),
        arm(front, p["arms"], -0.30),
        arm(back, -p["arms"], -0.45),
        tail(sign, 0.0, p["tail"]),
    )


def passing(front, p):
    """Пронос: опорная нога под тазом, свободная идёт вперёд с высоким коленом."""
    back = "Right" if front == "Left" else "Left"
    sign = 1.0 if front == "Left" else -1.0
    return merge(
        spine(p["lean"] * 1.15, twist=0.0, rise=p["bob"]),
        leg(front, -p["stride"] * 0.12, 0.08, -0.06),
        leg(back, -p["stride"] * 0.45, p["stride"] * 1.35, -0.10),
        arm(front, p["arms"] * 0.35, -0.34),
        arm(back, -p["arms"] * 0.35, -0.40),
        tail(sign * 0.3, 0.25, p["tail"]),
    )


def gait(p):
    """Цикл шага: контакт — пронос — зеркало — зеркало. Последний кадр = первый."""
    step = p["step"]
    keys = [
        (1, contact("Left", p)),
        (1 + step, passing("Left", p)),
        (1 + step * 2, contact("Right", p)),
        (1 + step * 3, passing("Right", p)),
        (1 + step * 4, contact("Left", p)),
    ]
    if p.get("hold_right"):
        # Правая лапа держит раструб: махать ей нельзя, иначе пропс летает.
        for _, pose in keys:
            pose.update(arm("Right", -0.42, -0.75))
    return keys


WALK = {"stride": 0.52, "arms": 0.34, "lean": 0.10, "bob": 0.022, "tail": 1.0, "step": 6}
HAUL = {"stride": 0.38, "arms": 0.16, "lean": 0.26, "bob": 0.030, "tail": 0.35,
        "step": 8, "hold_right": True}


# --- работа и разгрузка ----------------------------------------------------

def vacuum(sweep, dip):
    """Взмах пылесосом. Ведётся рука: раструб сидит в сокете ладони.

    Медленно и широко: частая мелкая дрожь читается не работой, а тиком.
    """
    return merge(
        spine(0.30, twist=sweep * 0.20, rise=-0.02 - dip),
        {
            # Взмах — вокруг вертикали: рука уже вынесена вперёд, и поворот
            # вокруг Y (оси «вперёд») её не разводит в стороны, а закручивает.
            RIG + "RightArm": [(X, -0.80), (Z, sweep * 0.60)],
            RIG + "RightForeArm": [(X, -0.50)],
            RIG + "LeftArm": [(X, -0.30), (Z, -0.14)],
            RIG + "LeftForeArm": [(X, -0.55)],
        },
        leg("Left", -0.16, 0.26, 0.06),
        leg("Right", -0.16, 0.26, 0.06),
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
        spine(0.22 - t * 0.42, rise=-0.05 + t * 0.05),
        {
            RIG + "RightArm": [(X, -0.35 - t * 1.05)],
            RIG + "RightForeArm": [(X, -0.55 - t * 0.35)],
            RIG + "LeftArm": [(X, -0.20 - t * 0.35)],
            RIG + "LeftForeArm": [(X, -0.40)],
        },
        leg("Left", -0.30 + t * 0.22, 0.40 - t * 0.30, 0.10),
        leg("Right", -0.30 + t * 0.22, 0.40 - t * 0.30, 0.10),
        tail(0.0, -0.6 + t * 1.2, 1.0),
    )


def DUMP():
    return [(1, dumping(0.0)), (16, dumping(0.75)), (31, dumping(1.0)),
            (46, dumping(0.45)), (61, dumping(0.0))]


# --- покой -----------------------------------------------------------------

def breathing(t, side, ear):
    """Покой: дыхание, перенос веса и живой хвост. Кот не статуя и не дрожит."""
    return merge(
        spine(0.03 + t * 0.035, twist=side * 0.03, rise=t * 0.010),
        arm("Left", 0.0, -0.16),
        arm("Right", 0.0, -0.16),
        leg("Left", -0.05, 0.09, 0.02),
        leg("Right", -0.05, 0.09, 0.02),
        tail(side, 0.15 + t * 0.2, 1.0),
        {"ear_l": [(X, ear)], "ear_r": [(X, ear * 0.6)]},
    )


def IDLE():
    return [(1, breathing(0.0, 1.0, 0.0)), (25, breathing(1.0, 0.4, 0.0)),
            (49, breathing(0.0, -1.0, -0.22)), (61, breathing(0.4, -0.7, 0.0)),
            (73, breathing(1.0, -0.2, 0.0)), (97, breathing(0.0, 1.0, 0.0))]


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
    for frame, pose in keys:
        for pb in rig.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
            pb.location = Vector((0.0, 0.0, 0.0))
        for name_b in touched:
            pb = rig.pose.bones[name_b]
            pb.rotation_quaternion = to_bone(pb, pose.get(name_b, []))
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
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
    act.use_cyclic = True
    act.use_fake_user = True
    return act, keys[-1][0]


def build_clips(rig):
    """Все клипы — экшенами и полосами NLA: экспортёр берёт их как отдельные."""
    ad = rig.animation_data or rig.animation_data_create()
    for name, make in CLIPS:
        act, last = bake(rig, name, make())
        track = ad.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, act)
        strip.action_frame_start, strip.action_frame_end = 0, last - 1
        track.mute = True
        print(f"  клип {name}: {last - 1} кадров, {(last - 1) / FPS:.2f} с, "
              f"{len(fcurves_of(act))} кривых")
    ad.action = None


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.render.fps = FPS

    m_body = flat_material("rusty_body", RUSTY)
    m_head = flat_material("rusty_head", RUSTY_HEAD)
    m_gear = flat_material("gear", GEAR)

    rig = build_armature()
    body = build_body(m_body)
    head = build_head(m_head)

    for obj in (body, head):
        obj.parent = rig
        obj.modifiers.new("Armature", "ARMATURE").object = rig

    # Пылесос: ранец на спине и раструб в правой лапе. Рабочий цикл строится
    # от предмета, поэтому предмет существует как отдельный объект в сокете.
    held = build_prop("held_vacuum", [
        box((0, 0, 0), (0.07, 0.07, 0.10), None),          # хват
        box((0, -0.01, -0.18), (0.07, 0.07, 0.28), None),  # труба
        box((0, -0.05, -0.35), (0.17, 0.17, 0.06), None),  # раструб
    ], m_gear)
    gear = build_prop("gear_vacuum", [
        box((0, 0, 0), (0.24, 0.15, 0.26), None),          # бак
        box((0, 0, 0.15), (0.18, 0.11, 0.05), None),       # крышка
        box((0, -0.03, 0.22), (0.06, 0.06, 0.10), None),   # шланг через плечо
    ], m_gear)
    build_clips(rig)

    socket(held, rig, "socket_hand_r", (-0.28, -0.13, 0.42), (0.35, 0, 0))
    socket(gear, rig, "socket_back", (0, 0.24, 0.66))

    tris = 0
    for obj in (body, head, held, gear):
        tris += sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"  {obj.name}: {sum(len(p.vertices) - 2 for p in obj.data.polygons)} тр.")
    print(f"  кот целиком: {tris} тр.")

    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_frame_range=False,
        export_force_sampling=False,
        export_optimize_animation_size=False,
        export_draco_mesh_compression_enable=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"эталон: {BLEND}")
    print(f"кит:    {GLB}  {os.path.getsize(GLB) / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
