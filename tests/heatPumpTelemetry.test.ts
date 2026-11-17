import { describe, it, expect } from 'vitest'
import { heatPumpTelemetry } from '../src/heatPumpTelemetry'

/** The Ekalor R290 as configured on the bridge: 21 outside, 24 flow, 25 the tank. */
const DPS = {
  dpActive: '1',
  dpCurrent: '25',
  currentDivisor: 10,
  dpFlow: '24',
  flowDivisor: 10,
  dpOutside: '21',
  outsideDivisor: 10,
  dpHotWater: '25',
  hotWaterDivisor: 10,
}

describe('heatPumpTelemetry', () => {
  it('reports every named reading, divided', () => {
    const t = heatPumpTelemetry({ '1': true, '21': 163, '24': 400, '25': 247 }, DPS, 21)
    expect(t).toEqual({
      active: true,
      targetTemperature: 21,
      currentTemperature: 24.7,
      supplyTemperature: 40,
      outsideTemperature: 16.3,
      hotWaterTemperature: 24.7,
    })
  })

  it('leaves out a reading the unit has not sent, instead of reporting 0', () => {
    const t = heatPumpTelemetry({ '1': false, '25': 247 }, DPS, 20)
    expect(t).toEqual({ active: false, targetTemperature: 20, currentTemperature: 24.7, hotWaterTemperature: 24.7 })
  })

  it('reports nothing for a reading the config does not name', () => {
    const t = heatPumpTelemetry(
      { '1': true, '21': 163, '24': 400, '25': 247 },
      { ...DPS, dpOutside: false, dpHotWater: false },
      20,
    )
    expect(t.outsideTemperature).toBeUndefined()
    expect(t.hotWaterTemperature).toBeUndefined()
    expect(t.supplyTemperature).toBe(40)
  })
})
