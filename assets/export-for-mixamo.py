"""
Кот для авториггера Mixamo: один меш, без скелета и снаряжения.

    blender --background --python assets/export-for-mixamo.py

Берёт `assets/rusty.blend`, склеивает голову с корпусом, снимает скелет и
пишет `assets/mixamo/cat/rusty-for-mixamo.fbx` с картой кота внутри — по
ней в Mixamo видно морду и ладони, когда ставишь маркеры.

Поза — как в эталоне, A-поза: Mixamo её принимает (спросит «T или A»).
Снаряжение (`gear_*`, `held_*`) не идёт: риггеру нужна фигура, а не пылесос;
снаряжение сядет на новый скелет в ките, как и сейчас.

Дальше руками, в браузере (mixamo.com → Upload character):
  1. загрузить FBX, выбрать A-pose;
  2. маркеры: подбородок, запястья, локти, колени, пах — по картинке;
  3. «Next», дождаться ригга, проверить на любом клипе, что локти гнутся
     вперёд, а не внутрь;
  4. скачать персонажа: T-pose, FBX Binary, With Skin;
  5. скачать те же клипы уже для него: Rifle Idle, Rifle Run, Rifle Aiming
     Idle, Firing Rifle, Dying — FBX, Without Skin, 30 fps; для Run —
     «In Place»;
  6. всё — в `assets/mixamo/cat/`.
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, "assets", "rusty.blend")
OUT_DIR = os.path.join(ROOT, "assets", "mixamo", "cat")
OUT = os.path.join(OUT_DIR, "rusty-for-mixamo.fbx")

FIGURE = ("body_stocky", "head_rusty")


def main():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    keep = []
    for o in list(bpy.data.objects):
        if o.name in FIGURE:
            keep.append(o)
        else:
            bpy.data.objects.remove(o)
    if len(keep) != len(FIGURE):
        raise SystemExit(f"в эталоне нет части из {FIGURE}")

    for o in keep:
        world = o.matrix_world.copy()
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        o.parent = None
        o.matrix_world = world
        o.vertex_groups.clear()

    bpy.ops.object.select_all(action="DESELECT")
    for o in keep:
        o.select_set(True)
    bpy.context.view_layer.objects.active = keep[0]
    bpy.ops.object.join()
    cat = bpy.context.view_layer.objects.active
    cat.name = "rusty"
    cat.data.name = "rusty"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    lo = min((cat.matrix_world @ v.co).z for v in cat.data.vertices)
    hi = max((cat.matrix_world @ v.co).z for v in cat.data.vertices)
    print(f"  кот: {len(cat.data.vertices)} вершин, рост {hi - lo:.2f} м, пол на z={lo:.3f}")

    os.makedirs(OUT_DIR, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=OUT,
        use_selection=True,
        object_types={"MESH"},
        apply_scale_options="FBX_SCALE_ALL",
        path_mode="COPY",
        embed_textures=True,
        add_leaf_bones=False,
        bake_anim=False,
    )
    print(f"  {OUT}  {os.path.getsize(OUT) / 1024:.0f} КБ")


main()
