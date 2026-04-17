import path from 'path'
import os from 'os'
import { z } from 'zod'
import TuyaAccessory from './protocol/TuyaAccessory'
import TuyaDiscovery from './protocol/TuyaDiscovery'

import {
  EnergyCharacteristicsFactory,
  OutletAccessory,
  SimpleLightAccessory,
  MultiOutletAccessory,
  CustomMultiOutletAccessory,
  RGBTWLightAccessory,
  RGBTWOutletAccessory,
  TWLightAccessory,
  AirConditionerAccessory,
  AirPurifierAccessory,
  DehumidifierAccessory,
  ConvectorAccessory,
  GarageDoorAccessory,
  SimpleDimmerAccessory,
  SimpleDimmer2Accessory,
  SimpleBlindsAccessory,
  SimpleHeaterAccessory,
  MappedHeatPumpHeaterAccessory,
  CircuitBreakerMonitorAccessory,
  SimpleFanAccessory,
  SimpleFanLightAccessory,
  SwitchAccessory,
  ValveAccessory,
  OilDiffuserAccessory,
} from './accessories'

import type { ClassDefMap, TuyaDeviceConfig, TuyaPlatformConfig } from './types'

const PLUGIN_NAME = 'openbridge-tuya-local-platform'
const PLATFORM_NAME = 'TuyaLocalPlatform'

let PLUGIN_VERSION = '1.0.0'
try {
  PLUGIN_VERSION = require('../package.json').version
} catch {
  /* use default */
}

// ---- OpenBridge native plugin types (inlined to preserve CommonJS build compat) ----
// @openbridge/sdk is ESM-only, so types are defined locally instead of imported.
interface PluginLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
  reportTelemetry(deviceId: string, data: Record<string, unknown>): void
  registerDevice(device: { id: string; name: string; widgetType: string; manufacturer?: string; model?: string }): void
  registerControl(deviceId: string, controlId: string, handler: (value: unknown) => void | Promise<void>): void
}

function definePlugin<T extends { manifest: { name: string; version: string } }>(plugin: T): T {
  return plugin
}

// ---- Zod config schemas ----

const VALID_TYPES = Object.keys({
  outlet: true,
  simplelight: true,
  rgbtwlight: true,
  rgbtwoutlet: true,
  twlight: true,
  multioutlet: true,
  custommultioutlet: true,
  airconditioner: true,
  airpurifier: true,
  dehumidifier: true,
  convector: true,
  garagedoor: true,
  simpledimmer: true,
  simpledimmer2: true,
  simpleblinds: true,
  simpleheater: true,
  mappedheatpumpheater: true,
  circuitbreakermonitor: true,
  switch: true,
  fan: true,
  fanlight: true,
  watervalve: true,
  oildiffuser: true,
})

const TuyaDeviceConfigSchema = z
  .object({
    id: z.string().min(1, 'Device ID is required'),
    key: z.string().min(1, 'Device key is required'),
    type: z
      .string()
      .min(1, 'Device type is required')
      .refine(
        (t) => VALID_TYPES.includes(t.toLowerCase()),
        (t) => ({ message: `Unknown device type "${t}". Valid types: ${VALID_TYPES.join(', ')}` }),
      ),
    ip: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    fake: z.boolean().optional(),
  })
  .passthrough()

const NativeBridgeConfigSchema = z
  .object({
    name: z.string().default('Tuya Local'),
    username: z.string().default('CC:22:3D:E3:CE:30'),
    pincode: z
      .string()
      .regex(/^\d{3}-\d{2}-\d{3}$/, 'PIN format must be XXX-XX-XXX')
      .default('031-45-154'),
    hapPort: z.number().int().min(1).max(65535).default(51827),
  })
  .optional()

const NativePluginConfigSchema = z
  .object({
    devices: z.array(TuyaDeviceConfigSchema).default([]),
    bridge: NativeBridgeConfigSchema,
  })
  .passthrough()

// ---- Logger helpers ----

// Creates a callable logger compatible with Openbridge's Logger interface from a PluginLogger.
function wrapLogger(log: PluginLogger): any {
  const fn = (message: string, ...args: unknown[]) => log.info(message, ...args)
  fn.info = (message: string, ...args: unknown[]) => log.info(message, ...args)
  fn.warn = (message: string, ...args: unknown[]) => log.warn(message, ...args)
  fn.error = (message: string, ...args: unknown[]) => log.error(message, ...args)
  fn.debug = (message: string, ...args: unknown[]) => log.debug(message, ...args)
  fn.log = (level: string, message: string, ...args: unknown[]) => {
    const method: ((...a: unknown[]) => void) | undefined = (log as any)[level]
    ;(method ?? log.info).call(log, message, ...args)
  }
  fn.success = (message: string, ...args: unknown[]) => log.info(message, ...args)
  return fn
}

// ---- hap-nodejs loader for native mode ----

function loadHap(log: PluginLogger): any {
  const candidates = [
    'hap-nodejs',
    path.resolve(__dirname, '../node_modules/hap-nodejs'),
    path.resolve(__dirname, '../../node_modules/hap-nodejs'),
    path.resolve(__dirname, '../../../node_modules/hap-nodejs'),
    path.resolve(__dirname, '../../../../node_modules/hap-nodejs'),
    path.resolve(process.cwd(), 'node_modules/hap-nodejs'),
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      /* try next candidate */
    }
  }
  log.error('hap-nodejs not found. Add it as a peer dependency or install it alongside this plugin.')
  throw new Error('hap-nodejs not found')
}

// ---- Minimal OpenbridgeAPI shim for native mode ----
// Provides just the HAP surface that TuyaLocalPlatform (and its accessories) need.

function createOpenbridgeShim(hapNodeJs: any, bridge: any, log: PluginLogger): any {
  const { EventEmitter } = require('events')

  const HapAccessoryBase: any = hapNodeJs.Accessory

  class PlatformAcc extends HapAccessoryBase {
    context: any = {}

    constructor(displayName: string, uuid: string, category?: number) {
      super(displayName, uuid)
      if (category !== undefined) this.category = category
    }

    // Match Openbridge behavior: when a service of the same UUID already exists,
    // use displayName as a subtype so hap-nodejs does not throw on duplicates.
    addService(serviceType: any, ...args: any[]): any {
      if (typeof serviceType === 'function' && args.length >= 1 && args[1] === undefined) {
        const displayName = args[0]
        const typeUUID: string | undefined = serviceType.UUID
        if (displayName && typeUUID) {
          const hasConflict = (this as any).services?.some((s: any) => s.UUID === typeUUID)
          if (hasConflict) return super.addService(serviceType, displayName, displayName)
        }
      }
      return super.addService(serviceType, ...args)
    }
  }

  const accessories = new Map<string, any>()
  const shim = new EventEmitter()

  shim.hap = {
    ...hapNodeJs,
    uuid: hapNodeJs.uuid,
    Accessory: { Categories: hapNodeJs.Categories },
    AdaptiveLightingController: hapNodeJs.AdaptiveLightingController ?? null,
  }
  shim.platformAccessory = PlatformAcc
  shim.user = {
    storagePath: () => path.resolve(os.homedir(), '.openbridge'),
    configPath: () => path.resolve(os.homedir(), '.openbridge', 'config.json'),
    persistPath: () => path.resolve(os.homedir(), '.openbridge', 'persist'),
    cachedAccessoryPath: () => path.resolve(os.homedir(), '.openbridge', 'accessories'),
  }
  shim.versionGreaterOrEqual = () => false

  shim.registerPlatformAccessories = (_pn: string, _pnm: string, accs: any | any[]) => {
    for (const acc of Array.isArray(accs) ? accs : [accs]) {
      if (!acc?.UUID) {
        log.warn(`Skipping accessory with no UUID: ${acc?.displayName}`)
        continue
      }
      accessories.set(acc.UUID, acc)
      try {
        bridge.addBridgedAccessory(acc)
        log.debug(`Bridged: ${acc.displayName}`)
      } catch (err) {
        log.warn(`Could not bridge accessory ${acc.displayName}: ${err}`)
      }
    }
  }

  shim.unregisterPlatformAccessories = (_pn: string, _pnm: string, accs: any[]) => {
    for (const acc of accs) {
      accessories.delete(acc.UUID)
      try {
        bridge.removeBridgedAccessory(acc, false)
      } catch {
        /* not found */
      }
    }
  }

  return shim
}

const CLASS_DEF: ClassDefMap = {
  outlet: OutletAccessory,
  simplelight: SimpleLightAccessory,
  rgbtwlight: RGBTWLightAccessory,
  rgbtwoutlet: RGBTWOutletAccessory,
  twlight: TWLightAccessory,
  multioutlet: MultiOutletAccessory,
  custommultioutlet: CustomMultiOutletAccessory,
  airconditioner: AirConditionerAccessory,
  airpurifier: AirPurifierAccessory,
  dehumidifier: DehumidifierAccessory,
  convector: ConvectorAccessory,
  garagedoor: GarageDoorAccessory,
  simpledimmer: SimpleDimmerAccessory,
  simpledimmer2: SimpleDimmer2Accessory,
  simpleblinds: SimpleBlindsAccessory,
  simpleheater: SimpleHeaterAccessory,
  mappedheatpumpheater: MappedHeatPumpHeaterAccessory,
  circuitbreakermonitor: CircuitBreakerMonitorAccessory,
  switch: SwitchAccessory,
  fan: SimpleFanAccessory,
  fanlight: SimpleFanLightAccessory,
  watervalve: ValveAccessory,
  oildiffuser: OilDiffuserAccessory,
}

// Module-level HAP globals — set by nativePlugin.start() before TuyaLocalPlatform is instantiated.
let Characteristic: any, PlatformAccessory: any, Service: any, Categories: any, UUID: any

// ---- TuyaLocalPlatform internal implementation ----

class TuyaLocalPlatform {
  log: any
  config: TuyaPlatformConfig
  api: any
  reportTelemetry?: (deviceId: string, data: Record<string, unknown>) => void
  registerControl?: (deviceId: string, controlId: string, handler: (value: unknown) => void | Promise<void>) => void
  private _hapAccessories: Map<string, any> = new Map()

  constructor(...props: any[]) {
    ;[this.log, this.config, this.api] = [...props]

    this.api.hap.EnergyCharacteristics = EnergyCharacteristicsFactory(this.api.hap.Characteristic)

    if (!this.config || !this.config.devices) {
      this.log.warn('No devices found. Check that you have specified them in your config.')
      return
    }

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices()
    })
  }

  discoverDevices(): void {
    const devices: Record<string, TuyaDeviceConfig & { name: string }> = {}
    const connectedDevices: string[] = []
    const fakeDevices: (TuyaDeviceConfig & { name: string })[] = []

    this.config.devices.forEach((device: TuyaDeviceConfig) => {
      try {
        device.id = ('' + device.id).trim()
        device.key = ('' + device.key).trim()
        device.type = ('' + device.type).trim()
        device.ip = ('' + (device.ip || '')).trim()
      } catch (_ex) {
        /* ignore */
      }

      if (!device.type)
        return this.log.error("%s (%s) doesn't have a type defined.", device.name || 'Unnamed device', device.id)
      if (!CLASS_DEF[device.type.toLowerCase()])
        return this.log.error("%s (%s) doesn't have a valid type defined.", device.name || 'Unnamed device', device.id)

      if (device.fake) fakeDevices.push({ name: device.id.slice(8), ...device })
      else devices[device.id] = { name: device.id.slice(8), ...device }
    })

    const deviceIds = Object.keys(devices)
    if (deviceIds.length === 0) return this.log.error('No valid configured devices found.')

    this.log.info('Starting discovery...')

    TuyaDiscovery.start({ ids: deviceIds, log: this.log }).on('discover', (config: any) => {
      if (!config || !config.id) return
      if (!devices[config.id])
        return this.log.warn('Discovered a device that has not been configured yet (%s@%s).', config.id, config.ip)

      connectedDevices.push(config.id)

      this.log.info(
        'Discovered %s (%s) identified as %s (%s)',
        devices[config.id].name,
        config.id,
        devices[config.id].type,
        config.version,
      )

      const device = new TuyaAccessory({
        ...devices[config.id],
        ...config,
        log: this.log,
        UUID: UUID.generate(PLUGIN_NAME + ':' + config.id),
        connect: false,
      })
      this.addAccessory(device)
    })

    fakeDevices.forEach((config) => {
      this.log.info('Adding fake device: %s', config.name)
      this.addAccessory(
        new TuyaAccessory({
          ...config,
          log: this.log,
          UUID: UUID.generate(PLUGIN_NAME + ':fake:' + config.id),
          connect: false,
        }),
      )
    })

    setTimeout(() => {
      deviceIds.forEach((deviceId) => {
        if (connectedDevices.includes(deviceId)) return

        if (devices[deviceId].ip) {
          this.log.info(
            'Failed to discover %s (%s) in time but will connect via %s.',
            devices[deviceId].name,
            deviceId,
            devices[deviceId].ip,
          )

          const device = new TuyaAccessory({
            ...devices[deviceId],
            log: this.log,
            UUID: UUID.generate(PLUGIN_NAME + ':' + deviceId),
            connect: false,
          })
          this.addAccessory(device)
        } else {
          this.log.warn('Failed to discover %s (%s) in time but will keep looking.', devices[deviceId].name, deviceId)
        }
      })
    }, 60000)
  }

  registerPlatformAccessories(platformAccessories: any | any[]): void {
    this.api.registerPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      Array.isArray(platformAccessories) ? platformAccessories : [platformAccessories],
    )
  }

  addAccessory(device: any): void {
    const deviceConfig = device.context
    const type = (deviceConfig.type || '').toLowerCase()
    const Accessory = CLASS_DEF[type]

    const accessory = new PlatformAccessory(deviceConfig.name, deviceConfig.UUID, Accessory.getCategory(Categories))
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, deviceConfig.manufacturer || 'Unknown')
      .setCharacteristic(Characteristic.Model, deviceConfig.model || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, deviceConfig.id.slice(8))

    this._hapAccessories.set(deviceConfig.UUID, accessory)
    new Accessory(this, accessory, device, true)
  }

  removeAccessory(hapAccessory: any): void {
    if (!hapAccessory) return
    this.log.warn('Unregistering', hapAccessory.displayName)
    this._hapAccessories.delete(hapAccessory.UUID)
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [hapAccessory])
  }

  removeAccessoryByUUID(uuid: string): void {
    if (uuid) this.removeAccessory(this._hapAccessories.get(uuid))
  }
}

// ---- Device type mapping ----

function tuyaTypeToWidgetType(type: string): string {
  const t = type.toLowerCase()
  if (['outlet', 'multioutlet', 'custommultioutlet'].includes(t)) return 'switch'
  if (['simplelight', 'twlight', 'rgbtwlight', 'simpledimmer'].includes(t)) return 'light'
  if (['mappedheatpumpheater', 'simpleheater', 'convector'].includes(t)) return 'thermostat'
  if (t === 'dehumidifier') return 'dehumidifier'
  if (t === 'circuitbreakermonitor') return 'energy_meter'
  if (t === 'airconditioner') return 'thermostat'
  return 'sensor'
}

// ---- OpenBridge native plugin ----
//
// Loaded via plugins[] in ~/.openbridge/config.json.
// Creates a standalone HAP bridge using hap-nodejs — pair it separately in the Home app.
//
// Example config.json entry:
//
//   {
//     "name": "openbridge-tuya-local-platform",
//     "config": {
//       "devices": [ { "id": "...", "key": "...", "type": "outlet" } ],
//       "bridge": { "pincode": "031-45-154", "hapPort": 51827 }
//     }
//   }

const nativePlugin = definePlugin({
  manifest: {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: 'Control Tuya devices locally over LAN without cloud dependency',
    author: 'José Silva',
  },

  async setup(ctx: PluginContext) {
    ctx.log.info('Validating configuration...')
    const result = NativePluginConfigSchema.safeParse(ctx.config)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      ctx.log.error(`Configuration is invalid:\n${issues}`)
      throw new Error('Invalid plugin configuration — check the errors above and restart')
    }
    if (result.data.devices.length === 0) {
      ctx.log.warn('No devices configured — plugin started in unconfigured state. Add devices via the UI.')
    } else {
      ctx.log.info(`Configuration valid — ${result.data.devices.length} device(s) configured`)
    }
  },

  async start(ctx: PluginContext) {
    const hap = loadHap(ctx.log)

    const bridgeCfg = (ctx.config.bridge as Record<string, unknown>) ?? {}
    const bridgeName = (bridgeCfg.name as string | undefined) ?? 'Tuya Local'
    const username = (bridgeCfg.username as string | undefined) ?? 'CC:22:3D:E3:CE:30'
    const pincode = (bridgeCfg.pincode as string | undefined) ?? '031-45-154'
    const hapPort = (bridgeCfg.hapPort as number | undefined) ?? 51827

    const storagePath = path.resolve(os.homedir(), '.openbridge', 'hap-storage')
    hap.HAPStorage.setCustomStoragePath(storagePath)

    const bridge = new hap.Bridge(bridgeName, hap.uuid.generate(bridgeName))
    bridge
      .getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Nubisco')
      .setCharacteristic(hap.Characteristic.Model, 'OpenBridge Tuya Local')

    const shim = createOpenbridgeShim(hap, bridge, ctx.log)

    // Set the module-level HAP globals used by TuyaLocalPlatform and accessory classes.
    Characteristic = hap.Characteristic
    Service = hap.Service
    Categories = hap.Categories
    UUID = hap.uuid
    PlatformAccessory = shim.platformAccessory

    shim.hap.EnergyCharacteristics = EnergyCharacteristicsFactory(hap.Characteristic)

    const platformConfig: TuyaPlatformConfig = {
      platform: PLATFORM_NAME,
      name: bridgeName,
      devices: (ctx.config.devices as TuyaDeviceConfig[]) ?? [],
    }

    const platformLog = wrapLogger(ctx.log)
    const platform = new TuyaLocalPlatform(platformLog, platformConfig, shim)
    platform.reportTelemetry = ctx.reportTelemetry.bind(ctx)
    platform.registerControl = ctx.registerControl.bind(ctx)

    // Register devices so they appear in the OpenBridge devices view
    const deviceList = (ctx.config.devices as TuyaDeviceConfig[]) ?? []
    for (const device of deviceList) {
      ctx.registerDevice({
        id: device.id,
        name: device.name ?? device.id,
        widgetType: tuyaTypeToWidgetType(device.type),
        manufacturer: (device as any).manufacturer,
        model: (device as any).model,
      })
    }

    // Give the platform a tick to register before emitting didFinishLaunching.
    setTimeout(() => shim.emit('didFinishLaunching'), 100)

    bridge.publish({
      username,
      pincode,
      port: hapPort,
      category: hap.Categories.BRIDGE,
    })

    ctx.log.info(`HAP bridge published on port ${hapPort} — pair with PIN: ${pincode}`)
    ;(ctx as any)._bridge = bridge
  },

  async stop(ctx: PluginContext) {
    const bridge = (ctx as any)._bridge
    if (bridge) {
      try {
        bridge.unpublish()
      } catch {
        /* ignore */
      }
      ctx.log.info('HAP bridge stopped')
    }
  },
})

// The OpenBridge native loader does: (await import(path)).default ?? mod
// For CJS modules, dynamic import() wraps module.exports as `default`.
// Exporting the plugin object directly means: mod.default === nativePlugin.

module.exports = nativePlugin
