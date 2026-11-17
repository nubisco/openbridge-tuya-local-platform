import type { DPSState } from './types'

/** Where each of a heat pump's readings lives, and what to divide it by. */
export interface HeatPumpReadingDPs {
  dpActive: string
  /** The reading the HomeKit heater shows as its current temperature. */
  dpCurrent: string
  currentDivisor: number
  dpFlow?: string | false
  flowDivisor?: number
  dpOutside?: string | false
  outsideDivisor?: number
  dpHotWater?: string | false
  hotWaterDivisor?: number
}

const reading = (state: DPSState, dp: string | false | undefined, divisor = 10): number | undefined => {
  if (!dp || state[dp] === undefined || state[dp] === null) return undefined
  const n = parseFloat(String(state[dp])) / (divisor || 1)
  return Number.isFinite(n) ? n : undefined
}

/**
 * What a heat pump tells OpenBridge, separately from what it shows in HomeKit.
 *
 * Every reading the unit reports and the config names goes here, whether or not
 * it is exposed to HomeKit: the `expose*Sensor` options decide only what Apple
 * Home sees. The names are the ones OpenBridge's house plan reads:
 * `supplyTemperature` is the water going out to the house (it colours the
 * pipes), `outsideTemperature` colours the garden, and `hotWaterTemperature` is
 * the domestic hot water tank. A reading the unit has not sent is left out
 * rather than reported as 0.
 */
export function heatPumpTelemetry(
  state: DPSState,
  dps: HeatPumpReadingDPs,
  targetTemperature: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    active: !!state[dps.dpActive],
    targetTemperature,
  }
  const current = reading(state, dps.dpCurrent, dps.currentDivisor)
  if (current !== undefined) out.currentTemperature = current
  const supply = reading(state, dps.dpFlow, dps.flowDivisor)
  if (supply !== undefined) out.supplyTemperature = supply
  const outside = reading(state, dps.dpOutside, dps.outsideDivisor)
  if (outside !== undefined) out.outsideTemperature = outside
  const hotWater = reading(state, dps.dpHotWater, dps.hotWaterDivisor)
  if (hotWater !== undefined) out.hotWaterTemperature = hotWater
  return out
}
