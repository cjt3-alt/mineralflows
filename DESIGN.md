# MineralFlows design rules

This file exists so the site stays deliberate. Most of what makes a page look
generic is a default nobody chose: the indigo gradient, the one-weight sans, the
rounded glass card, the glow. Before changing anything visual, read this, and
run the checklist at the bottom against what you made.

## The idea

One picture: **the gap between where a mineral is mined and where it is
refined.** The logomark is that gap (a ring, joined to a disc). The headline
view morphs between the two. Everything else serves it, and anything that does
not is cut.

The register is an industrial, defence and energy company's site, not a sci-fi
dashboard: flat colour, hairlines, plates, big type, quiet chrome. With a small
amount of the AI-lab voice: a serif for sentences, plain declarative copy.

## Colour

Warm graphite ground. Two data hues taken from the metal itself, and one
accent that is never data. Defined in `src/styles/tokens.css`, derived and
validated in `src/styles/palette.ts`.

| Role | Colour | Meaning |
| --- | --- | --- |
| Ore | verdigris `#35a395` | the green of oxidised copper and of malachite; rock in the ground |
| Heat | gold `#d9b24c` | the smelter, between ore and metal |
| Metal | copper `#d07a45` (glow `#e8905a`, tint `#f0b48a`) | refined |
| Accent | champagne `#d9b672` | what you are pointing at: hover, focus, selection. Never a data colour |
| Alert | `#ff7a6b` | caution, estimates, and the "switched off" state. Nothing else |

Rules: one signal colour at a time; no gradients except the ore-to-metal ramp,
which carries meaning; no purple, no blue, no neon. Both data hues pass the
dataviz palette validator on the surface (lightness band, chroma, protan and
deutan separation, normal-vision floor, 3:1 contrast) and every text token is
AA. Colour is never the only carrier: mined is a hollow ring, refined a solid
disc, and values are labelled.

## Type

Three faces, each with one job. Self-hosted (`@fontsource-variable`), Latin
subsets preloaded.

- **Archivo**, variable on weight and width. Headlines are set wide and tight
  (`font-stretch: 114%`, `-0.028em`); body and UI at normal width.
- **Martian Mono**, microtype only: labels, buttons, units, the eyebrow. Never
  a paragraph. Never tracked-out all-caps decoration for its own sake.
- **Newsreader**, a text serif, for the sentences a person reads for meaning:
  the line under the headline.

Headlines use `clamp()` so they scale with the viewport rather than jumping at
breakpoints. Numbers are tabular. Headings `text-wrap-style: balance`, copy
`pretty`. (Use `text-wrap-style`, not the `text-wrap` shorthand: the shorthand
resets the wrap mode and silently breaks `truncate`.)

## Shape and layout

- Square. `--mf-radius: 0`. No rounded cards.
- **Plates**, not cards: flat fill, 1px hairline, one chamfered corner. No
  blur, no shadow, no gradient, no inner glow. (`.panel` in `base.css`.)
- One grid: 32px side margins and 28px below the nav on desktop. A panel's top
  edge aligns with the headline's eyebrow. If something floats at an arbitrary
  offset, it is wrong.
- One navigation. A floating button that duplicates a nav link gets deleted.
- No fake chrome. No clocks, "system online" lights, classification banners,
  reticle corners. They imply things that are not true and read as costume.

## Motion

Things arrive; they do not bounce or loop. One decisive ease-out
(`--mf-ease-out`) for arrivals, one symmetric ease for morphs. Small distances
(10 to 16px), short stagger (80ms steps), 0.8s. Switching views cross-fades via
the View Transitions API where supported. Everything is off under
`prefers-reduced-motion`; the chokepoint then starts where the viewer puts it.
Nothing pulses.

## Copy

Say the specific thing. "China refines 48% of the world's copper. It mines 8%."
beats any sentence containing "unlock", "elevate", "seamless" or "powerful".
Numbers carry their source and their caveat nearby. Sentence case. Plain verbs.

## Data honesty (it is part of the design)

- Estimates are labelled. Lower bounds are called lower bounds.
- Every figure on screen can be downloaded (CSV) and cited.
- A feature that is arithmetic says it is arithmetic ("switch a country off").
- Source and vintage are always one click away.

## Checklist: does it look vibecoded?

Run this against any screen you change. Any "yes" is a bug.

- [ ] A purple, indigo or blue-to-purple gradient anywhere?
- [ ] Gradient text, or a glow on text?
- [ ] Inter, or one typeface at one width doing every job?
- [ ] Rounded-2xl cards with a soft shadow? Frosted glass? Backdrop blur?
- [ ] An icon in a rounded square? An emoji used as an icon?
- [ ] A centred hero, then three equal feature cards?
- [ ] A pill badge above the headline?
- [ ] A shadcn, Tailwind or Radix default left untouched?
- [ ] A floating element at an offset nobody chose?
- [ ] Something that animates forever?
- [ ] Copy that could belong to any company?
- [ ] A status light, clock or banner that says nothing true?
- [ ] Two different ways to do the same navigation?

Then run `axe` against the page and look at it at 375, 768 and 1440 wide.

## What is deliberately not here (yet)

Photography or satellite imagery, a long-form "paper" method page, light mode.
Each is a considered next step, not an oversight.
