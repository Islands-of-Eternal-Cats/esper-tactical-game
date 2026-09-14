/**
 * Знаки над головой: глифы рисуются на канвасе при первом обращении.
 *
 * Ассетов нет — как у градиента неба: это не текстура, а нарисованная
 * кодом форма. Одна текстура на знак, общая для всех юнитов.
 */

import * as THREE from 'three'
import type { UnitSign } from '../shared/protocol'
import { PALETTE } from './palette'

const SIZE = 64

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** Глиф — линии в квадрате 0..1; подложка и обводка — общие. */
function draw(sign: UnitSign, ctx: CanvasRenderingContext2D): void {
  const s = SIZE
  const c = s / 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s * 0.09
  ctx.strokeStyle = hex(sign === 'pinned' ? PALETTE.zone : PALETTE.select)
  ctx.fillStyle = ctx.strokeStyle
  ctx.beginPath()
  switch (sign) {
    case 'pinned':
      // Стрелка вниз, упёртая в черту: прижат.
      ctx.moveTo(c, s * 0.2)
      ctx.lineTo(c, s * 0.6)
      ctx.moveTo(s * 0.34, s * 0.46)
      ctx.lineTo(c, s * 0.62)
      ctx.lineTo(s * 0.66, s * 0.46)
      ctx.moveTo(s * 0.26, s * 0.78)
      ctx.lineTo(s * 0.74, s * 0.78)
      break
    case 'seek':
      // Щит: ищет укрытие.
      ctx.moveTo(c, s * 0.18)
      ctx.lineTo(s * 0.76, s * 0.3)
      ctx.quadraticCurveTo(s * 0.76, s * 0.66, c, s * 0.84)
      ctx.quadraticCurveTo(s * 0.24, s * 0.66, s * 0.24, s * 0.3)
      ctx.closePath()
      break
    case 'reload':
      // Дуга со стрелкой: перезарядка.
      ctx.arc(c, c, s * 0.26, -Math.PI * 0.35, Math.PI * 1.2)
      ctx.moveTo(s * 0.74, s * 0.2)
      ctx.lineTo(s * 0.72, s * 0.4)
      ctx.lineTo(s * 0.54, s * 0.34)
      break
    case 'far':
      // Прицел, перечёркнутый: цель вне дальности.
      ctx.arc(c, c, s * 0.24, 0, Math.PI * 2)
      ctx.moveTo(c, s * 0.14)
      ctx.lineTo(c, s * 0.34)
      ctx.moveTo(c, s * 0.66)
      ctx.lineTo(c, s * 0.86)
      ctx.moveTo(s * 0.14, c)
      ctx.lineTo(s * 0.34, c)
      ctx.moveTo(s * 0.66, c)
      ctx.lineTo(s * 0.86, c)
      ctx.moveTo(s * 0.22, s * 0.78)
      ctx.lineTo(s * 0.78, s * 0.22)
      break
    case 'stuck':
      ctx.moveTo(s * 0.28, s * 0.28)
      ctx.lineTo(s * 0.72, s * 0.72)
      ctx.moveTo(s * 0.72, s * 0.28)
      ctx.lineTo(s * 0.28, s * 0.72)
      break
    case 'yield':
      ctx.moveTo(s * 0.38, s * 0.26)
      ctx.lineTo(s * 0.38, s * 0.74)
      ctx.moveTo(s * 0.62, s * 0.26)
      ctx.lineTo(s * 0.62, s * 0.74)
      break
  }
  ctx.stroke()
}

export class Signs {
  private readonly materials = new Map<UnitSign, THREE.MeshBasicMaterial>()

  material(sign: UnitSign): THREE.MeshBasicMaterial {
    let m = this.materials.get(sign)
    if (m !== undefined) return m
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const ctx = canvas.getContext('2d')!
    // Подложка: тёмный диск, чтобы светлый глиф читался на любой стене.
    ctx.fillStyle = 'rgba(10, 12, 15, .78)'
    ctx.beginPath()
    ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.46, 0, Math.PI * 2)
    ctx.fill()
    draw(sign, ctx)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    m = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    this.materials.set(sign, m)
    return m
  }

  dispose(): void {
    for (const m of this.materials.values()) {
      m.map?.dispose()
      m.dispose()
    }
    this.materials.clear()
  }
}
