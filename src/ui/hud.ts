/**
 * Интерфейс среза: строка состояния, счётчик, пауза, две кнопки скорости.
 *
 * Голый DOM. Svelte появится, когда появится первый меняющийся список —
 * панель докладов или ростер. Строка состояния списком не считается.
 */

import type { Snapshot, Speed } from '../shared/protocol'

export interface HudHandlers {
  onSpeed: (speed: Speed) => void
  onReset: () => void
}

const SPEEDS: ReadonlyArray<{ value: Speed; label: string }> = [
  { value: 0, label: '❙❙' },
  { value: 1, label: '×1' },
  { value: 3, label: '×3' },
]

/**
 * Клавиша → скорость. Двойка — вторая кнопка на панели, а не множитель:
 * клавиатура и панель должны говорить одно и то же.
 *
 * Сверяем и `code`, и `key`: первый не зависит от раскладки и потому главный,
 * второй выручает там, где события приходят синтетическими и `code` пуст.
 */
const KEY_SPEED: ReadonlyArray<{ codes: readonly string[]; keys: readonly string[]; speed: Speed }> = [
  { codes: ['Digit1', 'Numpad1'], keys: ['1'], speed: 1 },
  { codes: ['Digit2', 'Numpad2'], keys: ['2'], speed: 3 },
]

export class Hud {
  private readonly status: HTMLElement
  private readonly load: HTMLElement
  private readonly totals: HTMLElement
  private readonly buttons = new Map<Speed, HTMLButtonElement>()
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
    const reset = document.createElement('button')
    reset.textContent = 'заново'
    reset.className = 'wide'
    reset.addEventListener('click', () => {
      reset.blur()
      handlers.onReset()
    })
    controls.appendChild(reset)
    root.appendChild(controls)

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.innerHTML =
      'клик по земле — где важнее · правая кнопка — снять приоритет · колесо — зум · тянуть — панорама' +
      '<br>пробел — пауза и обратно на прежнюю скорость · 1 — ×1 · 2 — ×3'
    root.appendChild(hint)

    this.bindKeys(handlers)
  }

  /**
   * Клавиатура вместо мыши: в срезе игрок смотрит на кота, а не на панель.
   * Пробел — переключатель, а не «поставить на паузу»: он возвращает ту
   * скорость, на которой играли, а не сбрасывает на единицу.
   */
  private bindKeys(handlers: HudHandlers): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return

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
    const cat = snap.cats[0]
    if (cat === undefined) return
    this.status.textContent = cat.status
    this.load.style.width = `${Math.round((cat.load / cat.capacity) * 100)}%`
    this.totals.textContent =
      `убрано ${snap.totals.collected.toFixed(1)} · осталось ${snap.totals.remaining.toFixed(1)}`
  }
}
