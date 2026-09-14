"""
Кит модульного оружия из Quaternius «Sci-Fi Modular Gun Pack» (CC0):

    blender --background --python assets/build-gun-kit.py [--preview]

Вход — папка `assets/guns/Modular Sci Fi Guns - Nov 2021/Modular Parts/glTF/`
(набор в репозитории не лежит: 62 МБ, качается с quaternius.com).

Выход: `public/models/gun-kit.glb` — только части из PARTS, каждая
отдельным узлом `gun_<имя>` в своей системе координат. У Quaternius начало
координат части — её точка крепления: ствол растёт от 0 по +X, приклад
кончается в 0, магазин вставлен верхом в y = 0, прицел стоит низом на y = 0.
Куда крепить — знают корпуса: у узла корпуса в extras лежат `sockets`
(barrel / stock / grip / magazine / top, у снайперской ещё front), и рендер ставит части по ним.
Гнёзда — в SOCKETS: сняты с собранных образцов набора (`Guns/`) подбором
сдвига, при котором вершины части совпадают с вершинами сборки; чего в
образцах нет (прицел, кое-где магазин и ствол) — по геометрии корпуса:
верх, низ, перед.

Какое оружие из каких частей — в `src/core/weapons.yaml` (`look`), не здесь:
кит — склад, сборка — данные.

`--preview` дополнительно рендерит сборки из PREVIEW в `assets/guns/preview/`
(не в репозитории), чтобы проверить гнёзда глазами, не запуская игру.

Масштаб: набор в метрах «под человека» — автомат 1,9 м длиной. Рендер
масштабирует под кота сам (GUN_SCALE в render/guns.ts); здесь — как есть.
"""

import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "guns", "Modular Sci Fi Guns - Nov 2021", "Modular Parts", "glTF")
GLB = os.path.join(ROOT, "public", "models", "gun-kit.glb")
PREVIEW_DIR = os.path.join(ROOT, "assets", "guns", "preview")

# Части, которые идут в кит. Всё остальное из набора — нет: бюджет.
PARTS = [
    # винтовка
    "Body_AR_1", "Barrel_AR_1", "Stock_AR_1", "Grip_AR_1", "Magazine_AR",
    # автомат
    "Body_SMG_1", "Stock_SMG_1", "Grip_SMG_1", "Magazine_SMG_1", "Barrel_Single",
    # дробовик — из «гранатомётных» частей: коротко и толсто
    "Body_Grenade_2", "Barrel_Grenade_1", "Stock_Grenade_2", "Grip_Grenade_2",
    # снайперская
    "Body_Sniper_1", "Body_Front_Sniper_1", "Barrel_Sniper_1", "Stock_Sniper_1", "Grip_Sniper_1", "Magazine_Sniper_1",
    # обвес
    "Scope_1", "Scope_2", "Sight_1", "Sight_2",
]

# Корпуса — те, у кого есть гнёзда. Цевьё снайперской само вставляется в гнездо.
BODIES = [p for p in PARTS if p.startswith("Body_") and not p.startswith("Body_Front")]

# Гнёзда корпусов, сняты с образцов: (x, y) в осях glTF (Y вверх), ствол
# вдоль +X. Чего нет — считается из геометрии в sockets_of.
SOCKETS = {
    "Body_AR_1": {"barrel": (0.24, 0.02), "stock": (-0.36, 0.03), "grip": (-0.24, -0.24)},
    "Body_SMG_1": {"barrel": (0.22, -0.05), "stock": (-0.44, -0.04), "grip": (-0.28, -0.36),
                   "magazine": (0.20, -0.21)},
    # Ствол гранатомёта на глаз: в образцах его нет, а по краю корпуса он висел низко.
    "Body_Grenade_2": {"barrel": (0.50, -0.03), "stock": (-0.74, -0.06), "grip": (-0.53, -0.39)},
    # У снайперской корпус из двух частей: `front` — цевьё, ствол растёт из него.
    "Body_Sniper_1": {"front": (0.87, 0.08), "barrel": (0.88, 0.07), "stock": (-0.20, 0.0),
                      "grip": (0.35, -0.11), "magazine": (0.56, -0.07)},
}

# Сборки для превью: корпус + части по гнёздам. Дублируют `look` в
# weapons.yaml намеренно: скрипт Blender YAML не читает, а превью нужно
# до того, как игра запущена.
PREVIEW = {
    "rifle": {"body": "Body_AR_1", "barrel": "Barrel_AR_1", "stock": "Stock_AR_1",
              "grip": "Grip_AR_1", "magazine": "Magazine_AR", "top": "Sight_1"},
    "smg": {"body": "Body_SMG_1", "barrel": "Barrel_Single", "stock": "Stock_SMG_1",
            "grip": "Grip_SMG_1", "magazine": "Magazine_SMG_1"},
    "shotgun": {"body": "Body_Grenade_2", "barrel": "Barrel_Grenade_1", "stock": "Stock_Grenade_2",
                "grip": "Grip_Grenade_2"},
    "sniper": {"body": "Body_Sniper_1", "front": "Body_Front_Sniper_1", "barrel": "Barrel_Sniper_1", "stock": "Stock_Sniper_1",
               "grip": "Grip_Sniper_1", "magazine": "Magazine_Sniper_1", "top": "Scope_1"},
}


def log(msg):
    print(f"  {msg}")


def node_name(part):
    return "gun_" + part.lower()


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_part(part):
    path = os.path.join(SRC, f"{part}.gltf")
    if not os.path.exists(path):
        sys.exit(f"нет {path}: положите Modular Parts из набора Quaternius")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if len(meshes) != 1:
        sys.exit(f"{part}: ожидался один меш, пришло {len(meshes)}")
    mesh = meshes[0]
    # Импорт приносит пустышки-родители и трансформации: часть должна
    # лежать в мировых координатах как в файле, без иерархии.
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = world
    for o in new:
        if o is not mesh:
            bpy.data.objects.remove(o)
    mesh.name = node_name(part)
    mesh.data.name = mesh.name
    return mesh


def merge_materials():
    """Один «Black» на весь кит, а не по копии на часть: рендер красит по имени."""
    canon = {}
    for mat in list(bpy.data.materials):
        base = mat.name.split(".")[0]
        if base not in canon:
            canon[base] = mat
            mat.name = base
    for obj in bpy.data.objects:
        for slot in obj.material_slots:
            if slot.material is not None:
                slot.material = canon[slot.material.name.split(".")[0]]
    for mat in list(bpy.data.materials):
        if mat.users == 0:
            bpy.data.materials.remove(mat)


def bounds(obj):
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def sockets_of(part, body):
    """
    Гнёзда корпуса: снятые с образцов из SOCKETS, остальные — по геометрии.
    Оружие лежит стволом вдоль +X, верх — +Z (Blender). Перед — самые
    передние вершины, их средняя высота — ось ствола; низ — самые нижние,
    магазин под ними; верх — самые верхние, прицел на них.
    """
    lo, hi = bounds(body)
    vs = [v.co for v in body.data.vertices]
    eps = 0.03

    def mean(sel, axis):
        pts = [v for v in vs if sel(v)]
        return sum(getattr(v, axis) for v in pts) / len(pts)

    front_z = mean(lambda v: v.x > hi.x - eps, "z")
    back_z = mean(lambda v: v.x < lo.x + eps, "z")
    bottom_x = mean(lambda v: v.z < lo.z + eps, "x")
    top_x = mean(lambda v: v.z > hi.z - eps, "x")
    s = {
        "barrel": (hi.x, 0.0, front_z),
        "stock": (lo.x, 0.0, back_z),
        "magazine": (bottom_x, 0.0, lo.z),
        "top": (top_x, 0.0, hi.z),
        "grip": ((lo.x + hi.x) / 2, 0.0, lo.z),
    }
    for k, (x, y) in SOCKETS.get(part, {}).items():
        s[k] = (x, 0.0, y)
    return s


def to_gltf(v):
    """Blender (x, y, z) → glTF Y-up: (x, z, −y)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def build():
    clear_scene()
    parts = {p: import_part(p) for p in PARTS}
    merge_materials()
    tris = 0
    for obj in parts.values():
        tris += sum(len(p.vertices) - 2 for p in obj.data.polygons)
    log(f"частей {len(parts)}, треугольников {tris}")
    sockets = {}
    for body in BODIES:
        s = sockets_of(body, parts[body])
        sockets[body] = s
        # Свойство узла → extras в glTF. Сразу в осях glTF, чтобы рендер не
        # переворачивал.
        parts[body]["sockets"] = {k: to_gltf(v) for k, v in s.items()}
        log(f"{body}: " + ", ".join(f"{k} ({v[0]:.2f}, {v[2]:.2f})" for k, v in s.items()))
    os.makedirs(os.path.dirname(GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_extras=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
    )
    print(f"кит:    {GLB}  {os.path.getsize(GLB) / 1024:.1f} КБ")
    return parts, sockets


def preview(parts, sockets):
    """Сборки по гнёздам, камера сбоку, Workbench: проверить крепления."""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    for obj in parts.values():
        obj.hide_render = True
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 400
    scene.render.film_transparent = False
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 3.2
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0.2, -5, 0)
    cam.rotation_euler = (1.5708, 0, 0)
    scene.camera = cam
    for name, look in PREVIEW.items():
        body = parts[look["body"]]
        s = sockets[look["body"]]
        copies = []
        for slot, part in look.items():
            src = parts[part]
            c = src.copy()
            c.data = src.data
            c.hide_render = False
            scene.collection.objects.link(c)
            if slot != "body":
                c.location = Vector(s[slot])
            copies.append(c)
        scene.render.filepath = os.path.join(PREVIEW_DIR, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        log(f"превью {scene.render.filepath}")
        for c in copies:
            bpy.data.objects.remove(c)


if __name__ == "__main__":
    parts, sockets = build()
    if "--preview" in sys.argv:
        preview(parts, sockets)
