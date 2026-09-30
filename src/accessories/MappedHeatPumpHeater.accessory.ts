import BaseAccessory from './Base.accessory'
import { mapRoomToWater, mapWaterToRoom, curveCeiling } from '../temperatureCurve'
import type { DPSState, DPSValue, OpenbridgeCallback, RoomToWaterMapEntry } from '../types'

/**
 * Mapped Heat Pump Heater Accessory
 *
 * Provides a heater-style HomeKit interface where:
 * - Current temperature = tank/return temperature from device
 * - Target temperature = desired ROOM temperature (virtual, not sent to device)
 * - Actual device setpoint = mapped water temperature computed from room target
 */
class MappedHeatPumpHeaterAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.AIR_HEATER
  }

  virtualRoomTarget!: number
  dpActive!: string
  dpReturnTemperature!: string
  dpWaterTarget!: string
  dpOutsideTemperature!: string | false
  dpFlowTemperature!: string | false
  returnTemperatureDivisor!: number
  waterTargetDivisor!: number
  outsideTemperatureDivisor!: number
  flowTemperatureDivisor!: number
  roomTargetMin!: number
  roomTargetMax!: number
  waterTargetMin!: number
  waterTargetMax!: number
  roomToWaterMap!: RoomToWaterMapEntry[]
  characteristicHeatingThresholdTemperature: any

  constructor(...props: any[]) {
    super(...props)

    this.virtualRoomTarget = this.accessory.context.virtualRoomTarget || this.device.context.defaultRoomTarget || 20
  }

  _registerPlatformAccessory(): void {
    const { Service } = this.hap

    this.accessory.addService(Service.HeaterCooler, this.device.context.name)

    if (this.device.context.exposeOutsideSensor && this.device.context.dpOutsideTemperature) {
      const outsideName = this.device.context.outsideSensorName || this.device.context.name + ' Outside'
      this.accessory.addService(Service.TemperatureSensor, outsideName)
      this.log.info(`[MappedHeatPump] Adding outside temperature sensor: ${outsideName}`)
    }

    if (this.device.context.exposeFlowSensor && this.device.context.dpFlowTemperature) {
      const flowName = this.device.context.flowSensorName || this.device.context.name + ' Flow'
      this.accessory.addService(Service.TemperatureSensor, flowName)
      this.log.info(`[MappedHeatPump] Adding flow temperature sensor: ${flowName}`)
    }

    if (this.device.context.exposeReturnSensor && this.device.context.dpReturnTemperature) {
      const returnName = this.device.context.returnSensorName || this.device.context.name + ' Return'
      this.accessory.addService(Service.TemperatureSensor, returnName)
      this.log.info(`[MappedHeatPump] Adding return temperature sensor: ${returnName}`)
    }

    super._registerPlatformAccessory()
  }

  _registerCharacteristics(dps: DPSState): void {
    const { Service, Characteristic } = this.hap
    const service = this.accessory.getService(Service.HeaterCooler)
    this._checkServiceName(service, this.device.context.name)

    this.dpActive = this._getCustomDP(this.device.context.dpActive) || '1'
    this.dpReturnTemperature = this._getCustomDP(this.device.context.dpReturnTemperature) || '25'
    this.dpWaterTarget = this._getCustomDP(this.device.context.dpWaterTarget) || '117'
    this.dpOutsideTemperature = this._getCustomDP(this.device.context.dpOutsideTemperature)
    this.dpFlowTemperature = this._getCustomDP(this.device.context.dpFlowTemperature)

    this.returnTemperatureDivisor = parseInt(this.device.context.returnTemperatureDivisor) || 10
    this.waterTargetDivisor = parseInt(this.device.context.waterTargetDivisor) || 1
    this.outsideTemperatureDivisor = parseInt(this.device.context.outsideTemperatureDivisor) || 10
    this.flowTemperatureDivisor = parseInt(this.device.context.flowTemperatureDivisor) || 10

    this.roomTargetMin = parseFloat(this.device.context.roomTargetMin) || 18
    this.roomTargetMax = parseFloat(this.device.context.roomTargetMax) || 24

    this.waterTargetMin = parseFloat(this.device.context.waterTargetMin) || 35
    this.waterTargetMax = parseFloat(this.device.context.waterTargetMax) || 55

    this.roomToWaterMap = this.device.context.roomToWaterMap || [
      { room: 18, water: 35 },
      { room: 20, water: 40 },
      { room: 22, water: 47 },
      { room: 24, water: 55 },
    ]

    this.roomToWaterMap.sort((a: RoomToWaterMapEntry, b: RoomToWaterMapEntry) => a.room - b.room)

    this.log.debug(
      `[MappedHeatPump] DP mapping - Active: ${this.dpActive}, Return: ${this.dpReturnTemperature}, WaterTarget: ${this.dpWaterTarget}`,
    )
    this.log.debug(`[MappedHeatPump] Room target range: ${this.roomTargetMin}-${this.roomTargetMax}°C`)
    this.log.debug(`[MappedHeatPump] Water target range: ${this.waterTargetMin}-${this.waterTargetMax}°C`)
    this.log.debug(`[MappedHeatPump] Mapping table: ${JSON.stringify(this.roomToWaterMap)}`)
    this.log.debug(`[MappedHeatPump] Initial virtual room target: ${this.virtualRoomTarget}°C`)

    // A curve whose top is far below what the unit accepts cannot ask for the
    // heat a cold day needs, and nothing reveals that until somebody is cold.
    // Heat loss rises with the indoor-to-outdoor gap, so a curve calibrated in
    // mild weather is routinely short by the time the outside air is near zero.
    const ceiling = curveCeiling(this.roomToWaterMap)
    if (ceiling !== null && ceiling < this.waterTargetMax) {
      this.log.info(
        `[MappedHeatPump] Curve tops out at ${ceiling}°C water (unit accepts up to ${this.waterTargetMax}°C). ` +
          `If the house is cold on the coldest days, the curve is the limit, not the pump.`,
      )
    }

    const characteristicActive = service
      .getCharacteristic(Characteristic.Active)
      .updateValue(this._getActive(dps[this.dpActive]))
      .on('get', this.getActive.bind(this))
      .on('set', this.setActive.bind(this))

    service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .updateValue(this._getCurrentHeaterCoolerState(dps))
      .on('get', this.getCurrentHeaterCoolerState.bind(this))

    service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        minValue: 1,
        maxValue: 1,
        validValues: [Characteristic.TargetHeaterCoolerState.HEAT],
      })
      .updateValue(this._getTargetHeaterCoolerState())
      .on('get', this.getTargetHeaterCoolerState.bind(this))
      .on('set', this.setTargetHeaterCoolerState.bind(this))

    const characteristicCurrentTemperature = service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(this._getDividedState(dps[this.dpReturnTemperature], this.returnTemperatureDivisor))
      .on('get', this.getDividedState.bind(this, this.dpReturnTemperature, this.returnTemperatureDivisor))

    this.log.debug(
      `[MappedHeatPump] Initial return temperature from DP ${this.dpReturnTemperature}: raw=${dps[this.dpReturnTemperature]}, converted=${this._getDividedState(dps[this.dpReturnTemperature], this.returnTemperatureDivisor)}°C`,
    )

    const characteristicHeatingThresholdTemperature = service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: this.roomTargetMin,
        maxValue: this.roomTargetMax,
        minStep: this.device.context.minTemperatureSteps || 0.5,
      })
      .updateValue(this.virtualRoomTarget)
      .on('get', this.getVirtualRoomTarget.bind(this))
      .on('set', this.setVirtualRoomTarget.bind(this))

    this.characteristicHeatingThresholdTemperature = characteristicHeatingThresholdTemperature

    // Configure optional outside temperature sensor
    let characteristicOutsideTemperature: any
    if (this.dpOutsideTemperature && this.device.context.exposeOutsideSensor) {
      const services = this.accessory.services.filter(
        (s: any) => s.UUID === Service.TemperatureSensor.UUID && s.displayName.includes('Outside'),
      )
      if (services.length > 0) {
        const outsideService = services[0]
        characteristicOutsideTemperature = outsideService
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(this._getDividedState(dps[this.dpOutsideTemperature], this.outsideTemperatureDivisor))
          .on('get', this.getDividedState.bind(this, this.dpOutsideTemperature, this.outsideTemperatureDivisor))

        this.log.debug(
          `[MappedHeatPump] Initial outside temperature from DP ${this.dpOutsideTemperature}: raw=${dps[this.dpOutsideTemperature]}, converted=${this._getDividedState(dps[this.dpOutsideTemperature], this.outsideTemperatureDivisor)}°C`,
        )
      }
    }

    // Configure optional flow temperature sensor
    let characteristicFlowTemperature: any
    if (this.dpFlowTemperature && this.device.context.exposeFlowSensor) {
      const services = this.accessory.services.filter(
        (s: any) => s.UUID === Service.TemperatureSensor.UUID && s.displayName.includes('Flow'),
      )
      if (services.length > 0) {
        const flowService = services[0]
        characteristicFlowTemperature = flowService
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(this._getDividedState(dps[this.dpFlowTemperature], this.flowTemperatureDivisor))
          .on('get', this.getDividedState.bind(this, this.dpFlowTemperature, this.flowTemperatureDivisor))

        this.log.debug(
          `[MappedHeatPump] Initial flow temperature from DP ${this.dpFlowTemperature}: raw=${dps[this.dpFlowTemperature]}, converted=${this._getDividedState(dps[this.dpFlowTemperature], this.flowTemperatureDivisor)}°C`,
        )
      }
    }

    // Configure optional return temperature sensor
    let characteristicReturnSensor: any
    if (this.dpReturnTemperature && this.device.context.exposeReturnSensor) {
      const services = this.accessory.services.filter(
        (s: any) => s.UUID === Service.TemperatureSensor.UUID && s.displayName.includes('Return'),
      )
      if (services.length > 0) {
        const returnService = services[0]
        characteristicReturnSensor = returnService
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(this._getDividedState(dps[this.dpReturnTemperature], this.returnTemperatureDivisor))
          .on('get', this.getDividedState.bind(this, this.dpReturnTemperature, this.returnTemperatureDivisor))
      }
    }

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      if (changes.hasOwnProperty(this.dpActive)) {
        const newActive = this._getActive(changes[this.dpActive])
        if (characteristicActive.value !== newActive) {
          characteristicActive.updateValue(newActive)
        }
      }

      // The water target changed underneath us: the vendor app, the unit's own
      // panel or a schedule. Reflect it rather than carrying on displaying the
      // room target we last wrote.
      if (changes.hasOwnProperty(this.dpWaterTarget)) {
        const rawWater = Number(changes[this.dpWaterTarget])
        if (Number.isFinite(rawWater)) {
          const water = rawWater / (this.waterTargetDivisor || 1)
          const room = this._roundToStep(this._mapWaterToRoom(water))
          if (room !== this.virtualRoomTarget) {
            this.log.info(
              `[MappedHeatPump] Water target changed externally to ${water}°C, which maps back to room ${room}°C`,
            )
            this.virtualRoomTarget = room
            this.accessory.context.virtualRoomTarget = room
            if (this.characteristicHeatingThresholdTemperature) {
              this.characteristicHeatingThresholdTemperature.updateValue(room)
            }
          }
        }
      }

      if (changes.hasOwnProperty(this.dpReturnTemperature)) {
        const convertedTemp = this._getDividedState(changes[this.dpReturnTemperature], this.returnTemperatureDivisor)
        if (characteristicCurrentTemperature.value !== convertedTemp) {
          this.log.debug(
            `[MappedHeatPump] Return temperature changed - DP ${this.dpReturnTemperature}: raw=${changes[this.dpReturnTemperature]}, converted=${convertedTemp}°C`,
          )
          characteristicCurrentTemperature.updateValue(convertedTemp)

          if (characteristicReturnSensor && characteristicReturnSensor.value !== convertedTemp) {
            characteristicReturnSensor.updateValue(convertedTemp)
          }
        }
      }

      if (
        this.dpOutsideTemperature &&
        changes.hasOwnProperty(this.dpOutsideTemperature) &&
        characteristicOutsideTemperature
      ) {
        const convertedOutside = this._getDividedState(
          changes[this.dpOutsideTemperature],
          this.outsideTemperatureDivisor,
        )
        if (characteristicOutsideTemperature.value !== convertedOutside) {
          this.log.debug(
            `[MappedHeatPump] Outside temperature changed - DP ${this.dpOutsideTemperature}: raw=${changes[this.dpOutsideTemperature]}, converted=${convertedOutside}°C`,
          )
          characteristicOutsideTemperature.updateValue(convertedOutside)
        }
      }

      if (this.dpFlowTemperature && changes.hasOwnProperty(this.dpFlowTemperature) && characteristicFlowTemperature) {
        const convertedFlow = this._getDividedState(changes[this.dpFlowTemperature], this.flowTemperatureDivisor)
        if (characteristicFlowTemperature.value !== convertedFlow) {
          this.log.debug(
            `[MappedHeatPump] Flow temperature changed - DP ${this.dpFlowTemperature}: raw=${changes[this.dpFlowTemperature]}, converted=${convertedFlow}°C`,
          )
          characteristicFlowTemperature.updateValue(convertedFlow)
        }
      }

      this.log.info('MappedHeatPump changed: ' + JSON.stringify(state))

      // Report telemetry for the OpenBridge devices view
      if (this.platform?.reportTelemetry) {
        const active = !!state[this.dpActive]
        const currentTemperature = this._getDividedState(state[this.dpReturnTemperature], this.returnTemperatureDivisor)
        const targetTemperature = this.virtualRoomTarget
        this.platform.reportTelemetry(this.device.context.id, { active, currentTemperature, targetTemperature })
      }
    })

    // Register OpenBridge controls
    if (this.platform?.registerControl) {
      const deviceId = this.device.context.id
      this.platform.registerControl(deviceId, 'active', (value: unknown) => {
        const boolVal = Boolean(value)
        this.setState(this.dpActive, boolVal, () => {})
      })
      this.platform.registerControl(deviceId, 'targetTemperature', (value: unknown) => {
        const roomTarget = Number(value)
        const clamped = Math.max(this.roomTargetMin, Math.min(this.roomTargetMax, roomTarget))
        const waterTarget = this._mapRoomToWater(clamped)
        const clampedWater = Math.max(this.waterTargetMin, Math.min(this.waterTargetMax, waterTarget))
        const raw = Math.round(clampedWater * this.waterTargetDivisor)
        this.setState(this.dpWaterTarget, raw, () => {})
        this.virtualRoomTarget = clamped
        // Persisted like the HomeKit path does. Without this, a target set from
        // the OpenBridge UI was forgotten on the next restart.
        this.accessory.context.virtualRoomTarget = clamped
      })
    }
  }

  getActive(callback: OpenbridgeCallback): void {
    this.getState(this.dpActive, (err: Error | null, dp: DPSValue) => {
      if (err) return callback(err)
      callback(null, this._getActive(dp))
    })
  }

  _getActive(dp: DPSValue): number {
    const { Characteristic } = this.hap
    return dp ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
  }

  setActive(value: DPSValue, callback: OpenbridgeCallback): void {
    const { Characteristic } = this.hap

    switch (value) {
      case Characteristic.Active.ACTIVE:
        return this.setState(this.dpActive, true, callback)
      case Characteristic.Active.INACTIVE:
        return this.setState(this.dpActive, false, callback)
    }

    callback()
  }

  getCurrentHeaterCoolerState(callback: OpenbridgeCallback): void {
    this.getState([this.dpActive], (err: Error | null, dps: DPSState) => {
      if (err) return callback(err)
      callback(null, this._getCurrentHeaterCoolerState(dps))
    })
  }

  _getCurrentHeaterCoolerState(dps: DPSState): number {
    const { Characteristic } = this.hap
    return dps[this.dpActive]
      ? Characteristic.CurrentHeaterCoolerState.HEATING
      : Characteristic.CurrentHeaterCoolerState.INACTIVE
  }

  getTargetHeaterCoolerState(callback: OpenbridgeCallback): void {
    callback(null, this._getTargetHeaterCoolerState())
  }

  _getTargetHeaterCoolerState(): number {
    const { Characteristic } = this.hap
    return Characteristic.TargetHeaterCoolerState.HEAT
  }

  setTargetHeaterCoolerState(value: DPSValue, callback: OpenbridgeCallback): void {
    this.setState(this.dpActive, true, callback)
  }

  getVirtualRoomTarget(callback: OpenbridgeCallback): void {
    callback(null, this.virtualRoomTarget)
  }

  setVirtualRoomTarget(value: number, callback: OpenbridgeCallback): void {
    const clampedRoom = Math.max(this.roomTargetMin, Math.min(this.roomTargetMax, value))
    const waterTarget = this._mapRoomToWater(clampedRoom)
    const clampedWater = Math.max(this.waterTargetMin, Math.min(this.waterTargetMax, waterTarget))
    const waterTargetRaw = Math.round(clampedWater * this.waterTargetDivisor)

    this.log.info(
      `[MappedHeatPump] Virtual room target: ${clampedRoom}°C → mapped water target: ${clampedWater}°C (raw: ${waterTargetRaw})`,
    )

    this.setState(this.dpWaterTarget, waterTargetRaw, (err: Error | null) => {
      if (err) return callback(err)

      this.virtualRoomTarget = clampedRoom
      this.accessory.context.virtualRoomTarget = clampedRoom

      if (this.characteristicHeatingThresholdTemperature) {
        this.characteristicHeatingThresholdTemperature.updateValue(clampedRoom)
      }

      callback()
    })
  }

  /**
   * Map room temperature to water temperature using the mapping table
   * with linear interpolation between points
   */
  /**
   * Water setpoint back to the room target it represents.
   *
   * The inverse of _mapRoomToWater, needed because the water target is not
   * ours alone: it can be changed in the vendor app, on the unit's own panel,
   * or by a schedule. Without reading it back, HomeKit kept showing whatever
   * room target it last wrote while the pump ran at something else entirely,
   * and the two only ever drifted further apart.
   *
   * A flat section of the curve has no single answer (a map ending 22 to 29
   * then 24 to 30 means water 30 could be either). The highest room
   * temperature that produces the value is returned, because that is the one
   * a person asking for that much heat meant.
   */
  /** Snap to the step HomeKit advertises, so the dial lands on a real position. */
  _roundToStep(value: number): number {
    const step = Number(this.device.context.minTemperatureSteps) || 0.5
    return Math.round(value / step) * step
  }

  _mapWaterToRoom(waterTemp: number): number {
    return mapWaterToRoom(this.roomToWaterMap, waterTemp)
  }

  _mapRoomToWater(roomTemp: number): number {
    if (this.roomToWaterMap.length === 0) {
      this.log.warn('[MappedHeatPump] No mapping table defined, using 1:1 mapping')
    }
    return mapRoomToWater(this.roomToWaterMap, roomTemp)
  }
}

export default MappedHeatPumpHeaterAccessory
