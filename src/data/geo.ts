import { feature } from 'topojson-client'
import countriesTopology from 'world-atlas/countries-110m.json'
import type { Topology } from 'topojson-specification'

/**
 * Natural Earth admin-0 countries at 1:110m, bundled rather than fetched, and
 * the one place that knows their shape. The globe draws borders and the land
 * texture from these rings, and a click on land is resolved to a country here.
 *
 * world-atlas keys countries by ISO 3166-1 numeric code; the rest of the app
 * speaks ISO3. The table below was generated once from pycountry against this
 * exact world-atlas file. The three features without a numeric code (Kosovo,
 * Northern Cyprus, Somaliland) resolve to nothing, which a click treats as
 * open water.
 */

export type Ring = [number, number][]

export interface CountryShape {
  iso3: string | null
  name: string
  /** Each polygon is an outer ring followed by any holes. */
  polygons: Ring[][]
  /** Lng/lat bounding box, for a cheap reject before point-in-polygon. */
  bbox: [number, number, number, number]
}

const NUMERIC_TO_ISO3: Record<string, string> = {"242":"FJI","834":"TZA","732":"ESH","124":"CAN","840":"USA","398":"KAZ","860":"UZB","598":"PNG","360":"IDN","032":"ARG","152":"CHL","180":"COD","706":"SOM","404":"KEN","729":"SDN","148":"TCD","332":"HTI","214":"DOM","643":"RUS","044":"BHS","238":"FLK","578":"NOR","304":"GRL","260":"ATF","626":"TLS","710":"ZAF","426":"LSO","484":"MEX","858":"URY","076":"BRA","068":"BOL","604":"PER","170":"COL","591":"PAN","188":"CRI","558":"NIC","340":"HND","222":"SLV","320":"GTM","084":"BLZ","862":"VEN","328":"GUY","740":"SUR","250":"FRA","218":"ECU","630":"PRI","388":"JAM","192":"CUB","716":"ZWE","072":"BWA","516":"NAM","686":"SEN","466":"MLI","478":"MRT","204":"BEN","562":"NER","566":"NGA","120":"CMR","768":"TGO","288":"GHA","384":"CIV","324":"GIN","624":"GNB","430":"LBR","694":"SLE","854":"BFA","140":"CAF","178":"COG","266":"GAB","226":"GNQ","894":"ZMB","454":"MWI","508":"MOZ","748":"SWZ","024":"AGO","108":"BDI","376":"ISR","422":"LBN","450":"MDG","275":"PSE","270":"GMB","788":"TUN","012":"DZA","400":"JOR","784":"ARE","634":"QAT","414":"KWT","368":"IRQ","512":"OMN","548":"VUT","116":"KHM","764":"THA","418":"LAO","104":"MMR","704":"VNM","408":"PRK","410":"KOR","496":"MNG","356":"IND","050":"BGD","064":"BTN","524":"NPL","586":"PAK","004":"AFG","762":"TJK","417":"KGZ","795":"TKM","364":"IRN","760":"SYR","051":"ARM","752":"SWE","112":"BLR","804":"UKR","616":"POL","040":"AUT","348":"HUN","498":"MDA","642":"ROU","440":"LTU","428":"LVA","233":"EST","276":"DEU","100":"BGR","300":"GRC","792":"TUR","008":"ALB","191":"HRV","756":"CHE","442":"LUX","056":"BEL","528":"NLD","620":"PRT","724":"ESP","372":"IRL","540":"NCL","090":"SLB","554":"NZL","036":"AUS","144":"LKA","156":"CHN","158":"TWN","380":"ITA","208":"DNK","826":"GBR","352":"ISL","031":"AZE","268":"GEO","608":"PHL","458":"MYS","096":"BRN","705":"SVN","246":"FIN","703":"SVK","203":"CZE","232":"ERI","392":"JPN","600":"PRY","887":"YEM","682":"SAU","010":"ATA","196":"CYP","504":"MAR","818":"EGY","434":"LBY","231":"ETH","262":"DJI","800":"UGA","646":"RWA","070":"BIH","807":"MKD","688":"SRB","499":"MNE","780":"TTO","728":"SSD"}

export const COUNTRY_SHAPES: CountryShape[] = (() => {
  const topology = countriesTopology as unknown as Topology
  const countries = topology.objects.countries
  if (!countries) return []
  const collection = feature(topology, countries) as unknown as {
    features: {
      id?: string
      properties: { name: string }
      geometry: { type: string; coordinates: unknown } | null
    }[]
  }
  const shapes: CountryShape[] = []
  for (const f of collection.features) {
    if (!f.geometry) continue
    const polygons =
      f.geometry.type === 'MultiPolygon'
        ? (f.geometry.coordinates as Ring[][])
        : f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates as Ring[]]
          : []
    let minX = 180
    let minY = 90
    let maxX = -180
    let maxY = -90
    for (const polygon of polygons) {
      for (const [x, y] of polygon[0] ?? []) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    shapes.push({
      iso3: f.id !== undefined ? (NUMERIC_TO_ISO3[f.id] ?? null) : null,
      name: f.properties.name,
      polygons,
      bbox: [minX, minY, maxX, maxY],
    })
  }
  return shapes
})()

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The country containing a point, or null for open water and unmapped land. */
export function countryAt(lat: number, lng: number): CountryShape | null {
  for (const shape of COUNTRY_SHAPES) {
    const [minX, minY, maxX, maxY] = shape.bbox
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue
    for (const polygon of shape.polygons) {
      const [outer, ...holes] = polygon
      if (outer && inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h))) return shape
    }
  }
  return null
}

/**
 * Is a meridian clear of land between the Antarctic coast and 58°N? Used to
 * choose where a flat map can be cut without splitting a continent. The far
 * north is ignored on purpose: Greenland and Iceland straddle every Atlantic
 * meridian, and an Atlantic cut through them is the standard trade-off of a
 * Pacific-centred map. Sampled every two degrees of latitude.
 */
export function isOpenOceanMeridian(lng: number, minLat = -60, maxLat = 58): boolean {
  for (let lat = minLat; lat <= maxLat; lat += 2) {
    if (countryAt(lat, lng) !== null) return false
  }
  return true
}
