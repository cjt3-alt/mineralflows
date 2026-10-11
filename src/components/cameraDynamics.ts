/**
 * The rules for how the globe camera responds to people, kept out of the
 * component so they can be tested without WebGL. The principle behind all of
 * them: the camera only moves when the viewer moves it, or explicitly asks to
 * go somewhere.
 */

/** globe.gl's vertical field of view, in degrees. */
export const CAMERA_FOV_DEGREES = 50

/** Closest zoom, as altitude in globe radii: roughly one country fills the view. */
export const MIN_ALTITUDE = 0.25
/** Furthest zoom, as a multiple of the altitude that just frames the globe. */
export const MAX_ALTITUDE_FACTOR = 1.6

/** Idle time after the last interaction before the globe starts turning on its own. */
export const IDLE_RESUME_MS = 15_000

/** Smoothing: the fraction of the remaining motion applied each frame. */
export const DAMPING = 0.14

/**
 * How much faster than "grab" a drag turns the globe. Exactly 1 keeps the
 * point under the finger under the finger near the centre of the globe;
 * slightly above feels right once damping adds its short glide.
 */
export const GRAB_GAIN = 1.5

/** Zoom step for the buttons, keyboard and double-click: altitude multiplier. */
export const ZOOM_STEP = 0.65

/**
 * OrbitControls turns the camera by 2π × (pixels dragged / canvas height) ×
 * rotateSpeed. Near the centre of a sphere of radius 1 seen from altitude a,
 * one radian of rotation moves the surface (H / 2) / tan(fov / 2) / a pixels.
 * Solving for the speed that makes the two equal gives a speed proportional
 * to altitude, independent of canvas size — which is why the drag needs
 * re-tuning on every zoom, and why a fixed speed felt sluggish zoomed in and
 * twitchy zoomed out.
 */
export function grabRotateSpeed(altitude: number, gain = GRAB_GAIN): number {
  const halfFov = ((CAMERA_FOV_DEGREES / 2) * Math.PI) / 180
  const speed = (Math.tan(halfFov) * Math.max(0, altitude) * gain) / Math.PI
  return Math.min(1.5, Math.max(0.03, speed))
}

/**
 * The altitude at which the globe fills `fill` of the narrower viewport axis.
 * Used for the first frame, the home button, and the zoom-out limit.
 */
export function framingAltitude(width: number, height: number, fill = 0.8): number {
  if (width <= 0 || height <= 0) return 2.4
  const halfVertical = ((CAMERA_FOV_DEGREES / 2) * Math.PI) / 180
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * (width / height))
  const half = Math.min(halfVertical, halfHorizontal)
  return 1 / Math.sin(Math.atan(fill * Math.tan(half))) - 1
}

export function maxAltitude(width: number, height: number): number {
  return framingAltitude(width, height) * MAX_ALTITUDE_FACTOR
}

export function clampAltitude(altitude: number, width: number, height: number): number {
  return Math.min(maxAltitude(width, height), Math.max(MIN_ALTITUDE, altitude))
}

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

/**
 * Auto-rotate is a screensaver: on only when nothing is being looked at and
 * nobody has touched the globe for a while. Before the first interaction it is
 * on, so the page has life when it opens.
 */
export function shouldAutoRotate(state: {
  now: number
  lastInteraction: number | null
  pointerDown: boolean
  busy: boolean
  reducedMotion: boolean
}): boolean {
  if (state.reducedMotion || state.pointerDown || state.busy) return false
  return state.lastInteraction === null || state.now - state.lastInteraction >= IDLE_RESUME_MS
}
