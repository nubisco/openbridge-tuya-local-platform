---
layout: nubisco
title: 'Troubleshooting'
---

## Device Not Discovered

- Ensure the device is **powered on** and connected to the same network as OpenBridge.
- Verify the **Device ID** and **Local Key** are correct.
- Try adding the `"ip"` parameter to the device config to bypass auto-discovery.
- Check that no other application (e.g. another Tuya plugin) is holding a connection — Tuya devices typically allow only **one LAN connection** at a time.

## Device Appears but Cannot Be Controlled

This usually means the DataPoint (DP) mapping is wrong for your device:

- Check the OpenBridge log for DP values being reported by the device.
- Verify the `type` in your config matches your actual device.
- Some devices require custom DP overrides via context parameters (e.g. `dpPower`, `dpMode`).

## "Not connected" Errors

- The device may have gone offline or changed IP.
- Restart OpenBridge to trigger re-discovery.
- Set a static IP on the device via your router's DHCP settings and add `"ip"` to the config.

## Repeated Reconnect Messages

A device that is unreachable is reported once, not once per retry:

```
Device A2 Bulb 100w became unreachable; attempting to reconnect (ERR_PING_TIMED_OUT)
Device A2 Bulb 100w is reachable again (1m 22s)
```

The individual socket errors behind an ongoing outage (`ECONNRESET`, `EHOSTUNREACH`,
`ERR_PING_TIMED_OUT`, `ERR_CONNECTION_TIMED_OUT`) are still logged at debug level. Set the
log level filter in the OpenBridge log panel to debug to see them.

Reconnection behaviour itself is unchanged: the plugin keeps retrying either way.

## Local Key Changed

Local keys can rotate when:

- A device is re-paired to the Tuya/Smart Life app.
- Firmware is updated.
- The device is factory reset.

Re-extract the local key using the method described in [Getting Local Keys](./get-local-keys).

## Protocol Version Mismatch

If a device does not respond, try setting the `"version"` parameter explicitly:

```json
{
  "name": "My Device",
  "type": "Outlet",
  "id": "...",
  "key": "...",
  "version": "3.3"
}
```

Supported versions: `3.1`, `3.3`, `3.4`.
