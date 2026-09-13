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
const veil = document.querySelector<HTMLElement>('#veil')!
const veilBar = veil.querySelector<HTMLElement>('.bar > i')!

/** Сид из адреса страницы: ссылка на двор, который стоит показать другому. */
function seedFromLocation(): number | null {
  const raw = window.location.hash.replace(/^#/, '').trim()
  if (raw === '') return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 0xffffffff) : null
}

/**
 * replaceState, а не присваивание location.hash: не плодит записей в истории
 * и не поднимает hashchange, то есть не может закольцеваться с нашим же
 * ответом воркера.
 */
function rememberSeed(seed: number): void {
  window.history.replaceState(null, '', `#${seed}`)
}

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
  onReset: (seed) => {
    send({ t: 'reset', seed })
  },
  onDebugClearPiles: () => send({ t: 'debugClearPiles' }),
})
hud.setSpeed(speed)

/**
 * Сид, которого мы ждём вместо двора по умолчанию.
 *
 * Воркер объявляет свой двор, пока грузится модуль главного потока, и узнать
 * про адрес страницы он не может — `self.location` у него свой. Поэтому двор
 * по умолчанию приходит всегда, и если нужен другой, его надо пропустить:
 * иначе на каждой загрузке по ссылке строится и тут же выбрасывается целая
 * сцена, а игрок успевает увидеть чужой двор.
 */
let awaited = seedFromLocation()

worker.onmessage = (e: MessageEvent<WorkerMessage>): void => {
  const msg = e.data
  if (msg.t === 'world') {
    if (awaited !== null && msg.world.seed !== awaited) return
    awaited = null
    world = msg.world
    snapshot = null
    // Сцена создаётся один раз: второй рендерер на том же холсте получил бы
    // тот же контекст, а обработчики ввода навесились бы повторно.
    if (scene === null) {
      scene = new SceneView(canvas, world, {
        onIntent: (cell) => send({ t: 'setZone', cell, radius: DEFAULT_ZONE_RADIUS }),
        onClearIntent: () => send({ t: 'clearZone' }),
        onProgress: (fraction) => {
          veilBar.style.width = `${Math.round(fraction * 100)}%`
        },
      })
      // Отладка из консоли браузера: заглянуть в граф сцены. Только в dev.
      if (import.meta.env.DEV) (window as unknown as { __scene: SceneView }).__scene = scene
      // Занавес до китов: иначе первые секунды по двору бегает капсула.
      // Симуляция стоит, чтобы игрок увидел двор с самого начала, а не с
      // середины первой ходки; первый кадр под занавесом уже отрисован,
      // поэтому занавес уходит без чёрной вспышки.
      send({ t: 'setSpeed', speed: 0 })
      void scene.ready.then(() => {
        veilBar.style.width = '100%'
        veil.classList.add('gone')
        send({ t: 'setSpeed', speed })
      })
    } else {
      scene.setWorld(world)
    }
    hud.setSeed(world.seed)
    rememberSeed(world.seed)
    return
  }
  snapshot = msg.snap
}

if (awaited !== null) send({ t: 'reset', seed: awaited })

// Правка сида прямо в адресной строке не перезагружает страницу, только
// поднимает hashchange. Свои записи мы делаем через replaceState, который
// событие не поднимает, поэтому закольцеваться отсюда не с чем.
window.addEventListener('hashchange', () => {
  const seed = seedFromLocation()
  if (seed !== null && seed !== world?.seed) send({ t: 'reset', seed })
})

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
