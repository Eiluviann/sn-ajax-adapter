# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

Both `src/ajax-adapter.script-include.js` and `src/ajax-proxy.ui-script.js`
ship the same version number, exposed at runtime as `AjaxAdapter.VERSION`
and `AjaxProxy.VERSION`. Bump both together on every change so a developer
can tell which version is installed on an instance by checking either one.

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
