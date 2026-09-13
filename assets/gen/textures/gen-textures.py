"""Бесшовные тайлы поверхностей двора через локальный ComfyUI.

    python3 assets/gen/textures/gen-textures.py [имя ...]

Нужен запущенный ComfyUI (http://127.0.0.1:8188) с SDXL base в
`models/checkpoints/` и нодой бесшовности: `seamless_tiling.py` отсюда
кладётся в `custom_nodes/seamless_tiling/__init__.py`. Она даёт свёрткам
UNet и VAE циклическое дополнение, и картинка замыкается сама на себя без
сведения швов.

Тайл — «шум поверхности», а не текстура в полном смысле: генерится 1024²,
ужимается до 256², обесцвечивается и тонируется в цвет палитры двора так,
чтобы средний цвет остался ровно палитровым. Цвета — из
`src/render/palette.ts`, в ките эти материалы идут с белым множителем.
"""

import json
import os
import sys
import time
import urllib.request
import uuid

from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY = "http://127.0.0.1:8188"
CKPT = "sd_xl_base_1.0.safetensors"
SIZE = 256

NEGATIVE = (
    "seam, border, frame, edge, text, watermark, logo, objects, perspective, "
    "vanishing point, shadows, hard light, blurry, glossy, colorful, painting, "
    "joints, grout lines, cracks, bricks, tiles, pattern"
)

TILES = {
    "concrete_floor": dict(
        colour=0x22272E,
        contrast=0.35,
        # Швов и трещин в тайле быть не должно: шов между плитками — фаска
        # модуля, а рисунок в метр повторялся бы по всему двору.
        prompt="top-down close-up photo of uniform weathered concrete surface, fine aggregate "
        "speckle, dust, no joints, no cracks, flat overcast lighting, seamless tileable texture",
        seed=13,
    ),
    "wall_panel": dict(
        colour=0x4A5461,
        # Стена стоит вертикально к камере и ближе всего к глазу: крапинка
        # с той же силой, что на полу, читалась гранитом.
        contrast=0.3,
        # Стена — самая крупная поверхность у глаза, ей 512²: на 256² пятна
        # расплывались в кляксы, и все панели были одной кляксой.
        size=512,
        prompt="close-up photo of cast concrete wall surface, fine grain, small pores, faint "
        "vertical grime streaks, no joints, no cracks, flat overcast lighting, seamless tileable texture",
        seed=43,
    ),
    "asphalt": dict(
        colour=0x1C2026,
        prompt="top-down photo of dark aged asphalt surface, fine grain, faint patches, "
        "flat overcast lighting, uniform, seamless tileable texture",
        seed=37,
    ),
}


def workflow(prompt, seed):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "SeamlessTileModel", "inputs": {"model": ["1", 0]}},
        "3": {"class_type": "SeamlessTileVAE", "inputs": {"vae": ["1", 2]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": NEGATIVE}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0], "seed": seed, "steps": 28, "cfg": 6.0,
                "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
                "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "yard_tile"}},
    }


def run(name, spec):
    client = uuid.uuid4().hex
    body = json.dumps({"prompt": workflow(spec["prompt"], spec["seed"]), "client_id": client}).encode()
    req = urllib.request.Request(f"{COMFY}/prompt", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        pid = json.load(r)["prompt_id"]
    print(f"  {name}: очередь {pid[:8]}", flush=True)
    while True:
        time.sleep(3)
        with urllib.request.urlopen(f"{COMFY}/history/{pid}") as r:
            hist = json.load(r)
        if pid in hist:
            break
    out = hist[pid]["outputs"]["9"]["images"][0]
    q = urllib.parse.urlencode({"filename": out["filename"], "subfolder": out["subfolder"], "type": out["type"]})
    with urllib.request.urlopen(f"{COMFY}/view?{q}") as r:
        raw = os.path.join(HERE, f"{name}_raw.png")
        with open(raw, "wb") as f:
            f.write(r.read())
    return raw


def finish(name, raw, colour, contrast=0.55, size=SIZE):
    """1024² → 256² (стене 512²), серый шум вокруг 128, тонированный в цвет палитры."""
    img = Image.open(raw).convert("L")
    img = img.resize((size, size), Image.LANCZOS)
    # Контраст мягкий: тайл — шум, а не рисунок, и повтор не должен бросаться в глаза.
    img = ImageOps.autocontrast(img, cutoff=1)
    img = Image.blend(Image.new("L", img.size, 128), img, contrast)
    # Среднее ложится ровно в палитру, вариация — вокруг неё.
    mean = sum(img.get_flattened_data()) / (size * size)
    rgb = [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255]
    bands = [img.point(lambda v, c=c: min(255, round(c * v / mean))) for c in rgb]
    Image.merge("RGB", bands).save(os.path.join(HERE, f"{name}.png"), optimize=True)
    print(f"  {name}: {size}², {os.path.getsize(os.path.join(HERE, name + '.png')) / 1024:.1f} КБ")


if __name__ == "__main__":
    import urllib.parse

    names = sys.argv[1:] or list(TILES)
    for name in names:
        spec = TILES[name]
        finish(name, run(name, spec), spec["colour"], spec.get("contrast", 0.55), spec.get("size", SIZE))
