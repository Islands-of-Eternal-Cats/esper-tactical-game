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

const RINGS = 14
const SIDES = 6
const RADIUS = 0.022

/** Насколько провисает середина и насколько выносится вбок, через плечо. */
const SAG = 0.16
const SIDE = 0.12
const SPRING_RATE = 10

export class Hose {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.BufferGeometry()
  private readonly positions: Float32Array
  private readonly normals: Float32Array
  private readonly curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ])
  /** Управляющие точки провиса, ведутся пружиной за целью. */
  private readonly ctrl = [new THREE.Vector3(), new THREE.Vector3()]
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
   * Перестроить трубу от `from` к `to` (в системе координат меша). `side` —
   * направление выноса середины (через плечо), в тех же координатах.
   */
  update(from: THREE.Vector3, to: THREE.Vector3, side: THREE.Vector3, dt: number): void {
    const pts = this.curve.points
    pts[0]!.copy(from)
    pts[3]!.copy(to)
    for (let i = 0; i < 2; i++) {
      const f = i === 0 ? 0.35 : 0.7
      this.target.lerpVectors(from, to, f)
      this.target.y -= SAG * (i === 0 ? 1 : 0.7)
      this.target.addScaledVector(side, SIDE * (i === 0 ? 1 : 0.5))
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
