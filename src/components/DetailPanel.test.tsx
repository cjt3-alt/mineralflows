// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DetailPanel, type Selection } from './DetailPanel.tsx'
import type { ArcDatum, PointDatum } from '../data/derive.ts'
import type { Country, Mineral } from '../data/schema.ts'

/**
 * The two rules the brief is strictest about, held in place by tests:
 * an estimated value never appears without saying so, and a low-confidence
 * record never appears looking verified.
 */

afterEach(cleanup)

const copper: Mineral = {
  id: 'copper',
  name: 'Copper',
  hs_codes: ['260300'],
  trade_codes: [{ hs_code: '260300', stage: 'mine', label: 'Ores', active: true }],
  usgs_commodity_code: 'copper',
  color: '#ff7a45',
  glow_intensity: 0.9,
  sort_order: 1,
  active: true,
}
const mineralsById = new Map<string, Mineral>([['copper', copper]])
const countries: Record<string, Country> = {
  CHL: { name: 'Chile', lat: -35.7, lon: -71.4 },
  CHN: { name: 'China', lat: 35, lon: 103.9 },
}

function facilityPoint(over: Partial<PointDatum['facility']['properties']> = {}): PointDatum {
  return {
    id: 'escondida',
    lat: -24.2667,
    lng: -69.0667,
    color: '#ff7a45',
    radius: 0.45,
    confidence: over.confidence ?? 'high',
    facility: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-69.0667, -24.2667] },
      properties: {
        id: 'escondida',
        name: 'Escondida',
        mineral_ids: ['copper'],
        stage: 'mine',
        country_iso3: 'CHL',
        operator: 'BHP',
        capacity_tonnes_per_year: 1050000,
        source: 'seed',
        source_url: 'https://example.org/source',
        confidence: 'high',
        last_updated: '2026-08-31',
        ...over,
      },
    },
  }
}

function flowArc(estimated: boolean): ArcDatum {
  return {
    id: 'cu-chl-chn-2024',
    startLat: -35.7,
    startLng: -71.4,
    endLat: 35,
    endLng: 103.9,
    altitude: 0.3,
    width: 2,
    color: '#ff7a45',
    confidence: 'high',
    value: estimated
      ? {
          usd: 14720000000,
          estimated: true,
          derivedFrom: { volumeTonnes: 1600000, pricePerTonne: 9200, priceYear: 2024 },
        }
      : { usd: 3900000000, estimated: false, derivedFrom: null },
    flow: {
      id: 'cu-chl-chn-2024',
      from_iso3: 'CHL',
      to_iso3: 'CHN',
      mineral_id: 'copper',
      year: 2024,
      value_usd: estimated ? 14720000000 : 3900000000,
      volume_tonnes: 1600000,
      stage_from: 'mine',
      stage_to: 'process',
      source: estimated ? 'estimated' : 'seed',
      confidence: 'high',
    },
  }
}

function renderPanel(selection: Selection | null, onClose = vi.fn()) {
  render(
    <DetailPanel
      selection={selection}
      mineralsById={mineralsById}
      countries={countries}
      onClose={onClose}
    />,
  )
  return onClose
}

describe('DetailPanel', () => {
  it('renders nothing when there is no selection', () => {
    renderPanel(null)
    expect(screen.queryByLabelText('Detail')).toBeNull()
  })

  it('shows facility detail with its country and operator', () => {
    renderPanel({ kind: 'facility', point: facilityPoint() })
    expect(screen.getByText('Escondida')).toBeTruthy()
    expect(screen.getByText(/Chile/)).toBeTruthy()
    expect(screen.getByText(/BHP/)).toBeTruthy()
  })

  it('links to the source when there is one', () => {
    renderPanel({ kind: 'facility', point: facilityPoint() })
    const link = screen.getByRole('link', { name: /open source/i })
    expect(link.getAttribute('href')).toBe('https://example.org/source')
  })

  it('offers no source link when the record has no url, rather than a dead link', () => {
    renderPanel({ kind: 'facility', point: facilityPoint({ source_url: null }) })
    expect(screen.queryByRole('link', { name: /open source/i })).toBeNull()
  })

  it('marks a low-confidence facility and explains why', () => {
    renderPanel({ kind: 'facility', point: facilityPoint({ confidence: 'low' }) })
    expect(screen.getByText('low confidence')).toBeTruthy()
    expect(screen.getByText(/poorly documented in public sources/i)).toBeTruthy()
  })

  it('does not mark a high-confidence facility', () => {
    renderPanel({ kind: 'facility', point: facilityPoint() })
    expect(screen.queryByText('low confidence')).toBeNull()
  })

  it('says "not recorded" rather than showing a zero capacity', () => {
    renderPanel({ kind: 'facility', point: facilityPoint({ capacity_tonnes_per_year: null }) })
    expect(screen.getByText('not recorded')).toBeTruthy()
  })

  /** The non-negotiable: an estimate must never read as a traded value. */
  it('labels an estimated flow value and shows the arithmetic behind it', () => {
    renderPanel({ kind: 'flow', arc: flowArc(true) })
    expect(screen.getByText('estimated value')).toBeTruthy()
    expect(screen.getByText(/not a traded value/i)).toBeTruthy()
    expect(screen.getByText(/1,600,000 t at \$9,200\/t/)).toBeTruthy()
    expect(screen.getByText('Estimated value')).toBeTruthy()
  })

  it('does not label a traded value as estimated', () => {
    renderPanel({ kind: 'flow', arc: flowArc(false) })
    expect(screen.queryByText('estimated value')).toBeNull()
    expect(screen.queryByText(/not a traded value/i)).toBeNull()
    expect(screen.getByText('Value')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const onClose = renderPanel({ kind: 'facility', point: facilityPoint() })
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes from the close button', async () => {
    const onClose = renderPanel({ kind: 'facility', point: facilityPoint() })
    await userEvent.click(screen.getByRole('button', { name: /close detail panel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('takes focus when it opens, so the keyboard lands somewhere useful', () => {
    renderPanel({ kind: 'facility', point: facilityPoint() })
    expect(document.activeElement).toBe(screen.getByLabelText('Detail'))
  })
})
