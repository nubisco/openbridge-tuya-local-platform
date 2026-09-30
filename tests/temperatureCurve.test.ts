import { describe, it, expect } from 'vitest'
import { mapRoomToWater, mapWaterToRoom, curveCeiling, type CurvePoint } from '../src/temperatureCurve'

/** The curve live on the Ekalor R290 at the time this was written. */
const LIVE: CurvePoint[] = [
  { room: 18, water: 24 },
  { room: 20, water: 27 },
  { room: 22, water: 29 },
  { room: 24, water: 30 },
]

describe('room to water', () => {
  it('returns the exact water for a point on the curve', () => {
    expect(mapRoomToWater(LIVE, 20)).toBe(27)
    expect(mapRoomToWater(LIVE, 22)).toBe(29)
  })

  it('interpolates between points', () => {
    expect(mapRoomToWater(LIVE, 19)).toBe(25.5)
    expect(mapRoomToWater(LIVE, 21)).toBe(28)
  })

  it('clamps rather than extrapolating past either end', () => {
    // Extrapolating a curve nobody calibrated out there is how a heat pump
    // gets told to produce something it cannot, or dangerous.
    expect(mapRoomToWater(LIVE, 10)).toBe(24)
    expect(mapRoomToWater(LIVE, 30)).toBe(30)
  })

  it('falls back to the identity when no curve is configured', () => {
    expect(mapRoomToWater([], 21)).toBe(21)
  })
})

describe('water to room', () => {
  it('round-trips every point on the curve', () => {
    for (const point of LIVE) {
      expect(mapWaterToRoom(LIVE, point.water)).toBe(point.room)
    }
  })

  it('round-trips interpolated values', () => {
    for (const room of [19, 20.5, 21, 23]) {
      expect(mapWaterToRoom(LIVE, mapRoomToWater(LIVE, room))).toBeCloseTo(room, 5)
    }
  })

  it('clamps a setpoint above anything the curve covers', () => {
    // The real case: the pump is set to 40 in the vendor app while this curve
    // tops out at 30. Reporting the ceiling is honest; inventing a room value
    // above the configured maximum would not be.
    expect(mapWaterToRoom(LIVE, 40)).toBe(24)
    expect(mapWaterToRoom(LIVE, 15)).toBe(18)
  })

  it('resolves a flat section to its highest room value', () => {
    // A curve can flatten at the top. Water 30 here means either 22 or 24, and
    // the person asking for that much heat meant the warmer one.
    const flat: CurvePoint[] = [
      { room: 18, water: 24 },
      { room: 22, water: 30 },
      { room: 24, water: 30 },
    ]
    expect(mapWaterToRoom(flat, 30)).toBe(24)
  })

  it('handles a single-point curve without dividing by zero', () => {
    expect(mapWaterToRoom([{ room: 20, water: 27 }], 27)).toBe(20)
    expect(mapWaterToRoom([{ room: 20, water: 27 }], 45)).toBe(20)
  })
})

describe('curve ceiling', () => {
  it('reports the highest water the curve can ever ask for', () => {
    // The live curve tops out at 30 while the unit accepts 75, so on a cold day
    // it cannot ask for the heat the house needs. That limit is invisible until
    // somebody is cold, which is exactly why it is worth stating.
    expect(curveCeiling(LIVE)).toBe(30)
  })

  it('is null when nothing is configured', () => {
    expect(curveCeiling([])).toBeNull()
  })
})
