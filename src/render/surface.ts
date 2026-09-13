/**
 * Бетон и асфальт — шейдером, по мировой координате.
 *
 * Тайл на плитке повторялся клетка в клетку, и глаз это ловил. Здесь цвет
 * считается из `(x, z)` точки на поверхности: зерно — шум в несколько октав,
 * трещины — рёбра Вороного, искажённые шумом, разница плит — хеш номера
 * клетки. Ничего не повторяется, картинок не грузится. Всё детерминировано
 * координатой: панорама и зум ничего не двигают.
 *
 * Материал остаётся MeshStandardMaterial — свет, тени и тонмаппинг общие со
 * всем двором; подменяется только выборка `map`. Цвет палитры остаётся в
 * `material.color`, шейдер даёт множитель вокруг единицы.
 *
 * Камера ортографическая, зум 0,7–1,4: частоты подобраны под этот масштаб
 * раз и навсегда, мип-уровней и «сияния» на дальних планах здесь не бывает.
 */

import * as THREE from 'three'

const LIB = /* glsl */ `
varying vec3 vYard;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return v;
}

/** Расстояние до ребра Вороного: 0 на самом ребре. */
float vedge(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash21(i + g), hash21(i + g + 3.7));
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}
`

const CONCRETE = /* glsl */ `
vec2 p = vYard.xz;
vec2 cell = floor(p);
vec2 f = p - cell;

// Каждой плите — свой тон: это и есть «разные плиты», а не одна на всех.
float slab = 0.86 + 0.28 * hash21(cell + 0.5);
// Зерно: крупное и мелкое.
float grain = 0.92 + 0.16 * fbm(p * 7.0) + 0.08 * (vnoise(p * 41.0) - 0.5);
// Пятна: редкие тёмные разводы.
float stain = smoothstep(0.58, 0.82, fbm(p * 0.9 + 7.3));
// Трещины: рёбра Вороного, покривлённые шумом, и только там, где им быть —
// маска низкочастотным шумом, иначе весь двор в сетке.
float e = vedge(p * 1.3 + 0.18 * (fbm(p * 4.0) - 0.5));
float crack = (1.0 - smoothstep(0.0, 0.035, e)) * smoothstep(0.54, 0.66, fbm(p * 0.37 + 3.1));
// Край плиты темнее: пыль скапливается у шва.
float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
float rim = 1.0 - smoothstep(0.0, 0.07, edge);

float k = slab * grain * (1.0 - 0.22 * stain) * (1.0 - 0.5 * crack) * (1.0 - 0.18 * rim);
diffuseColor.rgb *= k;
`

const ASPHALT = /* glsl */ `
vec2 p = vYard.xz;
// Мелкое зерно и широкие латки: асфальт чинят кусками.
float grain = 0.9 + 0.2 * fbm(p * 9.0) + 0.06 * (vnoise(p * 53.0) - 0.5);
// patch — зарезервированное слово GLSL, поэтому mend.
float mend = smoothstep(0.55, 0.6, fbm(p * 0.45 + 11.0));
float k = grain * (1.0 - 0.14 * mend);
diffuseColor.rgb *= k;
`

const VERTEX = /* glsl */ `
#include <project_vertex>
{
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  vYard = (modelMatrix * wp).xyz;
}
`

function procedural(material: THREE.MeshStandardMaterial, body: string, key: string): void {
  // Картинка, если приехала, больше не нужна: цвет считается на месте.
  material.map = null
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vYard;`)
      .replace('#include <project_vertex>', VERTEX)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LIB}`)
      .replace('#include <map_fragment>', `{\n${body}\n}`)
  }
  // Ключ кэша: у трёх материалов с одной программой three иначе перепутает шейдеры.
  material.customProgramCacheKey = () => key
  material.needsUpdate = true
}

export function proceduralConcrete(material: THREE.MeshStandardMaterial): void {
  procedural(material, CONCRETE, 'yard-concrete')
}

export function proceduralAsphalt(material: THREE.MeshStandardMaterial): void {
  procedural(material, ASPHALT, 'yard-asphalt')
}
