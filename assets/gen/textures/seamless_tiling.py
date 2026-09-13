"""Бесшовные тайлы: свёртки UNet и VAE получают циклическое дополнение.

Картинка тогда замыкается сама на себя по обеим осям — правый край
продолжает левый, низ — верх. Никаких швов сводить не надо.
"""

import torch


def _circular(module):
    for m in module.modules():
        if isinstance(m, torch.nn.Conv2d):
            m.padding_mode = "circular"
    return module


class SeamlessTileModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "model_patches"

    def patch(self, model):
        _circular(model.model.diffusion_model)
        return (model,)


class SeamlessTileVAE:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"vae": ("VAE",)}}

    RETURN_TYPES = ("VAE",)
    FUNCTION = "patch"
    CATEGORY = "model_patches"

    def patch(self, vae):
        _circular(vae.first_stage_model)
        return (vae,)


NODE_CLASS_MAPPINGS = {
    "SeamlessTileModel": SeamlessTileModel,
    "SeamlessTileVAE": SeamlessTileVAE,
}
