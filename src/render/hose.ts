/**
 * Шланг между ранцем и раструбом.
 *
 * В ассете он жить не может: концы на разных сокетах, расстояние между ними
 * меняется каждый кадр, и запечь трубку в клипы — значит связать её с каждой
 * позой. Здесь это кривая между двумя точками графа сцены и труба вдоль неё
 * с фиксированной топологией: индексы строятся один раз, позиции и нормали
 * переписываются на кадре. Провис ведётся пружиной — качается вслед за
 * взмахом с задержкой, и это самая дешёвая живость, какая бывает.
 */

import * as THREE from 'three'

const RINGS = 20
const SIDES = 7
const RADIUS = 0.03

/**
 * Как у ранцевого пылесоса: шланг выходит из бака сбоку у низа, уходит
 * петлёй наружу и вниз — до колена — и уже снизу поднимается к рукояти.
 * Длинная свободная петля читается шлангом издалека; короткая дуга через
 * плечо сливалась с корпусом.
 */
const LOOP_OUT = 0.22
const LOOP_DOWN = 0.30
const SPRING_RATE = 8

export class Hose {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.BufferGeometry()
  private readonly positions: Float32Array
  private readonly normals: Float32Array
  private readonly curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ])
  /** Управляющие точки петли, ведутся пружиной за целью. */
  private readonly ctrl = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly target = new THREE.Vector3()
  private primed = false

  private readonly p = new THREE.Vector3()
  private readonly t = new THREE.Vector3()
  private readonly n = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0, 1, 0)

  constructor(material: THREE.Material) {
    const verts = (RINGS + 1) * SIDES
    this.positions = new Float32Array(verts * 3)
    this.normals = new Float32Array(verts * 3)
    const index: number[] = []
    for (let r = 0; r < RINGS; r++) {
      for (let s = 0; s < SIDES; s++) {
        const a = r * SIDES + s
        const b = r * SIDES + ((s + 1) % SIDES)
        const c = (r + 1) * SIDES + s
        const d = (r + 1) * SIDES + ((s + 1) % SIDES)
        index.push(a, c, b, b, c, d)
      }
    }
    this.geometry.setIndex(index)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3))
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = false
  }

  /**
   * Перестроить трубу от `from` (выход из бака) к `to` (рукоять). `side` —
   * единичный вектор наружу, вбок от кота; всё в системе координат меша.
   */
  update(from: THREE.Vector3, to: THREE.Vector3, side: THREE.Vector3, dt: number): void {
    const pts = this.curve.points
    pts[0]!.copy(from)
    pts[4]!.copy(to)
    for (let i = 0; i < 3; i++) {
      if (i === 0) {
        // Сразу от бака — наружу и назад: шланг отходит от стенки и не
        // режет бок кота, который прямо перед ранцем.
        this.target.copy(from).addScaledVector(side, LOOP_OUT * 0.7).setY(from.y - 0.08)
        this.target.z -= 0.10
      } else if (i === 1) {
        // Низ петли — на уровне колена, снаружи.
        this.target.lerpVectors(from, to, 0.45).addScaledVector(side, LOOP_OUT)
        this.target.y = Math.min(from.y, to.y) - LOOP_DOWN
      } else {
        // Подход к рукояти снизу-сбоку.
        this.target.lerpVectors(from, to, 0.85).addScaledVector(side, LOOP_OUT * 0.5)
        this.target.y = to.y - 0.12
      }
      const ctrl = this.ctrl[i]!
      if (!this.primed) ctrl.copy(this.target)
      else ctrl.lerp(this.target, 1 - Math.exp(-SPRING_RATE * dt))
      pts[i + 1]!.copy(ctrl)
    }
    this.primed = true
    this.curve.updateArcLengths()

    for (let r = 0; r <= RINGS; r++) {
      const u = r / RINGS
      this.curve.getPointAt(u, this.p)
      this.curve.getTangentAt(u, this.t).normalize()
      // Нормаль — перпендикуляр к касательной, ближайший к вертикали:
      // у шланга нет кручения, которое стоило бы отслеживать.
      this.n.copy(this.up).addScaledVector(this.t, -this.up.dot(this.t)).normalize()
      this.b.crossVectors(this.t, this.n)
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2
        const cx = Math.cos(a)
        const cy = Math.sin(a)
        const k = (r * SIDES + s) * 3
        this.normals[k] = this.n.x * cx + this.b.x * cy
        this.normals[k + 1] = this.n.y * cx + this.b.y * cy
        this.normals[k + 2] = this.n.z * cx + this.b.z * cy
        this.positions[k] = this.p.x + this.normals[k]! * RADIUS
        this.positions[k + 1] = this.p.y + this.normals[k + 1]! * RADIUS
        this.positions[k + 2] = this.p.z + this.normals[k + 2]! * RADIUS
      }
    }
    this.geometry.attributes.position!.needsUpdate = true
    this.geometry.attributes.normal!.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
