/**
 * Ортографическая камера, зафиксированный изометрический угол.
 *
 * Вращения в игре нет намеренно: двор — читаемая схема, а не пространство, в
 * котором игрок ищет удобный ракурс. Азимут крутится только для отладки —
 * посмотреть веса и текстуру с боков и со спины; наклон не меняется никогда.
 */

import * as THREE from 'three'

const MIN_ZOOM = 0.7
/**
 * Игровой предел — 1.4: дальше низкополигональность кота видна, и камера
 * в игре держится на расстоянии. Верх в 8 — отладочный: разглядеть стык
 * клипов и веса на суставах. В кадр при этом влезает ~2.5 клетки.
 */
const MAX_ZOOM = 8

/**
 * Вертикальный размер кадра в мировых единицах при зуме 1.
 * Подобран так, чтобы двор 20×20 занимал экран, а кот оставался различим:
 * при 26 двор помещался, но кот превращался в точку.
 */
const VIEW_SIZE = 21

/** Азимут изометрии: камера в (1, 1, 1), то есть 45° от оси X. */
const ISO_AZIMUTH = Math.PI / 4
const ROTATE_STEP = Math.PI / 12

const UP = new THREE.Vector3(0, 1, 0)
const GROUND = new THREE.Plane(UP, 0)

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera
  private readonly target = new THREE.Vector3()
  private zoom = 1
  private azimuth = ISO_AZIMUTH
  private width = 1
  private height = 1
  private readonly raycaster = new THREE.Raycaster()

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200)
    this.apply()
  }

  /** Мировых единиц на пиксель — нужно панораме, чтобы двор не убегал. */
  private get unitsPerPixel(): number {
    return VIEW_SIZE / this.zoom / this.height
  }

  private apply(): void {
    const half = VIEW_SIZE / this.zoom / 2
    const aspect = this.width / this.height
    this.camera.left = -half * aspect
    this.camera.right = half * aspect
    this.camera.top = half
    this.camera.bottom = -half

    // Наклон зафиксирован раз и навсегда: горизонтальная составляющая √2
    // на единицу высоты — это (1, 1, 1). Меняется только азимут, и только
    // для отладки.
    const dir = new THREE.Vector3(
      Math.SQRT2 * Math.cos(this.azimuth), 1, Math.SQRT2 * Math.sin(this.azimuth),
    ).normalize().multiplyScalar(60)
    this.camera.position.copy(this.target).add(dir)
    this.camera.lookAt(this.target)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.apply()
  }

  lookAtCentre(x: number, z: number): void {
    this.target.set(x, 0, z)
    this.apply()
  }

  /** Отладка: повернуть камеру вокруг цели на шаг; `0` — вернуть изометрию. */
  rotate(steps: number): void {
    this.azimuth = steps === 0 ? ISO_AZIMUTH : this.azimuth + steps * ROTATE_STEP
    this.apply()
  }

  zoomBy(delta: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.exp(-delta * 0.0015)))
    this.apply()
  }

  /**
   * Панорама «схватил карту»: двор идёт за курсором, а не против него.
   *
   * Цель камеры смещается навстречу жесту, поэтому знаки обратны сдвигу
   * курсора. По вертикали к этому добавляется второй разворот: экранное
   * «вниз» — это минус `forward`, а clientY растёт вниз, и два минуса дают
   * плюс. Без него карта уезжала вверх, когда курсор шёл вниз.
   */
  pan(dxPixels: number, dyPixels: number): void {
    const k = this.unitsPerPixel
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    // Экранное «вверх», уложенное на землю: панорама не должна поднимать камеру.
    const forward = up.clone().projectOnPlane(UP).normalize()

    // Земля видна под наклоном, поэтому шаг по ней даёт меньше экранной
    // вертикали, чем горизонтали: ровно столько, сколько forward сохранил от
    // экранного «вверх». Без поправки двор отстаёт от курсора вниз-вверх, но
    // точно поспевает вправо-влево — `right` лежит и в земле, и в экране.
    const foreshortening = Math.max(forward.dot(up), 0.05)

    this.target.addScaledVector(right, -dxPixels * k)
    this.target.addScaledVector(forward, (dyPixels * k) / foreshortening)
    this.apply()
  }

  /** Точка на земле под курсором. Нормализованные координаты, −1..1. */
  groundAt(ndcX: number, ndcY: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const hit = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(GROUND, hit) === null ? null : hit
  }
}
