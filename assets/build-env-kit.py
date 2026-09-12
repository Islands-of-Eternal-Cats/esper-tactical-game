"""
Кит окружения: `env-kit.glb` из сгенерированных пропсов двора.

    blender --background --python assets/build-env-kit.py

Пока здесь только обломки мусора — то, из чего рендер собирает кучи: они
тают по одному обломку, поэтому нужны не кучи, а куски. Каждый обломок —
text→3D через AssetHub (Tripo 3.1), исходники в `assets/gen/tripo/debris/`.
Здесь они нормируются, ужимаются под бюджет и получают имена контракта.

Модули двора (пол, стены, контейнер) по-прежнему коробки в коде рендера:
модульное и повторяющееся моделится руками, а не генерится — стыки по
сетке у генерации у каждого куска свои.

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


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"

    total = 0
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
