/**
 * Сборка слоёв.
 *
 * Ядро сюда не импортируется никогда — только через воркер. Здесь живут
 * только цикл кадров, троттлинг снапшота для интерфейса и передача команд.
 */

import {
  DEFAULT_ZONE_RADIUS,
  type Command,
  type Mode,
  type Snapshot,
  type Speed,
  type WorkerMessage,
  type WorldView,
} from './shared/protocol'
import { loadKits } from './render/model'
import { SceneView } from './render/scene'
import { Hud } from './ui/hud'

const UI_HZ = 12

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!
const hudRoot = document.querySelector<HTMLElement>('#hud')!
const veil = document.querySelector<HTMLElement>('#veil')!
const veilBar = veil.querySelector<HTMLElement>('.bar > i')!
const veilStage = veil.querySelector<HTMLElement>('.stage')!

/**
 * Сид и срез из адреса страницы: `#31337` — двор, `#31337/skirmish` — бой.
 * Ссылка на бой, в котором что-то пошло не так, — рабочая единица плейтеста.
 */
function fromLocation(): { seed: number | null; mode: Mode } {
  const raw = window.location.hash.replace(/^#/, '').trim()
  const [seedPart = '', modePart = ''] = raw.split('/')
  const mode: Mode = modePart === 'skirmish' ? 'skirmish' : 'yard'
  if (seedPart === '') return { seed: null, mode }
  const value = Number.parseInt(seedPart, 10)
  return { seed: Number.isFinite(value) && value >= 0 ? Math.min(value, 0xffffffff) : null, mode }
}

/**
 * replaceState, а не присваивание location.hash: не плодит записей в истории
 * и не поднимает hashchange, то есть не может закольцеваться с нашим же
 * ответом воркера.
 */
function rememberSeed(seed: number, mode: Mode): void {
  window.history.replaceState(null, '', mode === 'yard' ? `#${seed}` : `#${seed}/${mode}`)
}

// Киты запрашиваются первыми: это самое тяжёлое, и ждать сцены незачем.
//
// Занавес показывает этапы, а не общий процент: байты честно считаются
// только у моделей. «код» — до этой строки (полоска пульсирует, это CSS),
// «модели» — доля по байтам, «сцена» — первый кадр с компиляцией шейдеров.
const kits = loadKits((fraction) => {
  veil.classList.add('loading')
  veilBar.style.width = `${Math.round(fraction * 100)}%`
  veilStage.textContent = `модели · ${Math.round(fraction * 100)} %`
})

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
  onMode: (mode) => {
    if (world?.mode !== mode) send({ t: 'setMode', mode })
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
const start = fromLocation()
let awaited: { seed: number; mode: Mode } | null =
  start.seed !== null || start.mode !== 'yard' ? { seed: start.seed ?? 1, mode: start.mode } : null

worker.onmessage = (e: MessageEvent<WorkerMessage>): void => {
  const msg = e.data
  if (msg.t === 'world') {
    if (awaited !== null && (msg.world.seed !== awaited.seed || msg.world.mode !== awaited.mode)) return
    awaited = null
    world = msg.world
    snapshot = null
    // Сцена создаётся один раз: второй рендерер на том же холсте получил бы
    // тот же контекст, а обработчики ввода навесились бы повторно.
    if (scene === null) {
      scene = new SceneView(canvas, world, {
        onIntent: (cell) => send({ t: 'setZone', cell, radius: DEFAULT_ZONE_RADIUS }),
        onClearIntent: () => send({ t: 'clearZone' }),
        onMove: (units, cell) => send({ t: 'move', units, cell }),
        onSelect: (units) => hud.setSelection(units),
      }, kits)
      // Отладка из консоли браузера: заглянуть в граф сцены. Только в dev.
      if (import.meta.env.DEV) (window as unknown as { __scene: SceneView }).__scene = scene
      // Занавес до китов: иначе первые секунды по двору бегает капсула.
      // Симуляция стоит, чтобы игрок увидел двор с самого начала, а не с
      // середины первой ходки; первый кадр под занавесом уже отрисован,
      // поэтому занавес уходит без чёрной вспышки.
      send({ t: 'setSpeed', speed: 0 })
      void scene.ready.then(() => {
        veil.classList.add('loading')
        veilBar.style.width = '100%'
        veilStage.textContent = 'сцена'
        // Первый кадр с китами компилирует шейдеры — это секунда на слабом
        // GPU, и полоска на 100 % при чёрном экране выглядела бы враньём.
        // Два кадра: первый рисует и компилирует, второй уже показан.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          veil.classList.add('gone')
          send({ t: 'setSpeed', speed })
        }))
      })
    } else {
      scene.setWorld(world)
    }
    hud.setSeed(world.seed)
    hud.setMode(world.mode)
    rememberSeed(world.seed, world.mode)
    return
  }
  snapshot = msg.snap
}

// Срез — раньше сида: `reset` строит двор в срезе, который воркер помнит.
if (awaited !== null) {
  if (awaited.mode !== 'yard') send({ t: 'setMode', mode: awaited.mode })
  if (awaited.seed !== 1 || awaited.mode === 'yard') send({ t: 'reset', seed: awaited.seed })
}

// Правка сида прямо в адресной строке не перезагружает страницу, только
// поднимает hashchange. Свои записи мы делаем через replaceState, который
// событие не поднимает, поэтому закольцеваться отсюда не с чем.
window.addEventListener('hashchange', () => {
  const { seed, mode } = fromLocation()
  if (mode !== world?.mode) send({ t: 'setMode', mode })
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
