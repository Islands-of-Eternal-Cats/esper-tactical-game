/**
 * Цикл симуляции, приём команд, отправка снапшотов.
 *
 * Воркер физически не может дотянуться до объектов сцены — это делает
 * разделение слоёв техническим фактом, а не договорённостью.
 *
 * Время живёт здесь, а не в ядре: performance.now() допустим в воркере и
 * запрещён в core.
 */

import { Sim } from '../core/sim'
import { MAX_STEPS, TICK_MS } from '../core/tuning'
import type { Command, Speed, WorkerMessage } from '../shared/protocol'

const FRAME_MS = 16

let sim = new Sim(1)
let speed: Speed = 1
let acc = 0
let last = performance.now()

function post(msg: WorkerMessage): void {
  self.postMessage(msg)
}

function announce(): void {
  post({ t: 'world', world: sim.world() })
  post({ t: 'snapshot', snap: sim.snapshot() })
}

function frame(): void {
  const now = performance.now()
  acc += (now - last) * speed // speed: 0 = пауза
  last = now

  let steps = 0
  while (acc >= TICK_MS && steps < MAX_STEPS) {
    sim.tick() // без аргументов: шаг всегда TICK_MS
    acc -= TICK_MS
    steps++
  }

  // Упёрлись в ограничитель — значит вкладка была свёрнута и накопилась
  // минута. Догонять её нельзя: остаток выбрасывается, иначе кот молча
  // отработает минуту в один кадр.
  if (steps === MAX_STEPS && acc >= TICK_MS) acc = 0

  if (steps > 0) post({ t: 'snapshot', snap: sim.snapshot() })
}

self.onmessage = (e: MessageEvent<Command>): void => {
  const cmd = e.data
  switch (cmd.t) {
    case 'setSpeed':
      speed = cmd.speed
      break
    case 'setZone':
      sim.setZone(cmd.cell, cmd.radius)
      post({ t: 'snapshot', snap: sim.snapshot() })
      break
    case 'clearZone':
      sim.clearZone()
      post({ t: 'snapshot', snap: sim.snapshot() })
      break
    case 'debugClearPiles':
      sim.debugClearPiles()
      post({ t: 'snapshot', snap: sim.snapshot() })
      break
    case 'reset':
      sim = new Sim(cmd.seed)
      acc = 0
      last = performance.now()
      announce()
      break
  }
}

announce()
setInterval(frame, FRAME_MS)
