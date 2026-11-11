import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ArcDatum, PointDatum } from '../data/derive.ts'
import type { ChokepointModel } from '../data/chokepoint.ts'
import { formatShare } from '../data/chokepoint.ts'
import { arcLine, pointAlong, type LngLat } from './arcGeometry.ts'
import { loadCountryGeo, type CountryGeo } from './countryGeo.ts'
import { lensView, minZoomFor, type Lens } from './camera.ts'

export type { Lens }

/**
 * The map. A real slippy map (MapLibre) in Web Mercator, so it pans freely in
 * every direction, zooms from the whole world down to a single pit, and keeps
 * going: satellite imagery fades in as you close in on a place.
 *
 * Three lenses share it. Mined and refined colour the countries by their share
 * of world output and light the sites of that stage; trade draws the routes
 * between countries and runs light along them. Changing lens dissolves one
 * picture into the next rather than swapping maps.
 */

export interface ExploreMapHandle {
  /** The wide default view: the world, big enough that there is somewhere to drag in every direction. */
  home: (opts?: { duration?: number; lens?: Lens }) => void
  flyTo: (opts: { lng: number; lat: number; zoom: number; duration?: number }) => void
  fitCountry: (iso3: string) => void
  getZoom: () => number
}

export interface ExploreMapProps {
  lens: Lens
  model: ChokepointModel | null
  points: PointDatum[]
  arcs: ArcDatum[]
  selectedId: string | null
  focusCountry: string | null
  reducedMotion: boolean
  /** Pixels of the map covered by panels, so flights land in the clear part. */
  insets: { left: number; right: number; top: number; bottom: number }
  /** Satellite on at every zoom, not only when close in. */
  satellite: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onSelectCountry: (iso3: string) => void
  onClearSelection: () => void
  onReady?: () => void
}

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_PLACES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'

const LAND = '#1d1814'
const OCEAN = '#0b0908'
const ORE = '#35a395'
const ORE_TINT = '#6fd0c0'
const COPPER = '#d07a45'
const COPPER_TINT = '#f0b48a'
const ACCENT = '#d9b672'

const MINE_RAMP: [number, string][] = [
  [0, LAND],
  [0.01, '#1f2b28'],
  [0.05, '#235a52'],
  [0.12, '#2b8a7d'],
  [0.25, ORE],
]
const REFINE_RAMP: [number, string][] = [
  [0, LAND],
  [0.01, '#2c211a'],
  [0.05, '#6e3f23'],
  [0.12, '#a95e36'],
  [0.3, COPPER],
  [0.48, '#e8905a'],
]

const ramp = (prop: string, stops: [number, string][]): ExpressionSpecification =>
  ['interpolate', ['linear'], ['get', prop], ...stops.flat()] as unknown as ExpressionSpecification

const expr = (e: unknown): ExpressionSpecification => e as ExpressionSpecification

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    places: { type: 'raster', tiles: [ESRI_PLACES], tileSize: 256, maxzoom: 13 },
  },
  layers: [{ id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } }],
}

/** The lens decides how loud each kind of site is. */
const SITE_OPACITY: Record<Lens, Record<'mine' | 'process' | 'refine', number>> = {
  mined: { mine: 1, process: 0.28, refine: 0.28 },
  refined: { mine: 0.28, process: 1, refine: 1 },
  trade: { mine: 0.55, process: 0.7, refine: 0.7 },
}

export const ExploreMap = forwardRef<ExploreMapHandle, ExploreMapProps>(function ExploreMap(props, ref) {
  const { lens, model, points, arcs, selectedId, focusCountry, reducedMotion, insets, satellite } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const geoRef = useRef<CountryGeo | null>(null)
  const [ready, setReady] = useState(false)
  const [geoReady, setGeoReady] = useState(false)
  // Bumped each time the country shapes (and so the labels) are replaced.
  const [geoVersion, setGeoVersion] = useState(0)
  const tipRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLParagraphElement>(null)
  const labelsRef = useRef<Map<string, { el: HTMLDivElement; mine: number; refine: number }>>(new Map())

  // Latest props for handlers that live as long as the map does.
  const live = useRef(props)
  live.current = props
  const pointsById = useRef<Map<string, PointDatum>>(new Map())
  const arcsById = useRef<Map<string, ArcDatum>>(new Map())
  const arcPaths = useRef<{ line: LngLat[]; phase: number }[]>([])

  const padding = useCallback(() => {
    const i = live.current.insets
    return { left: i.left, right: i.right, top: i.top, bottom: i.bottom }
  }, [])

  /** Room around a country when flying to it, never so much that the box cannot fit the canvas. */
  const fitPadding = useCallback(() => {
    const box = containerRef.current
    const i = live.current.insets
    const width = box?.clientWidth ?? 1000
    const height = box?.clientHeight ?? 700
    const left = Math.min(i.left + 24, width * 0.38)
    const right = Math.min(i.right + 24, width * 0.38)
    const top = Math.min(i.top + 24, height * 0.25)
    const bottom = Math.min(i.bottom + 40, height * 0.2)
    return { left, right, top, bottom }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      home: (opts) => {
        const map = mapRef.current
        const box = containerRef.current
        if (!map || !box) return
        const v = lensView(opts?.lens ?? live.current.lens, box.clientWidth - insets.left - insets.right)
        map.easeTo({
          center: v.center,
          zoom: v.zoom,
          duration: reducedMotion ? 0 : (opts?.duration ?? 1600),
          padding: padding(),
        })
      },
      flyTo: ({ lng, lat, zoom, duration }) => {
        const map = mapRef.current
        if (!map) return
        map.flyTo({
          center: [lng, lat],
          zoom,
          duration: reducedMotion ? 0 : (duration ?? 2400),
          padding: padding(),
          essential: true,
        })
      },
      getZoom: () => mapRef.current?.getZoom() ?? 0,
      fitCountry: (iso3) => {
        const map = mapRef.current
        const place = geoRef.current?.places[iso3]
        if (!map || !place) return
        const b = place.bounds
        map.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: fitPadding(), maxZoom: 6, duration: reducedMotion ? 0 : 1800, essential: true },
        )
      },
    }),
    [insets.left, insets.right, padding, fitPadding, reducedMotion],
  )

  /* ------------------------------------------------------------- creation */
  useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const i0 = live.current.insets
    const home = lensView(live.current.lens, box.clientWidth - i0.left - i0.right)
    const map = new maplibregl.Map({
      container: box,
      style: STYLE,
      center: home.center,
      zoom: home.zoom,
      minZoom: minZoomFor(box.clientWidth),
      maxZoom: 18,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      renderWorldCopies: true,
      fadeDuration: 150,
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left')
    mapRef.current = map
    if (import.meta.env.DEV) (window as unknown as { __mfMap?: MlMap }).__mfMap = map

    map.on('load', () => {
      {
        const i = live.current.insets
        map.jumpTo({ center: home.center, zoom: home.zoom, padding: { left: i.left, right: i.right, top: i.top, bottom: i.bottom } })
      }
      // Plain land first, then the two data fills, then imagery over all of it.
      map.addSource('countries', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('arcs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('flow-dots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

      map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': LAND } })
      map.addLayer({
        id: 'fill-mine',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': ramp('mine', MINE_RAMP), 'fill-opacity': 0.95, 'fill-opacity-transition': { duration: 1100, delay: 0 } },
      })
      map.addLayer({
        id: 'fill-refine',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': ramp('refine', REFINE_RAMP), 'fill-opacity': 0, 'fill-opacity-transition': { duration: 1100, delay: 0 } },
      })
      map.addLayer({
        id: 'sat',
        type: 'raster',
        source: 'sat',
        minzoom: 4.2,
        paint: {
          'raster-opacity': expr(['interpolate', ['linear'], ['zoom'], 4.2, 0, 6.4, 1]),
          'raster-brightness-max': 0.88,
          'raster-saturation': -0.12,
          'raster-fade-duration': 250,
        },
      })
      map.addLayer({
        id: 'borders',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': expr(['interpolate', ['linear'], ['zoom'], 2, '#4a3d31', 6, 'rgba(239,231,220,0.55)']),
          'line-width': expr(['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1]),
        },
      })
      map.addLayer({
        id: 'places',
        type: 'raster',
        source: 'places',
        minzoom: 6.8,
        paint: { 'raster-opacity': expr(['interpolate', ['linear'], ['zoom'], 6.8, 0, 8.2, 0.9]) },
      })
      // Invisible, always on, so a click or hover on any land resolves to a country.
      map.addLayer({
        id: 'country-hit',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': '#000', 'fill-opacity': 0 },
      })

      map.addLayer({
        id: 'arcs-line',
        type: 'line',
        source: 'arcs',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': expr(['get', 'color']),
          'line-width': expr(['interpolate', ['linear'], ['zoom'], 1, ['*', ['get', 'w'], 0.6], 6, ['*', ['get', 'w'], 1.5]]),
          'line-opacity': 0,
          'line-opacity-transition': { duration: 900, delay: 0 },
          'line-blur': 0.3,
        },
      })
      map.addLayer({
        id: 'arcs-hit',
        type: 'line',
        source: 'arcs',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 12 },
      })
      map.addLayer({
        id: 'flow-dots',
        type: 'circle',
        source: 'flow-dots',
        paint: {
          'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 3.2]),
          'circle-color': '#fbe6d2',
          'circle-opacity': 0.95,
          'circle-blur': 0.2,
        },
      })

      const radius = expr([
        'interpolate',
        ['linear'],
        ['zoom'],
        1.3,
        ['*', ['get', 'size'], 0.42],
        4,
        ['*', ['get', 'size'], 0.75],
        8,
        ['*', ['get', 'size'], 1.5],
        12,
        ['*', ['get', 'size'], 2.4],
        16,
        ['*', ['get', 'size'], 3.4],
      ])
      // Up close every site becomes a ring, so the place itself shows through the marker.
      const fadeToRing = (rgb: string): ExpressionSpecification =>
        expr(['interpolate', ['linear'], ['zoom'], 6, `rgba(${rgb},0.95)`, 9.5, `rgba(${rgb},0.05)`])
      for (const [stage, rgb, stroke] of [
        ['mine', '53,163,149', ORE_TINT],
        ['process', '217,178,76', '#f2d98a'],
        ['refine', '208,122,69', COPPER_TINT],
      ] as const) {
        map.addLayer({
          id: `sites-${stage}`,
          type: 'circle',
          source: 'sites',
          filter: ['==', ['get', 'stage'], stage],
          paint: {
            'circle-radius': radius,
            'circle-color': fadeToRing(rgb),
            'circle-stroke-color': stroke,
            'circle-stroke-width': expr(['interpolate', ['linear'], ['zoom'], 1.3, 0.4, 7, 1.2, 12, 2.4]),
            'circle-opacity': SITE_OPACITY.mined[stage],
            'circle-stroke-opacity': SITE_OPACITY.mined[stage],
            'circle-opacity-transition': { duration: 900, delay: 0 },
            'circle-stroke-opacity-transition': { duration: 900, delay: 0 },
          },
        })
      }
      map.addLayer({
        id: 'site-selected',
        type: 'circle',
        source: 'sites',
        filter: ['==', ['get', 'id'], ''],
        paint: {
          'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 1.3, 7, 12, 20]),
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': ACCENT,
          'circle-stroke-width': 2,
        },
      })

      setReady(true)
      live.current.onReady?.()
    })

    /* ------------------------------------------------------ interaction */
    const siteLayers = ['sites-process', 'sites-refine', 'sites-mine']

    const pick = (e: MapMouseEvent) => {
      // Before the layers exist there is nothing to pick.
      if (!map.getLayer('sites-mine')) return null
      const { x, y } = e.point
      const box: [[number, number], [number, number]] = [
        [x - 7, y - 7],
        [x + 7, y + 7],
      ]
      const sites = map.queryRenderedFeatures(box, { layers: siteLayers })
      if (sites.length > 0) {
        // The nearest on screen wins, so a click lands on what is under the cursor.
        let best = sites[0]!
        let bestD = Infinity
        for (const f of sites) {
          const g = f.geometry as GeoJSON.Point
          const p = map.project(g.coordinates as [number, number])
          const d = (p.x - x) ** 2 + (p.y - y) ** 2
          if (d < bestD) {
            best = f
            bestD = d
          }
        }
        const point = pointsById.current.get(String(best.properties?.id))
        if (point) return { kind: 'site' as const, point }
      }
      if (live.current.lens === 'trade') {
        const hit = map.queryRenderedFeatures(
          [
            [x - 5, y - 5],
            [x + 5, y + 5],
          ],
          { layers: ['arcs-hit'] },
        )
        const arc = hit[0] ? arcsById.current.get(String(hit[0].properties?.id)) : undefined
        if (arc) return { kind: 'arc' as const, arc }
      }
      const country = map.queryRenderedFeatures(e.point, { layers: ['country-hit'] })[0]
      const iso3 = String(country?.properties?.iso3 ?? '')
      if (iso3) {
        return {
          kind: 'country' as const,
          iso3,
          name: String(country?.properties?.name ?? iso3),
          mine: Number(country?.properties?.mine ?? 0),
          refine: Number(country?.properties?.refine ?? 0),
        }
      }
      return null
    }

    map.on('click', (e) => {
      const hit = pick(e)
      if (!hit) live.current.onClearSelection()
      else if (hit.kind === 'site') live.current.onSelectPoint(hit.point)
      else if (hit.kind === 'arc') live.current.onSelectArc(hit.arc)
      else live.current.onSelectCountry(hit.iso3)
    })

    const tip = () => tipRef.current
    map.on('mousemove', (e) => {
      const readout = readoutRef.current
      if (readout) {
        readout.textContent = `${e.lngLat.lat.toFixed(3)}°, ${e.lngLat.wrap().lng.toFixed(3)}° · z${map.getZoom().toFixed(1)}`
      }
      const el = tip()
      if (!el || !map.isStyleLoaded()) return
      const hit = pick(e)
      map.getCanvas().style.cursor = hit ? 'pointer' : ''
      if (!hit) {
        el.style.opacity = '0'
        return
      }
      const lensNow = live.current.lens
      let title: string
      let sub: string
      if (hit.kind === 'site') {
        const p = hit.point.facility.properties
        title = p.name
        sub = `${p.stage === 'mine' ? 'Mine' : p.stage === 'refine' ? 'Refinery' : 'Smelter / processing'}${p.operator && p.operator !== p.name ? ' · ' + p.operator : ''}`
      } else if (hit.kind === 'arc') {
        const f = hit.arc.flow
        title = `${f.from_iso3} → ${f.to_iso3}`
        sub = hit.arc.value.usd !== null ? `$${(hit.arc.value.usd / 1e6).toFixed(0)}M of trade` : 'Trade route'
      } else {
        title = hit.name
        sub =
          lensNow === 'mined'
            ? `${formatShare(hit.mine)} of world mine output`
            : lensNow === 'refined'
              ? `${formatShare(hit.refine)} of world refinery output`
              : 'Click for trade in and out'
      }
      el.style.opacity = '1'
      el.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 16}px)`
      const [t, s] = [el.children[0] as HTMLElement, el.children[1] as HTMLElement]
      t.textContent = title
      s.textContent = sub
    })
    map.on('mouseout', () => {
      const el = tip()
      if (el) el.style.opacity = '0'
    })

    // Country names thin out as you close in: imagery brings its own labels.
    const syncLabels = () => {
      const z = map.getZoom()
      box.classList.toggle('mf-labels-off', z > 6.2)
    }
    map.on('zoom', syncLabels)

    const labels = labelsRef.current
    return () => {
      for (const { el } of labels.values()) el.parentElement?.remove()
      labels.clear()
      map.remove()
      mapRef.current = null
      setReady(false)
      setGeoReady(false)
    }
  }, [])

  /* ------------------------------------------------------ country shapes */
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const apply = (geo: CountryGeo) => {
      const map = mapRef.current
      if (cancelled || !map) return
      geoRef.current = geo
      ;(map.getSource('countries') as GeoJSONSource | undefined)?.setData(geo.collection)

      // One label per country that matters to the picture.
      for (const { el } of labelsRef.current.values()) el.parentElement?.remove()
      labelsRef.current.clear()
      for (const row of model?.rows ?? []) {
        if (row.mine < 0.015 && row.refine < 0.015) continue
        const place = geo.places[row.iso3]
        if (!place) continue
        // MapLibre writes its own inline opacity on a marker's element, so the
        // look and the fading live on a child it does not touch.
        const wrap = document.createElement('div')
        wrap.className = 'mf-label-wrap'
        const el = document.createElement('div')
        el.className = 'mf-label mf-label-quiet'
        el.innerHTML = '<span class="mf-label-name"></span><span class="mf-label-pct"></span>'
        ;(el.children[0] as HTMLElement).textContent = row.name
        wrap.appendChild(el)
        new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([place.lng, place.lat]).addTo(map)
        labelsRef.current.set(row.iso3, { el, mine: row.mine, refine: row.refine })
      }
      setGeoReady(true)
      setGeoVersion((v) => v + 1)
    }
    let fineDone = false
    void loadCountryGeo(model, 'coarse').then((geo) => {
      if (!fineDone) apply(geo)
    })
    void loadCountryGeo(model, 'fine').then((geo) => {
      fineDone = true
      apply(geo)
    })
    return () => {
      cancelled = true
    }
  }, [ready, model])

  /* ---------------------------------------------------------------- sites */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    pointsById.current = new Map(points.map((p) => [p.id, p]))
    ;(map.getSource('sites') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { id: p.id, stage: p.stage, size: p.size, conf: p.confidence },
      })),
    })
  }, [ready, points])

  /* ----------------------------------------------------------------- arcs */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    arcsById.current = new Map(arcs.map((a) => [a.id, a]))
    const lines = arcs.map((a) => arcLine([a.startLng, a.startLat], [a.endLng, a.endLat]))
    arcPaths.current = lines.slice(0, 70).map((line, i) => ({ line, phase: (i * 0.173) % 1 }))
    ;(map.getSource('arcs') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: arcs.map((a, i) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: lines[i]! },
        properties: { id: a.id, color: a.color, w: Math.max(1.4, a.width * 1.5), weight: a.weight },
      })),
    })
  }, [ready, arcs])

  /* ----------------------------------------------------------------- lens */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const dur = reducedMotion ? 0 : 1100
    for (const id of ['fill-mine', 'fill-refine']) {
      map.setPaintProperty(id, 'fill-opacity-transition', { duration: dur, delay: 0 })
    }
    map.setPaintProperty('fill-mine', 'fill-opacity', lens === 'mined' ? 0.95 : 0)
    map.setPaintProperty('fill-refine', 'fill-opacity', lens === 'refined' ? 0.95 : 0)
    map.setPaintProperty('arcs-line', 'line-opacity-transition', { duration: dur, delay: 0 })
    map.setPaintProperty('arcs-line', 'line-opacity', lens === 'trade' ? 0.85 : 0)
    map.setLayoutProperty('arcs-hit', 'visibility', lens === 'trade' ? 'visible' : 'none')
    map.setLayoutProperty('flow-dots', 'visibility', lens === 'trade' ? 'visible' : 'none')
    for (const stage of ['mine', 'process', 'refine'] as const) {
      const o = SITE_OPACITY[lens][stage]
      map.setPaintProperty(`sites-${stage}`, 'circle-opacity-transition', { duration: dur, delay: 0 })
      map.setPaintProperty(`sites-${stage}`, 'circle-stroke-opacity-transition', { duration: dur, delay: 0 })
      map.setPaintProperty(`sites-${stage}`, 'circle-opacity', expr(['case', ['==', ['get', 'conf'], 'low'], o * 0.6, o]))
      map.setPaintProperty(`sites-${stage}`, 'circle-stroke-opacity', expr(['case', ['==', ['get', 'conf'], 'low'], o * 0.6, o]))
    }
    for (const { el, mine, refine } of labelsRef.current.values()) {
      const share = lens === 'mined' ? mine : lens === 'refined' ? refine : 0
      el.classList.toggle('mf-label-quiet', lens === 'trade' || share < 0.03)
      ;(el.children[1] as HTMLElement).textContent = lens === 'trade' ? '' : formatShare(share)
    }
  }, [ready, geoReady, geoVersion, lens, reducedMotion])

  /* ------------------------------------------------------------ satellite */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    if (satellite) {
      map.setLayerZoomRange('sat', 0, 24)
      map.setPaintProperty('sat', 'raster-opacity', 1)
      map.setLayerZoomRange('places', 3, 24)
      map.setPaintProperty('places', 'raster-opacity', expr(['interpolate', ['linear'], ['zoom'], 3, 0, 4.5, 0.9]))
    } else {
      map.setLayerZoomRange('sat', 4.2, 24)
      map.setPaintProperty('sat', 'raster-opacity', expr(['interpolate', ['linear'], ['zoom'], 4.2, 0, 6.4, 1]))
      map.setLayerZoomRange('places', 6.8, 24)
      map.setPaintProperty('places', 'raster-opacity', expr(['interpolate', ['linear'], ['zoom'], 6.8, 0, 8.2, 0.9]))
    }
  }, [ready, satellite])

  /* ------------------------------------------------------------ selection */
  useEffect(() => {
    containerRef.current?.style.setProperty('--mf-inset-right', `${insets.right}px`)
  }, [insets.right])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    map.setFilter('site-selected', ['==', ['get', 'id'], selectedId ?? ''])
  }, [ready, selectedId])

  useEffect(() => {
    if (!ready || !geoReady || !focusCountry) return
    const place = geoRef.current?.places[focusCountry]
    const map = mapRef.current
    if (!place || !map) return
    const b = place.bounds
    map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: fitPadding(), maxZoom: 6, duration: reducedMotion ? 0 : 1800, essential: true },
    )
  }, [ready, geoReady, focusCountry, reducedMotion, fitPadding])

  /* ------------------------------------------------------- moving light */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || lens !== 'trade' || reducedMotion) return
    let raf = 0
    let last = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 40 || document.hidden) return
      last = now
      const src = map.getSource('flow-dots') as GeoJSONSource | undefined
      if (!src) return
      const t = now / 9000
      const features: GeoJSON.Feature[] = []
      for (const { line, phase } of arcPaths.current) {
        for (const off of [0, 0.5]) {
          const f = (t + phase + off) % 1
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pointAlong(line, f) }, properties: {} })
        }
      }
      src.setData({ type: 'FeatureCollection', features })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [ready, lens, reducedMotion, arcs])

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="mf-map h-full w-full" />
      <div ref={tipRef} className="mf-tip pointer-events-none absolute top-0 left-0 z-10" style={{ opacity: 0 }}>
        <p className="mf-tip-title" />
        <p className="mf-tip-sub" />
      </div>
      <p ref={readoutRef} className="mf-readout hud-label pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 text-muted" />
    </div>
  )
})
