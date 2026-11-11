/**
 * The colour of the Chokepoint, in one place.
 *
 * Ore is verdigris, the green of oxidised copper and of malachite, copper's own
 * ore. Metal is copper. Between them sits the gold of the smelter's heat, so the
 * morph from mined to refined passes through the colour the metal actually goes
 * through: green rock, molten glow, bright metal.
 *
 * The two end colours are the validated pair. Run against the warm graphite
 * surface (#16120f) with the dataviz palette validator, `#35a395` and `#d07a45`
 * pass the dark-mode lightness band, chroma floor, protan/deutan separation
 * (worst pair ΔE 11.1), the normal-vision floor (20.8) and 3:1 contrast. The
 * glow stops are lighter tints of the same hues, used for light on dark, never
 * as the only carrier of meaning: shape (hollow versus filled) and direct labels
 * carry it too.
 *
 * The hues were chosen after the colour-harmony literature, which finds that
 * pair preference tracks how much people like each colour and the lightness
 * contrast between them, more than hue contrast; so both are mid-chroma, mid
 * lightness, on a warm near-black rather than a saturated blue.
 */

export type Rgb = [number, number, number]

export const ORE_HEX = '#35a395'
export const MOLTEN_HEX = '#d9b24c'
export const COPPER_HEX = '#d07a45'
export const COPPER_GLOW_HEX = '#e8905a'
export const COPPER_TINT_HEX = '#f0b48a'
export const ACCENT_HEX = '#d9b672'

export const hexToRgb = (hex: string): Rgb => {
  const v = hex.replace('#', '')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
export const css = (c: Rgb, alpha = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`

/* sRGB <-> OKLCH, so the blend between stops is even to the eye. */
const toLinear = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const fromLinear = (l: number) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, s)) * 255)
}

function toOklch([r, g, b]: Rgb): [number, number, number] {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180) / Math.PI]
}

function fromOklch([L, C, H]: [number, number, number]): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function blend(a: Rgb, b: Rgb, t: number): Rgb {
  const [l1, c1, h1] = toOklch(a)
  const [l2, c2, h2] = toOklch(b)
  // Shortest way round the hue wheel: teal to gold passes through green.
  let dh = h2 - h1
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  return fromOklch([lerp(l1, l2, t), lerp(c1, c2, t), h1 + dh * t])
}

const ORE: Rgb = hexToRgb('#3fb7a8')
const MOLTEN: Rgb = hexToRgb(MOLTEN_HEX)
const GLOW: Rgb = hexToRgb(COPPER_GLOW_HEX)

/** 0 is ore in the ground, 0.5 is the smelter, 1 is refined metal. */
export function toneAt(t: number): Rgb {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? blend(ORE, MOLTEN, x / 0.5) : blend(MOLTEN, GLOW, (x - 0.5) / 0.5)
}
