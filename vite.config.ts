import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SITE_URL = 'https://cjt3-alt.github.io/mineralflows/'

const dataPath = (file: string) => fileURLToPath(new URL('./public/data/' + file, import.meta.url))
const readJson = <T,>(file: string): T => JSON.parse(readFileSync(dataPath(file), 'utf8')) as T
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

interface ProductionRow {
  mineral_id: string
  stage: string
  year: number
  world_total: number
  by_country: Record<string, number>
  estimated: boolean
}

/**
 * The page title, description and link-preview tags state the finding, and the
 * finding is computed here from public/data/production.json at build time, so a
 * data refresh updates what a link preview says and the two cannot disagree.
 */
function shareMeta(): Plugin {
  return {
    name: 'mineralflows-share-meta',
    transformIndexHtml(html) {
      let title = 'MineralFlows: where critical minerals are mined and where they are refined'
      let description =
        'Where critical minerals are mined versus where they are refined, country by country, built from public data.'
      let headline = 'Where critical minerals are dug, and where they become metal.'
      let eyebrow = 'Critical minerals supply chain monitor'
      try {
        const production = readJson<ProductionRow[]>('production.json')
        const minerals = readJson<{ id: string; name: string; active: boolean; sort_order: number }[]>('minerals.json')
        const countries = readJson<Record<string, { name: string }>>('countries.json')
        for (const mineral of minerals.filter((m) => m.active).sort((a, b) => a.sort_order - b.sort_order)) {
          const years = production.filter((p) => p.mineral_id === mineral.id).map((p) => p.year)
          const year = Math.max(...years)
          const mine = production.find((p) => p.mineral_id === mineral.id && p.stage === 'mine' && p.year === year)
          const refine = production.find((p) => p.mineral_id === mineral.id && p.stage === 'refine' && p.year === year)
          if (!mine || !refine) continue
          const [iso3] = Object.entries(refine.by_country).sort((a, b) => b[1] - a[1])[0] ?? []
          if (!iso3) continue
          const pct = (row: ProductionRow) => Math.round(((row.by_country[iso3] ?? 0) / row.world_total) * 100)
          const who = countries[iso3]?.name ?? iso3
          const name = mineral.name.toLowerCase()
          headline = `${who} refines ${pct(refine)}% of the world's ${name}. It mines ${pct(mine)}%.`
          title = `${headline} · MineralFlows`
          description =
            `Where ${name} is dug versus where it becomes metal, by country (USGS, ${year}${mine.estimated ? ' estimate' : ''}). ` +
            'Drag from mine to refinery, switch a country off, and see the gap.'
          eyebrow = `${mineral.name} · ${year}${mine.estimated ? ' est.' : ''}`
          break
        }
      } catch {
        // A missing data file should not break the build; the generic text above stands.
      }
      const image = existsSync(fileURLToPath(new URL('./public/og.png', import.meta.url)))
      const social = [
        `<link rel="canonical" href="${SITE_URL}" />`,
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="MineralFlows" />',
        `<meta property="og:url" content="${SITE_URL}" />`,
        `<meta property="og:title" content="${esc(title)}" />`,
        `<meta property="og:description" content="${esc(description)}" />`,
        `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
        `<meta name="twitter:title" content="${esc(title)}" />`,
        `<meta name="twitter:description" content="${esc(description)}" />`,
        ...(image
          ? [
              `<meta property="og:image" content="${SITE_URL}og.png" />`,
              '<meta property="og:image:width" content="1200" />',
              '<meta property="og:image:height" content="630" />',
              `<meta name="twitter:image" content="${SITE_URL}og.png" />`,
            ]
          : []),
      ].join('\n    ')
      return html
        .replace('%MF_TITLE%', esc(title))
        .replaceAll('%MF_DESC%', esc(description))
        .replace('%MF_HEADLINE%', esc(headline))
        .replace('%MF_EYEBROW%', esc(eyebrow))
        .replace('%MF_SOCIAL%', social)
    },
  }
}

/**
 * Preload the Latin subsets of the three faces so the first paint is
 * set in them rather than swapped a beat later. Build only: in dev there is no
 * bundle, and the browser fetches fonts as it needs them.
 */
function fontPreload(): Plugin {
  return {
    name: 'mineralflows-font-preload',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const preloads = Object.keys(ctx.bundle ?? {})
          .filter((f) => /(archivo-latin-wdth|martian-mono-latin-wdth|newsreader-latin-wght)-normal.*\.woff2$/.test(f))
          .map((f) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="./${f}" />`)
          .join('\n    ')
        return preloads ? html.replace('</head>', `    ${preloads}\n  </head>`) : html
      },
    },
  }
}

// Relative base so one build works in all three places we serve it from:
// the project page at <user>.github.io/mineralflows/, the apex domain once
// DNS is cut over, and a plain `file://` / static file server.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), shareMeta(), fontPreload()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The largest chunk is Natural Earth's 1:50m country outlines (~760 kB raw,
    // ~240 kB gzipped), which the map fetches only when zoomed in. It is data,
    // not code, so the default 500 kB warning would only ever flag it.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
})
