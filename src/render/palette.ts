/**
 * Палитра грейбокса.
 *
 * Полный художественный проход — шаг 7. Здесь ровно столько цвета, чтобы двор
 * читался: грязный индустриальный нуар, холодные серо-синие поверхности.
 * Красный не используется вообще: он зарезервирован строго для угрозы.
 */
export const PALETTE = {
  background: 0x14171c,
  floor: 0x2b313a,
  floorEdge: 0x1b1f26,
  wall: 0x3b434f,
  wallGhostEdge: 0x93a4ba,
  wallTop: 0x49525f,
  container: 0x35505c,
  pile: 0x6b6357,
  rusty: 0xc2703a,
  rustyHead: 0xd98b4f,
  zone: 0xe0a54a,
} as const
