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

/** How far from a focused country toward its trade partners the camera aims. */
export const FOCUS_LEAN = 0.33
/**
 * Never lean further than this, in degrees, so the country stays well inside
 * the view even when its partners are on the far side of the world (Chile's
 * are about 170 degrees away).
 */
export const FOCUS_LEAN_MAX_DEGREES = 40

type LatLng = { lat: number; lng: number }

function toVec({ lat, lng }: LatLng): [number, number, number] {
  const phi = (lat * Math.PI) / 180
  const lambda = (lng * Math.PI) / 180
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)]
}

function toLatLng([x, y, z]: [number, number, number]): LatLng {
  const len = Math.hypot(x, y, z)
  return {
    lat: (Math.asin(Math.max(-1, Math.min(1, z / len))) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  }
}

/**
 * Where to point the camera when flying to a country. Aiming straight down at
 * it puts the camera in the plane of every arc that starts there, and a
 * great-circle arc seen from inside its own plane projects to a straight line,
 * so the arcs read as flat spikes. Leaning part of the way toward the
 * value-weighted centre of its partners keeps the country on screen, shows
 * the arcs' curve, and faces the view toward where the material goes.
 *
 * The lean is capped at FOCUS_LEAN_MAX_DEGREES. Falls back to the country itself when there are no partners, or when they
 * balance out on opposite sides of the globe.
 */
export function aimToward(country: LatLng, partners: (LatLng & { weight: number })[], lean = FOCUS_LEAN): LatLng {
  const c = toVec(country)
  const sum: [number, number, number] = [0, 0, 0]
  for (const p of partners) {
    if (!(p.weight > 0)) continue
    const v = toVec(p)
    sum[0] += v[0] * p.weight
    sum[1] += v[1] * p.weight
    sum[2] += v[2] * p.weight
  }
  const len = Math.hypot(...sum)
  const total = partners.reduce((n, p) => n + (p.weight > 0 ? p.weight : 0), 0)
  if (total === 0 || len < 0.15 * total) return { ...country }
  const target: [number, number, number] = [sum[0] / len, sum[1] / len, sum[2] / len]

  // Spherical interpolation from the country toward the partners' centre.
  const dot = Math.max(-1, Math.min(1, c[0] * target[0] + c[1] * target[1] + c[2] * target[2]))
  const angle = Math.acos(dot)
  if (angle < 1e-6 || Math.PI - angle < 1e-3) return { ...country }
  const t = Math.min(lean, (FOCUS_LEAN_MAX_DEGREES * Math.PI) / 180 / angle)
  const wa = Math.sin((1 - t) * angle) / Math.sin(angle)
  const wb = Math.sin(t * angle) / Math.sin(angle)
  return toLatLng([c[0] * wa + target[0] * wb, c[1] * wa + target[1] * wb, c[2] * wa + target[2] * wb])
}
