/**
 * Лог боя в консоль браузера: что случилось и почему, в модельных секундах.
 *
 * Плейтест — это перечитать бой, а не вспоминать его. Лог собирается из
 * событий снапшота и приказов игрока; ядро о нём не знает.
 */

import type { Cell, Event, Snapshot } from '../shared/protocol'

const TICK_S = 0.05

interface Tally {
  shots: number
  hits: number
  taken: number
}

export class BattleLog {
  private seed = 0
  private over = false
  /** Состав ещё не напечатан: печатается первым снапшотом боя, там есть оружие. */
  private roster = true
  private readonly tally = new Map<string, Tally>()
  /** Всё, что напечатано, — чтобы отдать бой целиком одним куском. */
  private lines: string[] = []

  private say(line: string, style = ''): void {
    this.lines.push(line)
    if (style === '') console.log(line)
    else console.log(`%c${line}`, style)
  }

  /** Весь бой текстом: для заметки о плейтесте. */
  text(): string {
    return this.lines.join('\n')
  }

  private stamp(tick: number): string {
    return `[${(tick * TICK_S).toFixed(1).padStart(5)} с]`
  }

  private of(id: string): Tally {
    let t = this.tally.get(id)
    if (t === undefined) {
      t = { shots: 0, hits: 0, taken: 0 }
      this.tally.set(id, t)
    }
    return t
  }

  reset(seed: number): void {
    this.seed = seed
    this.over = false
    this.roster = true
    this.tally.clear()
    this.lines = []
    this.say(`— бой, сид ${seed} —`, 'font-weight: bold')
  }

  order(tick: number, units: string[], cell: Cell): void {
    this.say(`${this.stamp(tick)} приказ ${units.join(', ')} → ${cell.x},${cell.y}`)
  }

  private event(tick: number, e: Event): void {
    if (e.t === 'shot') {
      const from = this.of(e.from)
      from.shots++
      if (e.hit) {
        from.hits++
        this.of(e.to).taken++
      }
      const why = `${(e.chance / 10).toFixed(0)} %${e.cover ? ', в укрытии' : ''}`
      this.say(`${this.stamp(tick)} ${e.from} → ${e.to}: ${e.hit ? 'попал' : 'промах'} (${why})`)
      return
    }
    this.say(`${this.stamp(tick)} ${e.unit} убит`, 'color: #b5453c')
  }

  note(snap: Snapshot): void {
    if (this.over) return
    if (this.roster) {
      this.roster = false
      for (const side of ['player', 'enemy'] as const) {
        const list = snap.units.filter((u) => u.side === side).map((u) => `${u.id} ${u.weaponName}`)
        this.say(`  ${side === 'player' ? 'свои' : 'противник'}: ${list.join(', ')}`)
      }
    }
    for (const e of snap.events) this.event(snap.tick, e)

    const own = snap.units.filter((u) => u.side === 'player' && u.action !== 'dead')
    const foe = snap.units.filter((u) => u.side === 'enemy' && u.action !== 'dead')
    if (own.length > 0 && foe.length > 0) return
    this.over = true
    const who = own.length > 0 ? 'противник выбит' : 'отряд выбит'
    this.say(`${this.stamp(snap.tick)} конец: ${who} за ${(snap.tick * TICK_S).toFixed(0)} с`, 'font-weight: bold')
    for (const [id, t] of [...this.tally].sort()) {
      this.say(`  ${id}: выстрелов ${t.shots}, попаданий ${t.hits}, получено ${t.taken}`)
    }
    this.say(`  ссылка: ${window.location.origin}${window.location.pathname}#${this.seed}/skirmish`)
  }
}
