/**
 * Сборка слоёв.
 *
 * Ядро сюда не импортируется никогда — только через воркер. Здесь живут
 * только цикл кадров, троттлинг снапшота для интерфейса и передача команд.
 */

import { DEFAULT_ZONE_RADIUS, type Command, type Snapshot, type Speed, type WorkerMessage, type WorldView } from './shared/protocol'
import { SceneView } from './render/scene'
import { Hud } from './ui/hud'

const UI_HZ = 12

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!
const hudRoot = document.querySelector<HTMLElement>('#hud')!

const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' })

function send(cmd: Command): void {
  worker.postMessage(cmd)
}

let scene: SceneView | null = null
let world: WorldView | null = null
let snapshot: Snapshot | null = null
let speed: Speed = 1

const hud = new Hud(hudRoot, {
  onSpeed: (s) => {
    speed = s
    send({ t: 'setSpeed', speed: s })
    hud.setSpeed(s)
  },
  onReset: () => {
    // Сид виден и воспроизводим: тот же сид даёт тот же двор.
    send({ t: 'reset', seed: (Date.now() >>> 0) % 100000 })
  },
})
hud.setSpeed(speed)

worker.onmessage = (e: MessageEvent<WorkerMessage>): void => {
  const msg = e.data
  if (msg.t === 'world') {
    world = msg.world
    scene = new SceneView(canvas, world, {
      onIntent: (cell) => send({ t: 'setZone', cell, radius: DEFAULT_ZONE_RADIUS }),
      onClearIntent: () => send({ t: 'clearZone' }),
    })
    return
  }
  snapshot = msg.snap
}

window.addEventListener('resize', () => scene?.resize())

// Интерфейс получает троттленную копию: перерисовка на частоте кадров —
// просто сожжённый бюджет.
setInterval(() => {
  if (snapshot !== null) hud.update(snapshot)
}, 1000 / UI_HZ)

let last = performance.now()
function frame(now: number): void {
  // Микшер получает реальное время кадра, умноженное на множитель скорости.
  // Никогда — дельту из аккумулятора симуляции.
  const dt = Math.min((now - last) / 1000, 0.1) * speed
  last = now
  scene?.render(snapshot, dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
