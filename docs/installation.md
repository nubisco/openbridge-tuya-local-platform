# Installation

## Option 1: OpenBridge UI (Recommended)

1. Open the OpenBridge UI.
2. Go to **Plugins** > **Marketplace**.
3. Search for `@nubisco/openbridge-tuya-local-platform`.
4. Click **Install**.
5. Restart OpenBridge.

## Option 2: Manual (npm)

Install the plugin into your OpenBridge plugins directory:

```bash
cd ~/.openbridge/plugins/openbridge
npm install @nubisco/openbridge-tuya-local-platform
```

Restart OpenBridge after installation.

## Verify Installation

The plugin should appear in the OpenBridge UI under **Plugins** with status "running".

You can also check the daemon logs for:

```
[INFO] Loaded 1 native plugin(s)
[INFO] [@nubisco/openbridge-tuya-local-platform] Configuration valid
```

## Migrating from Openbridge Tuya Local Platform

If you previously used `@nubisco/@nubisco/openbridge-tuya-local-platform` with Openbridge:

1. Install this plugin in OpenBridge.
2. Copy your device configurations (IDs, keys, types) to the OpenBridge config.
3. All device type configurations are fully compatible -- no changes needed.

The plugin creates its own standalone HAP bridge, so your existing HomeKit pairings will need to be re-established.
