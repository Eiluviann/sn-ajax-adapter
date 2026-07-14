# Usage by context

One server endpoint, called the same way from everywhere. [`inventory-ajax.script-include.js`](inventory-ajax.script-include.js)
is a single `AjaxAdapter` endpoint (`InventoryAjax`); every client example below calls it with
the identical `AjaxProxy.call('InventoryAjax', '<method>', {...})` shape. Write the logic once,
call it from a widget, a catalog item, a classic form, or a button.

## Prerequisites

- **`AjaxAdapter` + `AjaxProxy` installed** (import the update set in [`dist/`](../../dist), or the two core records).
- **`AjaxProxy` reachable where the client runs:** Service Portal — the auto-load update set; classic UI — `Global: on` + `UI Type: Desktop`.
- **`InventoryAjax`** (this folder's Script Include) installed, **Client callable: on**.

## The examples

| Context | File | Calls | Shows |
| --- | --- | --- | --- |
| Server endpoint | [`inventory-ajax.script-include.js`](inventory-ajax.script-include.js) | — | typed contracts, value results, an `AjaxAdapter.fail` business error, and a date round-trip |
| SP widget | [`widget.client-script.js`](widget.client-script.js) | `getItemStock` | calling from a widget controller + the AngularJS digest gotcha |
| SP widget (type-ahead) | [`widget-type-ahead.client-script.js`](widget-type-ahead.client-script.js) | `searchItems` | `AjaxProxy.channel` — debounced, latest-only search |
| Catalog client script | [`catalog.client-script.js`](catalog.client-script.js) | `getItemStock` | onChange in Service Portal *and* classic, one script |
| Classic backend form | [`classic-form.client-script.js`](classic-form.client-script.js) | `getItemStock` | callback style (`onSuccess`/`onError`) instead of a promise |
| UI Action (write) | [`reserve-item.ui-action.js`](reserve-item.ui-action.js) | `reserveItem` | a write + branching on `error.kind` (business vs server) |
| Plain browser / UI Page | [`browser-plain.js`](browser-plain.js) | `getItemStock` | no `g_form`; `AjaxProxy.for()` to bind a script include + defaults once |
| Date round-trip | [`date-round-trip.browser.js`](date-round-trip.browser.js) | `getItemsAddedSince` | a JS `Date` in, `Date`s back out (marshalled as `GlideDateTime` server-side) |
| Server-side reuse | [`server-side-reuse.business-rule.js`](server-side-reuse.business-rule.js) | `_getItemStock` (direct) | the class works off the AJAX path — call the private method from a Business Rule |
| App config | [`app-init.ui-script.js`](app-init.ui-script.js) | `getItemStock` | `setErrorHandler` / `setDefaultTimeout` / `setLogTable`, and opt-in `retry` |

**Unit-testable, no transport.** The endpoint's private methods take typed args and return typed
values, so they test directly with a fake `GlideRecord` — no GlideAjax to mock. See
[`tests/inventory-ajax.test.ts`](../../tests/inventory-ajax.test.ts) (`npm test`).

## Widgets — the digest is handled for you (1.2.0+)

`AjaxProxy` returns a **native** promise, and AngularJS doesn't run a digest when a native promise
resolves — so historically a widget had to wrap the state change in `$timeout` / `$scope.$apply`.
As of **1.2.0**, AjaxProxy schedules the digest itself after each call settles, so this just works:

```js
AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: id })
  .then(function (result) { c.stock = result; }); // view re-renders — no $timeout
```

Turn it off with `AjaxProxy.setDigestIntegration(false)` if you drive digests yourself. Outside
Service Portal (`g_form`-based catalog/classic scripts, UI Actions) there's no digest in play anyway.
