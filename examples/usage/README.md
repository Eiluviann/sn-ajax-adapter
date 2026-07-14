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
| Server endpoint | [`inventory-ajax.script-include.js`](inventory-ajax.script-include.js) | — | typed contracts, a value result, and an `AjaxAdapter.fail` business error |
| SP widget | [`widget.client-script.js`](widget.client-script.js) | `getItemStock` | calling from a widget controller + the AngularJS digest gotcha |
| SP widget (type-ahead) | [`widget-type-ahead.client-script.js`](widget-type-ahead.client-script.js) | `searchItems` | `AjaxProxy.channel` — debounced, latest-only search |
| Catalog client script | [`catalog.client-script.js`](catalog.client-script.js) | `getItemStock` | onChange in Service Portal *and* classic, one script |
| Classic backend form | [`classic-form.client-script.js`](classic-form.client-script.js) | `getItemStock` | callback style (`onSuccess`/`onError`) instead of a promise |
| UI Action (write) | [`reserve-item.ui-action.js`](reserve-item.ui-action.js) | `reserveItem` | a write + branching on `error.kind` (business vs server) |

## The one gotcha — widgets

`AjaxProxy` returns a **native** promise, and AngularJS doesn't run a digest when one resolves.
In a widget, wrap the state change in `$timeout` (or `$scope.$apply`) so the view re-renders:

```js
AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: id })
  .then(function (result) {
    $timeout(function () { c.stock = result; }); // re-enter Angular
  });
```

Everywhere else (`g_form`-based catalog/classic scripts, UI Actions) there's no digest to worry
about — just `.then` / `.catch` or the callback handlers.
