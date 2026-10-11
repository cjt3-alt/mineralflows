/**
 * Pointer rules shared by any map view: what counts as a tap and a double
 * tap. Kept out of the component so they can be tested without a canvas. A
 * gesture that is not a tap (a drag, a pinch, a slow press) must never select
 * anything or move the view on its own.
 */

/** A gesture only counts as a tap if it is quick, nearly still, and single-pointer. */
export const TAP_MAX_MS = 250
export const TAP_MAX_PX = 4

export interface Gesture {
  durationMs: number
  movedPx: number
  /** The most pointers that were down at once during the gesture. */
  maxPointers: number
}

export function isTap({ durationMs, movedPx, maxPointers }: Gesture): boolean {
  return maxPointers === 1 && durationMs <= TAP_MAX_MS && movedPx <= TAP_MAX_PX
}

/** Two taps this close in time and space are a double tap. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_PX = 24

export function isDoubleTap(
  previous: { at: number; x: number; y: number } | null,
  next: { at: number; x: number; y: number },
): boolean {
  if (!previous) return false
  return next.at - previous.at <= DOUBLE_TAP_MS && Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_TAP_PX
}
