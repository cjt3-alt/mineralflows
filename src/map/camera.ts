import type { LngLat } from './arcGeometry.ts'

export type Lens = 'mined' | 'refined' | 'trade'

/**
 * Where the camera rests for each lens, so the picture's subject is on screen
 * when the lens changes: the Americas and Central Africa for what is mined,
 * East Asia for what is refined, the whole sweep of Eurasia and the oceans
 * for trade. All of them are wide enough that you can drag up and down as well
 * as across.
 */
const CENTER: Record<Lens, LngLat> = {
  mined: [-25, 6],
  refined: [95, 30],
  trade: [25, 22],
}
const BOOST: Record<Lens, number> = { mined: 0, refined: 0.8, trade: 0.15 }

/** The furthest out the map goes: the world just fills the width, so there is never a blank band at the sides. */
export function minZoomFor(width: number): number {
  return Math.max(0.5, Math.min(1.3, Math.log2(Math.max(width, 200) / 512)))
}

export function lensView(lens: Lens, usableWidth: number): { center: LngLat; zoom: number } {
  const base = Math.log2((1.3 * Math.max(usableWidth, 200)) / 512)
  const floor = minZoomFor(usableWidth) + 0.25
  const zoom = Math.min(3.4, Math.max(floor, base)) + BOOST[lens]
  return { center: CENTER[lens], zoom }
}
