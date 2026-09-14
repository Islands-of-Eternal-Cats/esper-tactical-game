/**
 * Интерфейс среза: строка состояния, счётчик, пауза, две кнопки скорости.
 *
 * Голый DOM. Svelte появится, когда появится первый меняющийся список —
 * панель докладов или ростер. Строка состояния списком не считается.
 */

import type { Mode, Snapshot, Speed } from '../shared/protocol'

export interface HudHandlers {
  onSpeed: (speed: Speed) => void
  onReset: (seed: number) => void
  onMode: (mode: Mode) => void
  onDebugClearPiles: () => void
}

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'yard', label: 'двор' },
  { value: 'skirmish', label: 'перестрелка' },
]

const HINT: Record<Mode, string> = {
  yard:
    'клик по земле — где важнее · правая кнопка — снять приоритет · колесо — зум · тянуть — панорама' +
    '<br>пробел — пауза и обратно на прежнюю скорость · 1–4 — ×0.1 · ×0.5 · ×1 · ×3' +
    '<br>отладка: Q/E — повернуть камеру, R — изометрия, F — следовать за котом',
  skirmish:
    'клик по своему — выделить · тянуть — рамка · Shift — добавить · клик по земле — идти туда' +
    '<br>правая кнопка — снять выделение · тянуть правой — панорама · колесо — зум' +
    '<br>пробел — пауза · 1–4 — скорость · Q/E — повернуть камеру, R — изометрия',
}

/** Пять цифр: такой сид можно продиктовать вслух и записать на бумажке. */
function randomSeed(): number {
  return Math.floor(Math.random() * 100000)
}

const SPEEDS: ReadonlyArray<{ value: Speed; label: string }> = [
  { value: 0, label: '❙❙' },
  { value: 0.1, label: '×0.1' },
  { value: 0.5, label: '×0.5' },
  { value: 1, label: '×1' },
  { value: 3, label: '×3' },
]

/**
 * Клавиша → скорость. Цифры идут по кнопкам панели слева направо, а не по
 * множителю: клавиатура и панель должны говорить одно и то же.
 *
 * Сверяем и `code`, и `key`: первый не зависит от раскладки и потому главный,
 * второй выручает там, где события приходят синтетическими и `code` пуст.
 */
const KEY_SPEED: ReadonlyArray<{ codes: readonly string[]; keys: readonly string[]; speed: Speed }> = [
  { codes: ['Digit1', 'Numpad1'], keys: ['1'], speed: 0.1 },
  { codes: ['Digit2', 'Numpad2'], keys: ['2'], speed: 0.5 },
  { codes: ['Digit3', 'Numpad3'], keys: ['3'], speed: 1 },
  { codes: ['Digit4', 'Numpad4'], keys: ['4'], speed: 3 },
]

export class Hud {
  private readonly name: HTMLElement
  private readonly status: HTMLElement
  private readonly load: HTMLElement
  private readonly totals: HTMLElement
  private readonly hint: HTMLElement
  private readonly buttons = new Map<Speed, HTMLButtonElement>()
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>()
  private readonly seed: HTMLInputElement
  private mode: Mode = 'yard'
  /** Кого игрок выделил: статус в панели — про первого живого из них. */
  private selected: string[] = []
  private current: Speed = 1
  /** Куда пробел возвращает из паузы: последняя ненулевая скорость. */
  private resume: Speed = 1

  constructor(root: HTMLElement, handlers: HudHandlers) {
    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.innerHTML = `
      <div class="name">Ржавый</div>
      <div class="status">—</div>
      <div class="bar"><i></i></div>
      <div class="totals">—</div>
    `
    root.appendChild(panel)

    this.name = panel.querySelector('.name')!
    this.status = panel.querySelector('.status')!
    this.load = panel.querySelector('.bar > i')!
    this.totals = panel.querySelector('.totals')!

    const controls = document.createElement('div')
    controls.className = 'controls'
    for (const { value, label } of SPEEDS) {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', () => {
        // Снять фокус: иначе пробел будет и переключать паузу, и повторно
        // нажимать кнопку, на которой фокус остался.
        b.blur()
        handlers.onSpeed(value)
      })
      controls.appendChild(b)
      this.buttons.set(value, b)
    }
    root.appendChild(controls)

    // Сид виден и вводится руками: двор воспроизводим по построению, но пока
    // сид не показан, воспользоваться этим нельзя. Тот же сид — тот же двор.
    const seeds = document.createElement('div')
    seeds.className = 'seeds'
    seeds.innerHTML = '<label for="seed">сид</label><input id="seed" type="text" inputmode="numeric" autocomplete="off" spellcheck="false">'
    this.seed = seeds.querySelector('input')!

    const again = document.createElement('button')
    again.textContent = 'заново'
    again.addEventListener('click', () => {
      again.blur()
      handlers.onReset(this.enteredSeed())
    })
    seeds.appendChild(again)

    const other = document.createElement('button')
    other.textContent = 'случайный'
    other.addEventListener('click', () => {
      other.blur()
      handlers.onReset(randomSeed())
    })
    seeds.appendChild(other)

    this.seed.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      this.seed.blur()
      handlers.onReset(this.enteredSeed())
    })
    root.appendChild(seeds)

    // Срез: двор или перестрелка. Смена — новый двор на том же сиде.
    const modes = document.createElement('div')
    modes.className = 'seeds'
    const modeLabel = document.createElement('label')
    modeLabel.textContent = 'срез'
    modes.appendChild(modeLabel)
    for (const { value, label } of MODES) {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', () => {
        b.blur()
        handlers.onMode(value)
      })
      modes.appendChild(b)
      this.modeButtons.set(value, b)
    }
    root.appendChild(modes)

    // Отладка: строка кнопок, которых в игре не будет.
    const debug = document.createElement('div')
    debug.className = 'seeds'
    const clearPiles = document.createElement('button')
    clearPiles.textContent = 'убрать все кучи'
    clearPiles.addEventListener('click', () => {
      clearPiles.blur()
      handlers.onDebugClearPiles()
    })
    debug.appendChild(clearPiles)
    root.appendChild(debug)

    this.hint = document.createElement('div')
    this.hint.className = 'hint'
    root.appendChild(this.hint)
    this.setMode('yard')

    this.bindKeys(handlers)
  }

  setMode(mode: Mode): void {
    this.mode = mode
    this.selected = []
    this.name.textContent = mode === 'yard' ? 'Ржавый' : 'Отряд'
    this.hint.innerHTML = HINT[mode]
    for (const [value, button] of this.modeButtons) button.classList.toggle('on', value === mode)
  }

  setSelection(ids: string[]): void {
    this.selected = ids
  }

  /** Что набрано в поле. Мусор превращается в ноль, а не в тихий отказ. */
  private enteredSeed(): number {
    const value = Number.parseInt(this.seed.value.trim(), 10)
    if (!Number.isFinite(value) || value < 0) return 0
    return Math.min(value, 0xffffffff)
  }

  setSeed(seed: number): void {
    this.seed.value = String(seed)
  }

  /**
   * Клавиатура вместо мыши: в срезе игрок смотрит на кота, а не на панель.
   * Пробел — переключатель, а не «поставить на паузу»: он возвращает ту
   * скорость, на которой играли, а не сбрасывает на единицу.
   */
  private bindKeys(handlers: HudHandlers): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      // Иначе «1» в поле сида переключала бы скорость вместо ввода цифры.
      const target = e.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return

      if (e.code === 'Space' || e.key === ' ') {
        // Иначе пробел прокрутит страницу и нажмёт кнопку под фокусом.
        e.preventDefault()
        handlers.onSpeed(this.current === 0 ? this.resume : 0)
        return
      }

      for (const { codes, keys, speed } of KEY_SPEED) {
        if (codes.includes(e.code) || keys.includes(e.key)) {
          e.preventDefault()
          handlers.onSpeed(speed)
          return
        }
      }
    })
  }

  setSpeed(speed: Speed): void {
    this.current = speed
    if (speed !== 0) this.resume = speed
    for (const [value, button] of this.buttons) button.classList.toggle('on', value === speed)
  }

  /** Снапшот приходит троттленным: чаще 10–15 Гц человек всё равно не читает. */
  update(snap: Snapshot): void {
    if (this.mode === 'skirmish') {
      this.updateSkirmish(snap)
      return
    }
    const cat = snap.cats[0]
    if (cat === undefined) return
    this.status.textContent = cat.status
    this.load.style.width = `${Math.round((cat.load / cat.capacity) * 100)}%`
    this.totals.textContent =
      `убрано ${snap.totals.collected.toFixed(1)} · осталось ${snap.totals.remaining.toFixed(1)}`
  }

  /**
   * Статус выделенного, а не «отряда в целом»: игрок спрашивает «почему
   * этот стоит», и ответ должен быть про этого.
   */
  private updateSkirmish(snap: Snapshot): void {
    const own = snap.units.filter((u) => u.side === 'player' && u.action !== 'dead')
    const foe = snap.units.filter((u) => u.side === 'enemy' && u.action !== 'dead')
    const picked = snap.units.find((u) => this.selected.includes(u.id) && u.action !== 'dead')
    if (picked !== undefined) {
      const many = this.selected.length > 1 ? ` (+${this.selected.length - 1})` : ''
      this.status.textContent = `${picked.id}${many}: ${picked.status}${picked.cover ? ' · в укрытии' : ''}`
      this.load.style.width = `${Math.round((picked.hp / 3) * 100)}%`
    } else {
      this.status.textContent = own.length === 0 ? 'отряд выбит' : 'клик по бойцу или рамка — выделить'
      this.load.style.width = '0%'
    }
    let outcome = ''
    if (foe.length === 0 && own.length > 0) outcome = ' · противник выбит'
    else if (own.length === 0) outcome = ' · поражение'
    this.totals.textContent = `свои ${own.length} · противник ${foe.length}${outcome}`
  }
}
