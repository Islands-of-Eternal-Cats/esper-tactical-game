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

export class Hud {
  private readonly status: HTMLElement
  private readonly load: HTMLElement
  private readonly totals: HTMLElement
  private readonly buttons = new Map<Speed, HTMLButtonElement>()

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
      b.addEventListener('click', () => handlers.onSpeed(value))
      controls.appendChild(b)
      this.buttons.set(value, b)
    }
    const reset = document.createElement('button')
    reset.textContent = 'заново'
    reset.className = 'wide'
    reset.addEventListener('click', handlers.onReset)
    controls.appendChild(reset)
    root.appendChild(controls)

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'клик по земле — где важнее · правая кнопка — снять приоритет · колесо — зум · тянуть — панорама'
    root.appendChild(hint)
  }

  setSpeed(speed: Speed): void {
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
