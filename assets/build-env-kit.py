"""
Кит окружения: `env-kit.glb` — модули двора и обломки мусора.

    blender --background --python assets/build-env-kit.py

Две породы мешей.

Обломки — то, из чего рендер собирает кучи: они тают по одному обломку,
поэтому нужны не кучи, а куски. Каждый обломок — text→3D через AssetHub
(Tripo 3.1), исходники в `assets/gen/tripo/debris/`. Здесь они нормируются,
ужимаются под бюджет и получают имена контракта.

Модули двора — пол, стены, контейнер, лампы, трубы, вентиляция — строятся
здесь из примитивов с фасками. Модульное и повторяющееся моделится руками,
а не генерится: стыки по сетке у генерации у каждого куска свои, а фаска на
ребре при плоской заливке — единственное, чем читается форма. Текстур нет
ни одной, все материалы плоские: именно текстуры раздувают веб-сборки.

Модули кладутся на сетку симуляции: клетка — метр, начало координат модуля —
середина его клетки на уровне пола; у настенных пропсов — точка касания
стены. Имена мешей — контракт с рендером и с `tests/env-kit.test.ts`.

Оси: X вправо, −Y вперёд, Z вверх; экспорт — glTF +Y вверх.
"""

import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN_DIR = os.path.join(ROOT, "assets", "gen", "tripo", "debris")
GLB = os.path.join(ROOT, "public", "models", "env-kit.glb")

# Имя в ките → файл. Имена — контракт с рендером, по ним он берёт геометрию.
DEBRIS = {
    "debris_bag": "bag.glb",
    "debris_barrel": "barrel.glb",
    "debris_crate": "crate.glb",
}
# Обломок в кадре — с ладонь кота; треугольников и текселов ему нужно мало.
DEBRIS_SIZE = 0.34
DEBRIS_TRIS = 300
DEBRIS_TEXTURE = 256


def import_debris(name, filename):
    """Обломок: наибольший размер — DEBRIS_SIZE, дно на z=0, центр в нуле."""
    path = os.path.join(GEN_DIR, filename)
    if not os.path.exists(path):
        sys.exit(f"нет {path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
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
    lo = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
    k = DEBRIS_SIZE / max(hi - lo)
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for v in me.vertices:
        v.co = (v.co - centre) * k
    for poly in me.polygons:
        poly.use_smooth = True

    now = sum(len(p.vertices) - 2 for p in me.polygons)
    if now > DEBRIS_TRIS:
        d = obj.modifiers.new("dec", "DECIMATE")
        d.ratio = DEBRIS_TRIS / now
        bpy.ops.object.modifier_apply(modifier="dec")

    for mat in me.materials:
        mat.name = name
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image is not None:
                img = node.image
                img.name = name + "_albedo"
                if img.size[0] > DEBRIS_TEXTURE:
                    img.scale(DEBRIS_TEXTURE, DEBRIS_TEXTURE)
                img.pack()
    obj.select_set(False)
    return obj


# ---------------------------------------------------------------- модули

# Палитра двора — та же, что `src/render/palette.ts`: грязный индустриальный
# нуар, холодные серо-синие поверхности, тёплый янтарь только у ламп.
# Красного нет: он зарезервирован под угрозу.
COLOURS = {
    "concrete": (0.030, 0.037, 0.048, 1.0),
    "concrete_dark": (0.020, 0.024, 0.031, 1.0),
    "asphalt_patch": (0.014, 0.016, 0.020, 1.0),
    "wall": (0.044, 0.054, 0.070, 1.0),
    "steel": (0.060, 0.072, 0.090, 1.0),
    "steel_dark": (0.024, 0.030, 0.038, 1.0),
    "dumpster": (0.036, 0.075, 0.100, 1.0),
    "rubber": (0.018, 0.017, 0.016, 1.0),
    "lamp_glow": (1.0, 0.62, 0.22, 1.0),
}
MATERIALS = {}


def material(key):
    if key not in MATERIALS:
        mat = bpy.data.materials.new(key)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        colour = COLOURS[key]
        bsdf.inputs["Base Color"].default_value = colour
        bsdf.inputs["Roughness"].default_value = 0.9
        bsdf.inputs["Metallic"].default_value = 0.0
        if key == "lamp_glow":
            # Светящаяся пластина: у рендера теней нет, лампа читается
            # только своей яркостью, а не пятном на полу.
            bsdf.inputs["Emission Color"].default_value = colour
            bsdf.inputs["Emission Strength"].default_value = 3.0
        mat.diffuse_color = colour
        MATERIALS[key] = mat
    return MATERIALS[key]


def box(name, size, at=(0, 0, 0), bevel=0.0, colour="concrete", bottom=True):
    """Коробка. `at` — середина дна (bottom) либо центр; фаска в один сегмент.

    Один сегмент, плоская заливка: фаска — не скругление, а грань, на
    которую падает свой свет. Именно она показывает ребро при заливке без
    текстур, и именно её нет у BoxGeometry в коде рендера.
    """
    sx, sy, sz = size
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    obj.scale = (sx, sy, sz)
    obj.location = (at[0], at[1], at[2] + (sz / 2 if bottom else 0))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bevel > 0:
        b = obj.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 1
        b.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier="bevel")
    obj.data.materials.append(material(colour))
    return obj


def cylinder(name, radius, depth, at=(0, 0, 0), axis="Z", verts=10, colour="steel", bottom=True):
    """Цилиндр. `at` — середина основания (bottom) вдоль оси либо центр."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    off = depth / 2 if bottom else 0
    if axis == "Z":
        obj.location = (at[0], at[1], at[2] + off)
    elif axis == "X":
        obj.rotation_euler = (0, 1.5707963, 0)
        obj.location = (at[0] + off, at[1], at[2])
    else:
        obj.rotation_euler = (1.5707963, 0, 0)
        obj.location = (at[0], at[1] + off, at[2])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.materials.append(material(colour))
    return obj


def join(name, parts):
    """Один меш из частей. Материалы частей остаются своими слотами."""
    for o in bpy.data.objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    for poly in obj.data.polygons:
        poly.use_smooth = False
    obj.select_set(False)
    return obj


FLOOR_H = 0.05


def floor_slab():
    """Плитка бетона в клетку. Фаска по краю — шов между плитами."""
    return box("floor_slab", (1.0, 1.0, FLOOR_H), bevel=0.025)


def floor_patch():
    """Плитка с латкой асфальта: пол не ровный — двор давно чинили."""
    slab = box("a", (1.0, 1.0, FLOOR_H), bevel=0.025)
    patch = box("b", (0.46, 0.34, 0.012), at=(0.12, -0.14, FLOOR_H), bevel=0.006, colour="asphalt_patch")
    return join("floor_patch", [slab, patch])


def floor_grate():
    """Плитка с водостоком: утопленная тёмная рамка и прутья решётки."""
    slab = box("a", (1.0, 1.0, FLOOR_H), bevel=0.025)
    well = box("b", (0.56, 0.56, 0.02), at=(0, 0, FLOOR_H - 0.014), colour="concrete_dark")
    parts = [slab, well]
    for i in range(5):
        y = -0.2 + i * 0.1
        parts.append(box("c", (0.5, 0.03, 0.018), at=(0, y, FLOOR_H - 0.012), colour="steel_dark"))
    return join("floor_grate", parts)


WALL_H = 1.3


def wall_block():
    """Стенной блок в клетку. Фаска — стык панелей, из клеток растёт блок."""
    return box("wall_block", (1.0, 1.0, WALL_H), bevel=0.04, colour="wall")


def edge_wall():
    """Панель ограды двора в метр: бетон в рост с карнизом. Стоит на улице
    за плитой по дальним сторонам — на пути камеры её нет никогда."""
    panel = box("a", (1.0, 0.3, 2.2), bevel=0.04, colour="wall")
    cap = box("b", (1.0, 0.38, 0.1), at=(0, 0, 2.2), bevel=0.02, colour="concrete_dark")
    return join("edge_wall", [panel, cap])


def edge_curb():
    """Парапет в метр по ближним сторонам: низкий, чтобы не загораживать."""
    return box("edge_curb", (1.0, 0.3, 0.35), bevel=0.03)


def prop_dumpster():
    """Контейнер: корпус, крышка, ручки, колёса. Занимает свою клетку с запасом."""
    body = box("a", (1.4, 1.1, 0.86), at=(0, 0, 0.12), bevel=0.04, colour="dumpster")
    lid = box("b", (1.46, 1.16, 0.1), at=(0, 0, 0.98), bevel=0.03, colour="dumpster")
    parts = [body, lid]
    for sx in (-1, 1):
        parts.append(box("c", (0.08, 0.5, 0.06), at=(sx * 0.74, 0, 0.6), colour="steel"))
        for sy in (-1, 1):
            parts.append(cylinder("d", 0.08, 0.06, at=(sx * 0.55, sy * 0.4, 0.08), axis="Y", verts=8, colour="rubber", bottom=False))
    return join("prop_dumpster", parts)


def prop_lamp_wall():
    """Настенный светильник. Начало — точка на стене, светит вдоль +Y от неё.

    Кронштейн от стены, корпус, светящаяся пластина снизу. Сам свет — точечный
    источник в рендере, пластина только показывает, откуда он.
    """
    arm = box("a", (0.06, 0.4, 0.06), at=(0, 0.2, -0.03), colour="steel_dark")
    head = box("b", (0.34, 0.26, 0.12), at=(0, 0.42, -0.06), bevel=0.02, colour="steel_dark")
    glow = box("c", (0.26, 0.18, 0.02), at=(0, 0.42, -0.13), colour="lamp_glow")
    return join("prop_lamp_wall", [arm, head, glow])


def prop_vent():
    """Вентиляционная труба на крыше: стакан и шляпка."""
    stack = cylinder("a", 0.16, 0.6, verts=10, colour="steel")
    cap = cylinder("b", 0.22, 0.08, at=(0, 0, 0.66), verts=10, colour="steel_dark")
    neck = cylinder("c", 0.06, 0.08, at=(0, 0, 0.6), verts=6, colour="steel_dark")
    return join("prop_vent", [stack, cap, neck])


def prop_ac():
    """Блок кондиционера на крыше: корпус с фаской и решётка спереди (−Y)."""
    body = box("a", (0.8, 0.6, 0.5), bevel=0.03, colour="steel")
    parts = [body]
    for i in range(4):
        parts.append(box("b", (0.6, 0.02, 0.05), at=(0, -0.31, 0.1 + i * 0.09), colour="steel_dark"))
    return join("prop_ac", parts)


def prop_pipe():
    """Труба в метр вдоль +X от начала; стык — `prop_pipe_joint`."""
    return cylinder("prop_pipe", 0.07, 1.0, axis="X", verts=8, colour="steel_dark")


def prop_pipe_joint():
    """Колено: шар в узле, куда сходятся трубы под любым углом."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.095)
    obj = bpy.context.active_object
    obj.name = obj.data.name = "prop_pipe_joint"
    for poly in obj.data.polygons:
        poly.use_smooth = False
    obj.data.materials.append(material("steel_dark"))
    return obj


MODULES = [
    floor_slab, floor_patch, floor_grate, wall_block, edge_wall, edge_curb,
    prop_dumpster, prop_lamp_wall, prop_vent, prop_ac, prop_pipe, prop_pipe_joint,
]


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"

    total = 0
    for build in MODULES:
        obj = build()
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        total += tris
        print(f"  {obj.name}: {tris} тр.")
    for name, filename in DEBRIS.items():
        obj = import_debris(name, filename)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        total += tris
        print(f"  {name}: {tris} тр.")
    print(f"  кит окружения: {total} тр.")

    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_image_format="JPEG",
        export_jpeg_quality=80,
    )
    print(f"кит:    {GLB}  {os.path.getsize(GLB) / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
