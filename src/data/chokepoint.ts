import type { Dataset } from './load.ts'

/**
 * The model behind "The Chokepoint": where a mineral is dug versus where it is
 * refined into metal, country by country. Pure and DOM-free so the numbers the
 * story quotes are tested, not just drawn.
 *
 * Shares are a country's output over the source's own published world total,
 * so they sum to a little under 100% once the unlisted "other countries" are
 * left out. Concentration figures built from them are therefore lower bounds:
 * the unlisted remainder could only make the picture more even, never less.
 */

export interface CountryRow {
  iso3: string
  name: string
  /** Share of world mine output, 0..1. */
  mine: number
  /** Share of world refinery output, 0..1. */
  refine: number
}

export interface OreRoute {
  id: string
  from: string
  to: string
  valueUsd: number
  /** True when the importer's report was used because the exporter's was missing. */
  mirrored: boolean
}

export interface SiteDot {
  lon: number
  lat: number
  /** `mine` sites show in the mined view; `process` and `refine` in the refined one. */
  stage: 'mine' | 'process' | 'refine'
  lowConfidence: boolean
  iso3: string
}

export interface Concentration {
  /** Share held by the single largest country. */
  top1: number
  /** Share held by the three largest countries. */
  top3: number
  /** Herfindahl-Hirschman index on a 0..10,000 scale, listed countries only. */
  hhi: number
}

export interface ChokepointModel {
  mineralId: string
  mineralName: string
  year: number
  /** The newest USGS year is an estimate, and the story says so. */
  estimated: boolean
  sourceUrl: string
  /** World output at each stage, tonnes of contained metal. */
  mineTonnes: number
  refineTonnes: number
  rows: CountryRow[]
  /** The country with the largest refinery share. */
  leader: CountryRow
  mineConcentration: Concentration
  refineConcentration: Concentration
  ore: OreRoute[]
  sites: SiteDot[]
}

export function concentrationOf(shares: number[]): Concentration {
  const sorted = [...shares].sort((a, b) => b - a)
  const top = (n: number) => sorted.slice(0, n).reduce((a, b) => a + b, 0)
  return {
    top1: top(1),
    top3: top(3),
    hhi: Math.round(sorted.reduce((sum, s) => sum + (s * 100) ** 2, 0)),
  }
}

/** The newest year for which both a mine and a refinery table exist. */
function latestCommonYear(dataset: Dataset, mineralId: string): number | null {
  const years = (stage: 'mine' | 'refine') =>
    new Set(
      dataset.production
        .filter((p) => p.mineral_id === mineralId && p.stage === stage)
        .map((p) => p.year),
    )
  const mine = years('mine')
  const common = [...years('refine')].filter((y) => mine.has(y))
  return common.length > 0 ? Math.max(...common) : null
}

/** Whether the story can be told for this mineral at all. */
export function canTellStory(dataset: Dataset, mineralId: string): boolean {
  return latestCommonYear(dataset, mineralId) !== null
}

export function buildChokepoint(
  dataset: Dataset,
  mineralId: string,
  maxOreRoutes = 14,
): ChokepointModel | null {
  const year = latestCommonYear(dataset, mineralId)
  const mineral = dataset.mineralsById.get(mineralId)
  if (year === null || !mineral) return null

  const find = (stage: 'mine' | 'refine') =>
    dataset.production.find(
      (p) => p.mineral_id === mineralId && p.stage === stage && p.year === year,
    )
  const mine = find('mine')
  const refine = find('refine')
  if (!mine || !refine) return null

  const isos = new Set([...Object.keys(mine.by_country), ...Object.keys(refine.by_country)])
  const rows: CountryRow[] = [...isos]
    .map((iso3) => ({
      iso3,
      name: dataset.countries[iso3]?.name ?? iso3,
      mine: (mine.by_country[iso3] ?? 0) / mine.world_total,
      refine: (refine.by_country[iso3] ?? 0) / refine.world_total,
    }))
    .sort((a, b) => Math.max(b.mine, b.refine) - Math.max(a.mine, a.refine))

  const leader = [...rows].sort((a, b) => b.refine - a.refine)[0]
  if (!leader) return null

  // Ore and concentrate on the move: the leg between the mine and the smelter.
  const ore = dataset.flows
    .filter(
      (f) =>
        f.mineral_id === mineralId &&
        f.stage_from === 'mine' &&
        f.value_usd !== null &&
        f.value_usd > 0 &&
        f.from_iso3 in dataset.countries &&
        f.to_iso3 in dataset.countries,
    )
    .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0))
    .slice(0, maxOreRoutes)
    .map((f) => ({
      id: f.id,
      from: f.from_iso3,
      to: f.to_iso3,
      valueUsd: f.value_usd ?? 0,
      mirrored: f.confidence === 'low',
    }))

  const sites: SiteDot[] = dataset.facilities
    .filter((f) => f.properties.mineral_ids.includes(mineralId))
    .map((f) => ({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      stage: f.properties.stage,
      lowConfidence: f.properties.confidence === 'low',
      iso3: f.properties.country_iso3,
    }))

  return {
    mineralId,
    mineralName: mineral.name,
    year,
    estimated: mine.estimated || refine.estimated,
    sourceUrl: mine.source_url,
    mineTonnes: mine.world_total,
    refineTonnes: refine.world_total,
    rows,
    leader,
    mineConcentration: concentrationOf(rows.map((r) => r.mine)),
    refineConcentration: concentrationOf(rows.map((r) => r.refine)),
    ore,
    sites,
  }
}

/** A share as a whole percent, with "<1%" rather than a misleading 0%. */
export function formatShare(share: number): string {
  if (share <= 0) return '0%'
  const pct = share * 100
  return pct < 1 ? '<1%' : Math.round(pct) + '%'
}
