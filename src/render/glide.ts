/**
 * Положение фигуры между снапшотами — общее для кота и юнита.
 *
 * Симуляция дискретная, картинка непрерывная. Прогресс шага
 * экстраполируется на время с последнего тика той же скоростью, что и в
 * симуляции, и упирается в следующую клетку; лесенка A* сглаживается
 * скользящим средним по маршруту (`path.ts`). Поля движения у `CatView` и
 * `UnitView` одни и те же, поэтому один класс обслуживает обоих.
 */

import * as THREE from 'three'
import type { MoveView, WorldView } from '../shared/protocol'
import { cellToWorld } from './kit'
import { smoothAlong } from './path'

export interface Placement {
  /** Скорость земли под фигурой, ед/с; 0 — стоит. */
  speed: number
  /** Рысканье по касательной к сглаженной кривой; null — стоит. */
  tangentYaw: number | null
}

export class Glide {
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly c = new THREE.Vector3()
  /** Ломаная маршрута: prev, cell, next, дальше — без аллокаций на кадр. */
  private readonly route: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3())
  /** Тик последнего снапшота и модельное время, прошедшее с него. */
  private seenTick = -1
  private sinceTick = 0

  constructor(private readonly world: WorldView) {}

  /**
   * Раз в кадр, до размещения. Снапшот приходит раз в тик, а тик — 50 мс
   * модельного времени: на ×0.1 это два раза в секунду, и без ведения
   * позиции вперёд фигура шла бы рывками.
   */
  frame(tick: number, dt: number): void {
    if (tick !== this.seenTick) {
      this.seenTick = tick
      this.sinceTick = 0
    } else {
      this.sinceTick += dt * 1000
    }
  }

  /** Ломаная prev → cell → next → route… в `this.route`; вернёт число точек. */
  private routePoints(view: MoveView): number {
    let n = 0
    const push = (cell: { x: number; y: number }): void => {
      if (n < this.route.length) cellToWorld(cell, this.world, this.route[n++]!)
    }
    push(view.prev ?? view.cell)
    push(view.cell)
    for (const cell of view.route) push(cell)
    return n
  }

  /** Экранная позиция в `out`. `moving` — фигура сейчас идёт, а не стоит с маршрутом. */
  place(view: MoveView, moving: boolean, out: THREE.Vector3): Placement {
    let speed = 0
    let s = 0
    if (view.next !== null) {
      cellToWorld(view.cell, this.world, this.a)
      cellToWorld(view.next, this.world, this.b)
      const ahead = moving && view.stepMs > 0 ? this.sinceTick / view.stepMs : 0
      if (moving && view.stepMs > 0) speed = this.a.distanceTo(this.b) / (view.stepMs / 1000)
      s = Math.min(1, view.progress + ahead)
    }

    const n = this.routePoints(view)
    smoothAlong(this.route, n, 1 + s, out)

    // Корпус — по касательной к сглаженной кривой, пока идёт; иначе на
    // повороте лесенки он бы дёргался между восемью направлениями.
    let tangentYaw: number | null = null
    if (speed > 0 && n >= 3) {
      smoothAlong(this.route, n, 1 + s + 0.25, this.b)
      smoothAlong(this.route, n, 1 + s - 0.25, this.c)
      tangentYaw = Math.atan2(this.b.x - this.c.x, this.b.z - this.c.z)
    }
    return { speed, tangentYaw }
  }
}
