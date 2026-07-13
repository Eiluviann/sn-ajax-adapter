# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

Both `src/ajax-adapter.script-include.js` and `src/ajax-proxy.ui-script.js`
ship the same version number, exposed at runtime as `AjaxAdapter.VERSION`
and `AjaxProxy.VERSION`. Bump both together on every change so a developer
can tell which version is installed on an instance by checking either one.

## [1.0.0] - 2026-07-13

Initial release.

- `AjaxAdapter.expose()` / `AjaxAdapter.fail()`: server-side adapter from a
  typed private method to the GlideAjax calling convention.
- `AjaxProxy.call()` / `.for()` / `.channel()`: client-side promise-based
  caller with typed errors, timeout, and opt-in retry.
