/**
 * Звук: шаги и выстрелы синтезируются в Web Audio, файлов нет.
 *
 * Тот же принцип, что у текстур и капсул: ни байта ассетов, ни лицензий,
 * ни ожидания загрузки. Каждый звук — короткий шумовой всплеск через фильтр
 * с экспоненциальным спадом, плюс низкий «удар» для веса; высота и длина
 * чуть случайны, иначе шаги звучат пулемётом.
 *
 * Контекст создаётся по первому жесту пользователя — браузер без него не
 * заиграет; до жеста вызовы молча пропускаются. Позиция звука — экранная:
 * стерео по горизонтали кадра, громкость падает за его краем. Для
 * изометрии с панорамой это ближе к тому, что видно, чем 3D-слушатель.
 */

import * as THREE from 'three'

/** Панорама не до упора: полностью в одном ухе звучит как поломка. */
const PAN_WIDTH = 0.8
/** Насколько быстро гаснет за краем кадра, в долях полукадра. */
const FADE_BEYOND = 1.5
/** Дальше этого за краем — не запускать вовсе, узлы не бесплатны. */
const SILENT_BEYOND = 3
/** Одновременных голосов не больше — толпа не должна класть звук. */
const MAX_VOICES = 24

/** Крашеный шум на секунду: одного буфера хватает всем, стартуем с разных мест. */
const NOISE_S = 1

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

export class Audio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private voices = 0
  private readonly inverse = new THREE.Matrix4()
  private halfW = 1
  private halfH = 1
  private readonly p = new THREE.Vector3()

  constructor() {
    const unlock = (): void => {
      this.ensure()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }

  private ensure(): void {
    if (this.ctx !== null) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctor === undefined) return
    const ctx = new Ctor()
    // Компрессор — чтобы залп из пяти стволов не клипал, а сжимался.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 12
    comp.ratio.value = 6
    comp.attack.value = 0.002
    comp.release.value = 0.12
    const master = ctx.createGain()
    master.gain.value = 0.7
    master.connect(comp).connect(ctx.destination)

    const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_S), ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    this.ctx = ctx
    this.master = master
    this.noise = noise
  }

  /** Раз в кадр: откуда смотрим. По этому считается стерео и затухание. */
  frame(camera: THREE.OrthographicCamera): void {
    this.inverse.copy(camera.matrixWorldInverse)
    this.halfW = camera.right
    this.halfH = camera.top
  }

  /**
   * Место в кадре → панорама и громкость; null — слишком далеко за краем.
   * Ортокамера: x/y в её системе и есть положение на экране.
   */
  private locate(x: number, z: number): { pan: number; gain: number } | null {
    this.p.set(x, 0, z).applyMatrix4(this.inverse)
    const nx = this.p.x / this.halfW
    const ny = this.p.y / this.halfH
    const out = Math.max(Math.abs(nx), Math.abs(ny)) - 1
    if (out > SILENT_BEYOND) return null
    const gain = out <= 0 ? 1 : Math.max(0, 1 - out / FADE_BEYOND)
    if (gain <= 0) return null
    return { pan: Math.max(-1, Math.min(1, nx)) * PAN_WIDTH, gain }
  }

  /** Выход одного голоса: панорама → громкость места → мастер. Считает голоса. */
  private voice(ctx: AudioContext, pan: number, gain: number, duration: number): AudioNode | null {
    if (this.master === null || this.voices >= MAX_VOICES) return null
    const g = ctx.createGain()
    g.gain.value = gain
    let head: AudioNode = g
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner()
      panner.pan.value = pan
      g.connect(panner)
      head = panner
    }
    head.connect(this.master)
    this.voices++
    setTimeout(() => {
      this.voices--
      head.disconnect()
    }, duration * 1000 + 50)
    return g
  }

  /** Шумовой всплеск через полосовой фильтр, спад экспонентой. */
  private burst(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    q: number,
    peak: number,
    decay: number,
  ): void {
    if (this.noise === null) return
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loopStart = 0
    src.loopEnd = NOISE_S
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = freq
    filter.Q.value = q
    const env = ctx.createGain()
    env.gain.setValueAtTime(peak, at)
    env.gain.exponentialRampToValueAtTime(0.001, at + decay)
    src.connect(filter).connect(env).connect(out)
    src.start(at, rand(0, NOISE_S))
    src.stop(at + decay + 0.02)
  }

  /** Низкий удар: синус, съезжающий по частоте, — вес без грохота. */
  private thump(ctx: AudioContext, out: AudioNode, at: number, from: number, to: number, peak: number, decay: number): void {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(from, at)
    osc.frequency.exponentialRampToValueAtTime(to, at + decay)
    const env = ctx.createGain()
    env.gain.setValueAtTime(peak, at)
    env.gain.exponentialRampToValueAtTime(0.001, at + decay)
    osc.connect(env).connect(out)
    osc.start(at)
    osc.stop(at + decay + 0.02)
  }

  /**
   * Шаг. `weight` — тяжесть: кот на лапах ~0.5, человек в ботинках 1.
   * Тише и выше для лёгких; чуть случайная высота — чтобы не «тик-тик-тик».
   */
  step(x: number, z: number, weight = 1): void {
    const ctx = this.ctx
    if (ctx === null || ctx.state !== 'running') return
    const where = this.locate(x, z)
    if (where === null) return
    const decay = rand(0.05, 0.08)
    const out = this.voice(ctx, where.pan, where.gain * 0.25 * (0.5 + weight * 0.5), decay + 0.1)
    if (out === null) return
    const at = ctx.currentTime
    const pitch = rand(0.9, 1.1) / (0.6 + weight * 0.4)
    this.burst(ctx, out, at, 700 * pitch, 1.2, 0.9, decay)
    this.burst(ctx, out, at, 2200 * pitch, 0.7, 0.25, decay * 0.5)
    if (weight >= 0.75) this.thump(ctx, out, at, 110, 55, 0.6, 0.09)
  }

  /**
   * Выстрел из винтовки: щелчок, полоса шума-«треска» и низкий удар с
   * коротким хвостом — эхо двора, а не открытого поля.
   */
  shot(x: number, z: number): void {
    const ctx = this.ctx
    if (ctx === null || ctx.state !== 'running') return
    const where = this.locate(x, z)
    if (where === null) return
    const out = this.voice(ctx, where.pan, where.gain, 0.5)
    if (out === null) return
    const at = ctx.currentTime
    const pitch = rand(0.92, 1.08)
    this.burst(ctx, out, at, 3200 * pitch, 0.5, 1.0, 0.03)
    this.burst(ctx, out, at, 1400 * pitch, 0.8, 0.8, 0.12)
    this.burst(ctx, out, at + 0.01, 420 * pitch, 1.0, 0.5, 0.28)
    this.thump(ctx, out, at, 160, 45, 0.9, 0.16)
  }
}

/** Один на страницу: контекстов у браузера ограниченно, а слушатель один. */
export const audio = new Audio()
