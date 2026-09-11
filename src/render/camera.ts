/**
 * Ортографическая камера, зафиксированный изометрический угол, без вращения.
 *
 * Вращения нет намеренно: двор — читаемая схема, а не пространство, в котором
 * игрок ищет удобный ракурс.
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

const UP = new THREE.Vector3(0, 1, 0)
const GROUND = new THREE.Plane(UP, 0)

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera
  private readonly target = new THREE.Vector3()
  private zoom = 1
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

    // Направление зафиксировано раз и навсегда.
    const dir = new THREE.Vector3(1, 1, 1).normalize().multiplyScalar(60)
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
