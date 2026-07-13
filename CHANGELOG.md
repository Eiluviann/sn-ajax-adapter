# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

Both `src/ajax-adapter.script-include.js` and `src/ajax-proxy.ui-script.js`
ship the same version number, exposed at runtime as `AjaxAdapter.VERSION`
and `AjaxProxy.VERSION`. Bump both together on every change so a developer
can tell which version is installed on an instance by checking either one.

## [1.1.0] - 2026-07-13

The wire format grew in this release (date tags, version param) — install the
1.1.0 `AjaxAdapter` and `AjaxProxy` together.

### Added

- **Parameter contracts.** `expose()` entries can be
  `{ name, type?, required?, default? }` objects. Violations reject with kind
  `badRequest`, all listed in one message, and the private method never runs —
  guard clauses move out of your methods. Types: `string`, `number`,
  `boolean`, `object`, `array`, `date`. Plain string entries work unchanged.
- **Date marshalling.** A client `Date` parameter arrives server-side as a
  real `GlideDateTime`, and a returned `GlideDateTime` (or server `Date`)
  resolves client-side as a `Date`. Travels as
  `{ "$dateTime": "<ISO 8601 UTC>" }`. Opt out per call with
  `{ dates: false }`.
- **Loud serialization guardrail.** Returning a `GlideElement` or any other
  Java object now fails as a logged server error naming the offending key,
  instead of silently serializing as `{}`.
- **Version-skew warning.** The proxy sends its version with every call; the
  adapter logs a warning when the two files' major.minor differ.
- **Payload size cap.** Payloads over `AjaxAdapter.MAX_PAYLOAD_LENGTH`
  (default 1,000,000 characters, reassignable) reject as `badRequest`.

### Changed

- A JS `Date` parameter now reaches the private method as a `GlideDateTime`
  (previously its ISO string via `Date.toJSON`). Pass `{ dates: false }` to
  restore the old behavior for a specific call.
- An empty payload now goes through contract enforcement, so a `required`
  parameter is rejected even when no payload was sent at all.

## [1.0.1] - 2026-07-13

### Fixed

- `AjaxProxy` (callback style): a throw inside `onComplete`, or inside the
  global error handler while it reports a callback error, no longer leaks an
  unhandled rejection or skips `onComplete`. The "onComplete always runs"
  guarantee now holds on every path.
- `AjaxAdapter.readArguments`: a JSON *array* payload is now rejected with
  kind `badRequest` instead of silently resolving every argument to
  `undefined` (arrays are `typeof 'object'` too).
- `AjaxAdapter.fail()`: requires a non-empty string message. Misuse now
  surfaces as a logged `server` error instead of shipping a blank business
  message to the client.
- `AjaxProxy`: removed the dead read of `error.method` from the server
  envelope — the adapter deliberately never emits it.

### Added

- Vitest test suite (`tests/`) covering both files against stubbed platform
  globals (`GlideAjax`, `gs`, `Class`) — retry backoff, channel
  debounce/stale-drop, timeout settle guard, envelope validation, and the
  full argument-parsing contract. Run with `npm install && npm test`.
- Docs: return plain JS values from private methods; coerce Glide values
  with `String()` / `Number()` at the boundary.

## [1.0.0] - 2026-07-13

Initial release.

- `AjaxAdapter.expose()` / `AjaxAdapter.fail()`: server-side adapter from a
  typed private method to the GlideAjax calling convention.
- `AjaxProxy.call()` / `.for()` / `.channel()`: client-side promise-based
  caller with typed errors, timeout, and opt-in retry.
