/**
 * The room-target to water-target curve, as pure functions.
 *
 * A heat pump with no room sensor cannot be told "make the house 22". It can
 * only be told what temperature to send out, so this translates between the
 * two. The accessory holds the HomeKit plumbing; the arithmetic lives here so
 * it can be tested against real numbers rather than through a bridge.
 */

export interface CurvePoint {
  room: number
  water: number
}

/** The water temperature to ask for, to reach this room temperature. */
export function mapRoomToWater(map: CurvePoint[], roomTemp: number): number {
  if (map.length === 0) return roomTemp
  if (roomTemp <= map[0]!.room) return map[0]!.water
  if (roomTemp >= map[map.length - 1]!.room) return map[map.length - 1]!.water

  for (let i = 0; i < map.length - 1; i++) {
    const lower = map[i]!
    const upper = map[i + 1]!
    if (roomTemp >= lower.room && roomTemp <= upper.room) {
      const span = upper.room - lower.room
      if (span === 0) return upper.water
      return lower.water + ((roomTemp - lower.room) / span) * (upper.water - lower.water)
    }
  }
  return roomTemp
}

/**
 * The inverse: what room target does this water setpoint represent.
 *
 * Needed because the water target is not ours alone. It can be changed in the
 * vendor app, on the unit's panel, or by a schedule, and without reading it
 * back the displayed room target and the running setpoint drift apart with
 * nothing to reconcile them.
 *
 * A flat section has no single answer: a curve ending 22→29 then 24→30 means
 * water 30 could be either. The highest room value that produces it is
 * returned, since that is what somebody asking for that much heat meant.
 */
export function mapWaterToRoom(map: CurvePoint[], waterTemp: number): number {
  if (map.length === 0) return waterTemp
  if (waterTemp <= map[0]!.water) return map[0]!.room
  if (waterTemp >= map[map.length - 1]!.water) return map[map.length - 1]!.room

  let best = map[0]!.room
  for (let i = 0; i < map.length - 1; i++) {
    const lower = map[i]!
    const upper = map[i + 1]!
    if (waterTemp >= lower.water && waterTemp <= upper.water) {
      const span = upper.water - lower.water
      const room = span === 0 ? upper.room : lower.room + ((waterTemp - lower.water) / span) * (upper.room - lower.room)
      best = Math.max(best, room)
    }
  }
  return best
}

/**
 * How much of the curve's range is actually usable.
 *
 * A curve whose highest point is far below what the hardware accepts cannot
 * ask for the heat a cold day needs, and that limit is invisible until someone
 * is cold. Reported at startup so it is stated rather than discovered.
 */
export function curveCeiling(map: CurvePoint[]): number | null {
  return map.length === 0 ? null : map[map.length - 1]!.water
}
