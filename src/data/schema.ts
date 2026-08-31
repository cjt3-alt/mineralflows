import { z } from 'zod'

/**
 * Runtime schemas for every file in public/data/, plus the TS types inferred
 * from them. This module is the single source of truth for the data contract:
 * the ETL writes to it, the loader validates against it, and the components
 * consume the inferred types. Nothing downstream redefines these shapes.
 */

/* ---------------------------------------------------------------- primitives */

export const STAGES = ['mine', 'process', 'refine'] as const
export const StageSchema = z.enum(STAGES)
export type Stage = z.infer<typeof StageSchema>

export const CONFIDENCE_LEVELS = ['high', 'low'] as const
export const ConfidenceSchema = z.enum(CONFIDENCE_LEVELS)
export type Confidence = z.infer<typeof ConfidenceSchema>

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')

const IdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'must be a lowercase id (kebab-case, dots allowed)')

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour')

const Iso3Schema = z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase ISO 3166-1 code')

const HsCodeSchema = z.string().regex(/^\d{6}$/, 'HS codes are 6 digits, as a string')

const YearSchema = z.number().int().min(1900).max(2100)

const IsoDateSchema = z.iso.date()

/* ----------------------------------------------------------------- minerals */

/**
 * One HS code, tied to the supply-chain stage its trade represents.
 *
 * Codes with `active: false` are carried deliberately: they are real codes for
 * this mineral that v1 does not turn into flows (copper semis, alloys,
 * batteries, lithium organics). Keeping them here means switching one on later
 * is a data edit, not a code change.
 */
export const TradeCodeSchema = z.object({
  hs_code: HsCodeSchema,
  stage: StageSchema,
  label: z.string().min(1),
  active: z.boolean(),
})
export type TradeCode = z.infer<typeof TradeCodeSchema>

export const MineralSchema = z
  .object({
    id: SlugSchema,
    name: z.string().min(1),
    /**
     * Flat list of the active HS codes. Mirrors `trade_codes`; kept because
     * most consumers want a membership test, not the stage mapping. The
     * refinement below stops the two drifting apart.
     */
    hs_codes: z.array(HsCodeSchema),
    trade_codes: z.array(TradeCodeSchema).min(1),
    usgs_commodity_code: z.string().min(1),
    color: HexColorSchema,
    glow_intensity: z.number().min(0).max(1),
    sort_order: z.number().int(),
    active: z.boolean(),
  })
  .superRefine((mineral, ctx) => {
    const active = mineral.trade_codes
      .filter((c) => c.active)
      .map((c) => c.hs_code)
      .sort()
    const flat = [...mineral.hs_codes].sort()
    if (active.join(',') !== flat.join(',')) {
      ctx.addIssue({
        code: 'custom',
        path: ['hs_codes'],
        message:
          'hs_codes must list exactly the active trade_codes. Got [' +
          flat.join(', ') +
          '], expected [' +
          active.join(', ') +
          '].',
      })
    }
    const seen = new Set<string>()
    for (const code of mineral.trade_codes) {
      if (seen.has(code.hs_code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['trade_codes'],
          message: 'duplicate HS code ' + code.hs_code,
        })
      }
      seen.add(code.hs_code)
    }
  })
export type Mineral = z.infer<typeof MineralSchema>

export const MineralsFileSchema = z.array(MineralSchema).min(1)

/* --------------------------------------------------------------- facilities */

export const FacilityPropertiesSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  mineral_ids: z.array(SlugSchema).min(1),
  stage: StageSchema,
  country_iso3: Iso3Schema,
  operator: z.string().min(1).nullable(),
  capacity_tonnes_per_year: z.number().positive().nullable(),
  source: z.string().min(1),
  source_url: z.url().nullable(),
  confidence: ConfidenceSchema,
  last_updated: IsoDateSchema,
})
export type FacilityProperties = z.infer<typeof FacilityPropertiesSchema>

/**
 * GeoJSON coordinate order is [longitude, latitude]. Getting it backwards puts
 * Chile in the Indian Ocean, so the bounds are checked rather than assumed.
 */
export const PointGeometrySchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
})

export const FacilityFeatureSchema = z.object({
  type: z.literal('Feature'),
  geometry: PointGeometrySchema,
  properties: FacilityPropertiesSchema,
})
export type FacilityFeature = z.infer<typeof FacilityFeatureSchema>

export const FacilityCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(FacilityFeatureSchema),
})
export type FacilityCollection = z.infer<typeof FacilityCollectionSchema>

/* -------------------------------------------------------------------- flows */

export const FlowSchema = z
  .object({
    id: IdSchema,
    from_iso3: Iso3Schema,
    to_iso3: Iso3Schema,
    mineral_id: SlugSchema,
    year: YearSchema,
    value_usd: z.number().nonnegative().nullable(),
    volume_tonnes: z.number().nonnegative().nullable(),
    stage_from: StageSchema,
    stage_to: StageSchema,
    /**
     * A source of "estimated" means value_usd is volume x price, not a traded
     * value. The UI must never let the two look alike.
     */
    source: z.string().min(1),
    confidence: ConfidenceSchema,
  })
  .superRefine((flow, ctx) => {
    if (flow.value_usd === null && flow.volume_tonnes === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a flow needs at least one of value_usd or volume_tonnes',
      })
    }
    if (flow.from_iso3 === flow.to_iso3) {
      ctx.addIssue({
        code: 'custom',
        path: ['to_iso3'],
        message: 'self-flow ' + flow.from_iso3 + ' to ' + flow.to_iso3 + ' has no arc to draw',
      })
    }
    if (flow.source === 'estimated' && flow.volume_tonnes === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['volume_tonnes'],
        message: 'an estimated flow must carry the volume its value was derived from',
      })
    }
  })
export type Flow = z.infer<typeof FlowSchema>

export const FlowsFileSchema = z.array(FlowSchema)

/* ------------------------------------------------------------------- prices */

export const PriceSchema = z.object({
  mineral_id: SlugSchema,
  year: YearSchema,
  avg_price_usd_per_tonne: z.number().positive(),
  source: z.string().min(1),
  source_url: z.url(),
})
export type Price = z.infer<typeof PriceSchema>

export const PricesFileSchema = z.array(PriceSchema)

/* ---------------------------------------------------------------- countries */

export const CountrySchema = z.object({
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})
export type Country = z.infer<typeof CountrySchema>

/**
 * Flat `iso3 -> centroid` map, per the contract. There is nowhere in that shape
 * to record provenance, so the centroid source lives in the `sources` array of
 * meta.json and in the README instead.
 */
export const CountriesFileSchema = z.record(Iso3Schema, CountrySchema)
export type CountriesFile = z.infer<typeof CountriesFileSchema>

/* --------------------------------------------------------------------- meta */

export const SourceRefSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  url: z.url().nullable(),
  /** Vintage of the data itself, e.g. "2024" or "2024-Q3". Not the build date. */
  vintage: z.string().min(1),
  retrieved_at: IsoDateSchema,
  coverage: z.string().min(1),
})
export type SourceRef = z.infer<typeof SourceRefSchema>

export const MetaSchema = z.object({
  generated_at: z.iso.datetime(),
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver, e.g. 1.0.0'),
  sources: z.array(SourceRefSchema).min(1),
})
export type Meta = z.infer<typeof MetaSchema>

/* --------------------------------------------------------------- validation */

export class DataValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: readonly z.core.$ZodIssue[],
    readonly offending: unknown,
  ) {
    super(
      file +
        ' failed validation:\n' +
        issues
          .map((i) => '  - at ' + (i.path.length ? i.path.join('.') : '(root)') + ': ' + i.message)
          .join('\n') +
        '\n\nOffending record:\n' +
        JSON.stringify(offending, null, 2).slice(0, 2000),
    )
    this.name = 'DataValidationError'
  }
}

/**
 * Parse or throw, loudly, naming the file and printing the record that failed.
 * Silent coercion of bad data is worse than a crash, so there is no lenient mode.
 */
export function parseFile<T extends z.ZodType>(file: string, schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw)
  if (result.success) return result.data

  // Narrow to the element that failed so the error shows one bad record rather
  // than the whole file.
  const firstIssue = result.error.issues[0]
  let offending: unknown = raw
  if (firstIssue && Array.isArray(raw) && typeof firstIssue.path[0] === 'number') {
    offending = raw[firstIssue.path[0]]
  }
  throw new DataValidationError(file, result.error.issues, offending)
}
