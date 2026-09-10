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
from mathutils import Euler, Matrix, Vector

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


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"

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
        export_draco_mesh_compression_enable=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"эталон: {BLEND}")
    print(f"кит:    {GLB}  {os.path.getsize(GLB) / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
