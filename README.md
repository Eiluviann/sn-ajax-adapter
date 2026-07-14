# sn-ajax-adapter

Type-safe, boilerplate-free GlideAjax for ServiceNow. Write a typed, unit-testable method on the server. Call it from the browser like a promise. No `getParameter`/`JSON.parse`/`JSON.stringify` plumbing, no string-typed parameters, no guessing what went wrong.

- **`AjaxAdapter`** (server) turns a plain private method into a client-callable endpoint.
- **`AjaxProxy`** (client) calls it and hands you back a real `Promise` with typed errors.

> The styled, full documentation lives in [`docs/ajax-adapter.mdx`](docs/ajax-adapter.mdx). This README is the plain-Markdown version.

## Install

### Option A — import the update set (recommended)

[`dist/ajax-adapter-v1.1.0.update-set.xml`](dist/ajax-adapter-v1.1.0.update-set.xml) installs everything: both core records, Service Portal auto-load, and the guardrails.

1. **Retrieved Update Sets → Import Update Set from XML** → upload the file.
2. Open the **`AjaxAdapter v1.1.0`** set → **Preview Update Set**, then **Commit Update Set**.
3. Run the Fix Script **`AjaxAdapter - link Include to themes`** — it links `AjaxProxy` to every Service Portal theme. (Fix Scripts don't run automatically on commit.)

Done. `AjaxProxy` now loads on every portal, its config is guarded (Global + UI Type Desktop + Active are enforced, and the `AjaxProxy`/`AjaxAdapter` records are protected from deletion), and current adoption shows as a banner on the `m2m_sp_theme_js_include` link form.

**Uninstall:** set the system property **`ajaxadapter.portal.lock`** to `false` to release all guardrails, then delete the records.

### Option B — two records by hand

If you only want the core (no Service Portal auto-load or guardrails), create just these:

| Record | Type | Setting | Source |
| --- | --- | --- | --- |
| `AjaxAdapter` | Script Include | Client callable **off**. Accessible from **all application scopes** if shared | [`src/ajax-adapter.script-include.js`](src/ajax-adapter.script-include.js) |
| `AjaxProxy` | UI Script | **Global: on**, **UI Type: Desktop** (never "All") | [`src/ajax-proxy.ui-script.js`](src/ajax-proxy.ui-script.js) |

**Service Portal (manual).** The Global flag is a classic-UI loader; a portal won't pick it up from that alone — load `AjaxProxy` explicitly, either as a **JS Include** on the portal **Theme** (whole portal) or a widget **Dependency** (specific widgets). The update set (Option A) wires this across every theme for you.

> ⚠️ **Keep the UI Script on `UI Type = Desktop`, never `All`.** The platform's global UI-Script auto-loader only emits scripts whose UI Type is `Desktop`. Setting it to `All` (or `Mobile`) drops it from that bucket, so it **silently stops loading in both the classic UI and Service Portal** — a top-level `console.log` won't even fire. `Global: on` + `UI Type: Desktop` is the working combination. (Option A enforces this automatically.)

## Quick start

**Server**: a Script Include extending `AbstractAjaxProcessor`. Pair each public method with a private one, so the public method is one line.

```js
var UserLookupAjax = Class.create();
UserLookupAjax.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {

  // Public: the GlideAjax boundary. Maps { userId } from the client to the private args
  // and enforces the contract: a missing/mistyped userId rejects as badRequest.
  getUserSummary: AjaxAdapter.expose('_getUserSummary', [
    { name: 'userId', type: 'string', required: true },
  ]),

  // Private: typed in, typed out, unit-testable. No getParameter, no JSON, no try/catch, no guards.
  _getUserSummary: function(userId) {
    var gr = new GlideRecord('sys_user');
    if (!gr.get(userId)) {
      throw AjaxAdapter.fail('No user matches that id'); // expected failure, safe to show
    }
    return { name: String(gr.getValue('name')), email: String(gr.getValue('email')) };
  },

  type: 'UserLookupAjax',
});
```

**Client**: call it.

```js
AjaxProxy.call('UserLookupAjax', 'getUserSummary', { userId: g_form.getUniqueValue() })
  .then(summary => g_form.addInfoMessage(summary.name))
  .catch(error => g_form.addErrorMessage(error.message));
```

That's the whole loop. A complete, runnable example is in [`examples/user-lookup-ajax.script-include.js`](examples/user-lookup-ajax.script-include.js).

## Why use it

- **No boilerplate.** No `getParameter`, `JSON.parse`, `JSON.stringify`, or per-method `try/catch`. The public method is a single line.
- **Types survive the wire.** `42` arrives as `42`, not `"42"`. `null` stays `null`, `undefined` stays `undefined`. Raw GlideAjax stringifies everything.
- **Dates survive too.** A JS `Date` parameter arrives server-side as a real `GlideDateTime`; a returned `GlideDateTime` resolves client-side as a `Date`. Always the UTC instant, never a timezone-shifted string.
- **Declared parameter contracts.** `{ name, type, required, default }` at the boundary. Violations reject as `badRequest` with every problem listed at once, and your private method never runs — so it needs no guard clauses.
- **Unit-testable logic.** Private methods take typed args and return typed values. Call `new UserLookupAjax()._getUserSummary(id)` directly in ATF or any harness. No transport to mock.
- **Real promises.** `.then` / `.catch` / `.finally`, `async/await`, or callbacks, your pick, same method.
- **Typed errors.** Branch on `error.kind`, never `indexOf` a message string.
- **Safe by default.** A server bug is logged with a correlation id and anonymized to the client. No stack, table, or sys_id leaks. The console links straight to the log row.
- **Collision-proof params.** A parameter named `name`, `order`, or `constructor` can't clobber GlideAjax internals.
- **Resilient.** Every call has a timeout instead of hanging forever, with opt-in retry for transient failures.

## Before and after

**Calling from the client**

```js
// Before: raw GlideAjax. String params, manual parse, no idea if the answer is data or an error.
var ga = new GlideAjax('UserLookupAjax');
ga.addParam('sysparm_name', 'getUserSummary');
ga.addParam('sysparm_userId', userId);
ga.getXMLAnswer(function(answer) {
  var summary = JSON.parse(answer);
  render(summary);
});
```

```js
// After: a promise with typed errors.
AjaxProxy.call('UserLookupAjax', 'getUserSummary', { userId })
  .then(render)
  .catch(error => showError(error.message));
```

**Handling errors**

```js
// Before: brittle string matching on an untyped answer.
ga.getXMLAnswer(function(answer) {
  if (!answer) { /* ACL? typo? timeout? */ }
  var data = JSON.parse(answer);
  if (data.error && data.error.indexOf('not found') > -1) { /* ... */ }
});
```

```js
// After: branch on a field.
.catch(error => {
  if (error.kind === AjaxProxy.ErrorKind.BUSINESS) showUser(error.message);
  else logBug(error.reference); // server bug: deep-links to the log row
});
```

## Features

Each is independent and none complicates the basic `call`.

- **Promise or callbacks, same method.** Pass `{ onSuccess, onError, onComplete }` instead of chaining when it reads better.
- **`AjaxProxy.for(name, defaults)`.** Bind a script include and shared options once: `const users = AjaxProxy.for('UserLookupAjax'); users('getUserSummary', { userId })`.
- **`AjaxProxy.channel(name, method, { debounce, latest })`.** Type-ahead without race conditions. Only the latest result lands.
- **`AjaxProxy.setErrorHandler(fn)`.** Route every unhandled failure through your own sink (toast, banner, telemetry).
- **Opt-in retry.** `retry: true` (once on timeout), a number, or `{ attempts, delay, on }`. Off by default, and only worth enabling for idempotent (read) methods.
- **Console-to-log deep links.** A server bug prints a link straight to its log row. Use `AjaxProxy.setLogTable('syslog_app_scope')` for scoped apps.

## `error.kind`

| `kind` | When | What to do |
| --- | --- | --- |
| `business` | `AjaxAdapter.fail(...)` on the server | Show `error.message`, it's authored and safe. |
| `server` | An unexpected server bug | Show a generic message. `error.reference` deep-links to the log. |
| `badRequest` | Params weren't serializable, payload wasn't a valid JSON object, a parameter contract was violated, or the payload was oversized | Fix the caller. `error.message` lists every violation. |
| `timeout` | No answer in time | Safe to retry manually, or opt into `retry` for reads. |
| `empty` | Empty answer | Check `client_callable`, ACLs, the method name, or the session. |
| `malformed` | Answer wasn't an AjaxAdapter envelope | You're calling a non-AjaxAdapter script include. |

## Server API

`AjaxAdapter.expose('_privateName', [...])` returns the public method. Each entry maps, in order, to one of the private method's arguments — a plain string for the mapping alone, or a contract object to have the boundary validate for you:

```js
getUserSummary: AjaxAdapter.expose('_getUserSummary', [
  { name: 'userId', type: 'string', required: true },
  { name: 'options', type: 'object', default: {} },
]),
```

- `type`: one of `string`, `number`, `boolean`, `object`, `array`, `date` (`date` matches a marshalled JS `Date`, which arrives as a `GlideDateTime`).
- `required`: rejects when the key is absent.
- `default`: used when the key is absent (so the private method never sees `undefined`).

Violations reject with kind `badRequest` — all listed in one message — and the private method never runs, so it can skip its guard clauses. Nothing is logged (a caller bug is not a server bug). A malformed contract itself (e.g. an unknown `type`) throws when the script include loads, not on the first call.

**Dates.** A client `Date` parameter arrives as a real `GlideDateTime`; returning a `GlideDateTime` (or a server `Date`) resolves client-side as a `Date`. On the wire it travels as `{ "$dateTime": "<ISO 8601 UTC>" }` — visible in the network tab, unambiguous, always the instant. Disable per call with `{ dates: false }` on the client.

**Guardrails.** Returning a `GlideElement` or any other Java object now fails loudly (logged server error naming the offending key) instead of silently serializing as `{}`. Payloads over `AjaxAdapter.MAX_PAYLOAD_LENGTH` (default 1,000,000 chars, reassignable) reject as `badRequest`. And when the installed `AjaxProxy`'s major.minor differs from `AjaxAdapter`'s, every call logs a version-skew warning — the two files share one wire format, so always update them together.

Two ways for a private method to fail:

```js
// Expected failure the caller must handle: kind 'business'. Message shown, NOT logged.
throw AjaxAdapter.fail('This user has no manager assigned');

// Contract violation / bug: kind 'server'. Logged with a correlation id, anonymized to the client.
throw new Error('userId is required');
```

Returning normally sends the value as the result. **Return plain JS values** — coerce fields with `String(gr.getValue('name'))`, `Number(ga.getAggregate('COUNT'))` (`gr.getValue('name') + ''` coerces the same way if you want the shorthand; the examples in this repo spell out `String(...)` for clarity). Two exceptions the adapter handles for you: a `GlideDateTime` (or server `Date`) is marshalled to a client `Date` automatically, and any *other* Java object (a `GlideElement`, a `GlideRecord`) is rejected with a loud, logged server error instead of silently serializing as `{}`.

Because the private methods never touch `this.request`, the whole class is reusable server-side. `new UserLookupAjax()._getUserSummary(id)` works in a Business Rule or scheduled job too.

## Repo layout

```
src/       AjaxAdapter (server) + AjaxProxy (client), the two files you install
dist/      importable ServiceNow update set — full install (core + Service Portal auto-load + guardrails)
examples/  UserLookupAjax endpoint, usage/ (one endpoint called from widget/catalog/classic/UI-action), service-portal-autoload feature source
docs/      ajax-adapter.mdx, the full, styled documentation
tests/     Vitest suite for both files (npm install && npm test), no instance needed
```

## Version

Both files carry the same [semver](https://semver.org/), bumped together on every change. See [`CHANGELOG.md`](CHANGELOG.md). To check what's installed on an instance:

```js
gs.info(AjaxAdapter.VERSION); // server, in Background Scripts
```

```js
console.log(AjaxProxy.VERSION); // client, in the browser console
```

## License

[MIT](LICENSE).
