# Error codes

## RackError

Errors cross the backplane as `RackError`s with a `code`, a `message`, and optional `data`.

A device gives its callers codes of its own by throwing `new RackError(code, message, data?)`. Its codes must not start with `RACK_`, except `RACK_OVERLOADED` for a limit of its own; any other exception reaches the caller as `RACK_DEVICE_FAULT`, as [Data and errors](../guides/devices.md#data-and-errors) describes.

## Codes

| Code | Meaning |
|---|---|
| `RACK_TIMEOUT` | The call timed out. |
| `RACK_CANCELLED` | The caller cancelled the call. |
| `RACK_LINK_DOWN` | The provider is offline, resetting, faulted, or retired, or the rack is stopped. |
| `RACK_NO_ROUTE` | No such device, port, or method. |
| `RACK_INVALID_INPUT` / `RACK_INVALID_OUTPUT` | Input or output failed its schema, cannot be cloned, or lists a buffer that cannot be transferred. |
| `RACK_INVALID_CONFIG` | A device's configuration failed its schema. |
| `RACK_DEVICE_FAULT` | The device threw a non-`RackError` exception, crashed, hung until a watchdog bit, stopped answering its hooks while it stopped, or has a stuck thread. |
| `RACK_OVERLOADED` | The call would exceed `queueLimit`, or the device refused it for a limit of its own. |
| `RACK_MANIFEST` | The manifest or the assembly is invalid. |
| `RACK_SWAP_REJECTED` | A swap, plug, unplug, or reload was refused, for example while a thread of the device is stuck, or a fault injection, in a rack started without `faultInjection` or for a hang while watchdogs are off. |
| `RACK_HOOK_FAILED` | A lifecycle hook failed or timed out. |

## Codes of the standard devices

| Code | Device | Meaning |
|---|---|---|
| `SQL_ERROR` | `sqlite` | The database failed the statement. `data.code` holds the driver's code, such as `SQLITE_CONSTRAINT_UNIQUE`. |
