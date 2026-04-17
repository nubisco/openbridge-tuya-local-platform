declare module 'yaml'

// Temporary module declaration for 'openbridge' types.
// These re-export hap-nodejs types that plugin accessories need.
// Once @openbridge/sdk publishes HAP-compatible types, this can be replaced
// with: import type { ... } from '@openbridge/sdk'
declare module 'openbridge' {
  import { Accessory, Service as HAPService } from 'hap-nodejs'

  export interface PlatformAccessory extends Accessory {
    context: any
    getServiceByUUIDAndSubType(uuid: { UUID: string } | string, subtype: string): HAPService | undefined
    configureController(controller: any): void
  }

  export type { Service, Characteristic, CharacteristicValue, WithUUID, Categories } from 'hap-nodejs'

  export interface API {
    hap: typeof import('hap-nodejs')
    on(event: string, listener: (...args: any[]) => void): void
    emit(event: string, ...args: any[]): void
    registerPlatformAccessories(pluginName: string, platformName: string, accessories: any[]): void
    unregisterPlatformAccessories(pluginName: string, platformName: string, accessories: any[]): void
    platformAccessory: any
    user: {
      storagePath(): string
      configPath(): string
      persistPath(): string
      cachedAccessoryPath(): string
    }
    versionGreaterOrEqual?(version: string): boolean
  }

  export interface Logger {
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
    debug(message: string, ...args: unknown[]): void
    log?(level: string, message: string, ...args: unknown[]): void
    success?(message: string, ...args: unknown[]): void
  }
}
