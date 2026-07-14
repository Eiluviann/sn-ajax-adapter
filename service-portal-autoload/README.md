# AjaxProxy Portal Autoload

Makes the `AjaxProxy` UI Script load on **every Service Portal theme** so catalog and
client scripts can call `AjaxProxy` on the form — and keeps it there. A Fix Script links
it to all themes, and Business Rules self-heal and protect the link.

> **The packaged, ready-to-install version of this feature is the update set at
> [`dist/ajax-adapter-v1.1.0.update-set.xml`](../dist/ajax-adapter-v1.1.0.update-set.xml)** —
> import that instead of building by hand (see the repo [README](../README.md) → Install).
> The shipped set names its records with the **`AjaxAdapter`** prefix (e.g. `AjaxAdapterPortalUtil`,
> `AjaxAdapter - …`) and adds pieces this annotated reference does not: the `AjaxAdapterUsage`
> counter + m2m form banner, UI-Script config enforcement, deletion guards, and the
> `ajaxadapter.portal.lock` uninstall property. This folder stays as the commented walk-through
> of the core linking mechanism.

> Prerequisite (manual build): the **`AjaxProxy`** UI Script (Global: on, UI Type: Desktop) and the
> **`AjaxAdapter`** Script Include are already installed.

## Create order

Do it inside one update set so it packages cleanly.

1. **Update Set** — create and make it current.
2. **Script Include** — `AjaxProxyPortalUtil` (the other pieces call it).
3. **Business Rules** — the ensure + two protect rules.
4. **Fix Script** — run with `DRY_RUN = true`, review, then `false` to populate.

The Fix Script creates the `AjaxProxy` `sp_js_include` record on first apply, so you don't
create it by hand. Everything keys on the UI Script **named `AjaxProxy`** — no hardcoded
sys_ids — so it's portable across instances.

## Distribution & scope

Ship the **Fix Script + Script Include + Business Rules + the `AjaxProxy` UI Script** in the
update set. On a target instance, committing the set runs the Fix Script, which links AjaxProxy
to whatever themes exist *there* — so you never capture instance-specific `m2m_sp_theme_js_include`
rows, and the multi-scope problem disappears.

If instead you must capture the m2m rows on this instance: ServiceNow files each record change
into the current update set **of that record's scope**, so run the Fix Script once per scope with
`ONLY_SCOPE` set and that scope's update set selected first. Verify the m2m table is update-set
tracked (do one real link, then look for an `m2m_sp_theme_js_include` entry in the update set XML)
before relying on it — if it isn't, shipping the Fix Script is the only option that travels.

---

## 1. Update Set

| Field | Value |
| --- | --- |
| Name | `AjaxProxy Portal Autoload 1.1.0` |

> Packages the AjaxProxy Service Portal auto-load feature: the AjaxProxyPortalUtil Script Include, the AjaxProxy JS Include, the populate Fix Script, and the ensure / protect Business Rules. On commit the Fix Script links AjaxProxy to every theme on the target instance and the Business Rules keep it attached. Pairs with AjaxAdapter / AjaxProxy 1.1.0.

## 2. Script Include — `AjaxProxyPortalUtil`

| Field | Value |
| --- | --- |
| Name | `AjaxProxyPortalUtil` (must equal the class name) |
| Client callable | off |
| Accessible from | All application scopes |
| Active | true |

> Shared helper for the AjaxProxy Service Portal auto-load feature. Resolves the AjaxProxy JS Include by the UI Script named "AjaxProxy" (portable — no hardcoded sys_ids), creates it if missing, and links/checks it against portal themes via m2m_sp_theme_js_include. Called by the AjaxProxy Fix Script and Business Rules. Not client callable.

Source: [`ajax-proxy-portal-util.script-include.js`](ajax-proxy-portal-util.script-include.js)

```js
var AjaxProxyPortalUtil = Class.create();
AjaxProxyPortalUtil.prototype = {
	initialize: function () {},

	UI_SCRIPT_NAME: 'AjaxProxy',
	INCLUDE_DISPLAY_NAME: 'AjaxProxy',
	INCLUDE_TABLE: 'sp_js_include',
	LINK_TABLE: 'm2m_sp_theme_js_include',

	getIncludeId: function () {
		var uiScriptId = this._getUiScriptId();
		if (!uiScriptId) return '';
		var inc = new GlideRecord(this.INCLUDE_TABLE);
		inc.addQuery('sys_ui_script', uiScriptId);
		inc.setLimit(1);
		inc.query();
		return inc.next() ? inc.getUniqueValue() : '';
	},

	ensureInclude: function () {
		var existing = this.getIncludeId();
		if (existing) return existing;
		var uiScriptId = this._getUiScriptId();
		if (!uiScriptId) return '';
		var inc = new GlideRecord(this.INCLUDE_TABLE);
		inc.initialize();
		inc.setValue('display_name', this.INCLUDE_DISPLAY_NAME);
		inc.setValue('sys_ui_script', uiScriptId);
		return inc.insert();
	},

	hasThemeLink: function (themeId, includeId) {
		var incId = includeId || this.getIncludeId();
		if (!incId || !themeId) return false;
		var m = new GlideRecord(this.LINK_TABLE);
		m.addQuery('sp_theme', themeId);
		m.addQuery('sp_js_include', incId);
		m.setLimit(1);
		m.query();
		return m.hasNext();
	},

	ensureThemeLink: function (themeId) {
		var includeId = this.getIncludeId();
		if (!includeId || !themeId || this.hasThemeLink(themeId, includeId)) return false;
		var link = new GlideRecord(this.LINK_TABLE);
		link.initialize();
		link.setValue('sp_theme', themeId);
		link.setValue('sp_js_include', includeId);
		link.insert();
		return true;
	},

	_getUiScriptId: function () {
		var s = new GlideRecord('sys_ui_script');
		return s.get('name', this.UI_SCRIPT_NAME) ? s.getUniqueValue() : '';
	},

	type: 'AjaxProxyPortalUtil',
};
```

## 3. Business Rule — `AjaxProxy - ensure JS Include on theme`

| Field | Value |
| --- | --- |
| Name | `AjaxProxy - ensure JS Include on theme` |
| Table | `sp_theme` |
| Advanced | true |
| When | after · Insert + Update |

> Self-heals the AjaxProxy Portal Autoload feature. After any Service Portal theme is created or updated, re-adds the m2m_sp_theme_js_include link to the AjaxProxy JS Include if it is missing. Idempotent; no recursion (writes the link row, not the theme).

Source: [`ensure-js-include-on-theme.business-rule.js`](ensure-js-include-on-theme.business-rule.js)

```js
(function executeRule(current, previous) {
	new AjaxProxyPortalUtil().ensureThemeLink(current.getUniqueValue());
})(current, previous);
```

## 4. Business Rule — `AjaxProxy - protect JS Include on theme`

| Field | Value |
| --- | --- |
| Name | `AjaxProxy - protect JS Include on theme` |
| Table | `m2m_sp_theme_js_include` |
| Advanced | true |
| When | before · Delete |

> Protects the AjaxProxy Portal Autoload feature. Aborts deletion of an m2m_sp_theme_js_include row when it links the AjaxProxy JS Include, so AjaxProxy cannot be unlinked from a theme. Hard block for all users.

Source: [`protect-js-include-on-theme.business-rule.js`](protect-js-include-on-theme.business-rule.js)

```js
(function executeRule(current, previous) {
	var includeId = new AjaxProxyPortalUtil().getIncludeId();
	if (includeId && current.getValue('sp_js_include') === includeId) {
		gs.addErrorMessage('AjaxProxy is a required Service Portal dependency and cannot be removed from a theme.');
		current.setAbortAction(true);
	}
})(current, previous);
```

## 5. Business Rule — `AjaxProxy - protect JS Include record`

| Field | Value |
| --- | --- |
| Name | `AjaxProxy - protect JS Include record` |
| Table | `sp_js_include` |
| Advanced | true |
| When | before · Delete |

> Companion guard for the AjaxProxy Portal Autoload feature. Aborts deletion of the AjaxProxy sp_js_include record, preventing its removal from every theme at once. Hard block for all users.

Source: [`protect-js-include-record.business-rule.js`](protect-js-include-record.business-rule.js)

```js
(function executeRule(current, previous) {
	if (current.getUniqueValue() === new AjaxProxyPortalUtil().getIncludeId()) {
		gs.addErrorMessage('AjaxProxy is a required Service Portal dependency and cannot be deleted.');
		current.setAbortAction(true);
	}
})(current, previous);
```

## 6. Fix Script — `AjaxProxy - link JS Include to themes`

| Field | Value |
| --- | --- |
| Name | `AjaxProxy - link JS Include to themes` |

> One-time populate for the AjaxProxy Portal Autoload feature: creates the AjaxProxy JS Include if absent and links it to every sp_theme. Idempotent and safe to re-run. Defaults to DRY_RUN=true (reports per-scope counts, changes nothing); set DRY_RUN=false to apply. Set ONLY_SCOPE to limit a run to one application scope.

Source: [`link-js-include-to-themes.fix-script.js`](link-js-include-to-themes.fix-script.js)

```js
(function () {
	var DRY_RUN = true;
	var ONLY_SCOPE = ''; // sys_id of a sys_scope to limit this run to one scope; '' = all scopes

	var util = new AjaxProxyPortalUtil();
	var includeId = DRY_RUN ? util.getIncludeId() : util.ensureInclude();
	if (!includeId && !DRY_RUN) {
		gs.print('ABORT: UI Script "AjaxProxy" not found. Install the AjaxProxy UI Script first.');
		return;
	}
	gs.print('AjaxProxy JS Include: ' + (includeId || '(none yet - will be created when DRY_RUN=false)'));

	var byScope = {};
	var order = [];
	var created = 0;
	var th = new GlideRecord('sp_theme');
	if (ONLY_SCOPE) th.addQuery('sys_scope', ONLY_SCOPE);
	th.orderBy('sys_scope');
	th.query();
	while (th.next()) {
		var label = th.getDisplayValue('sys_scope') || 'Global';
		if (!byScope[label]) { byScope[label] = { total: 0, present: 0, missing: 0 }; order.push(label); }
		byScope[label].total++;

		if (includeId && util.hasThemeLink(th.getUniqueValue(), includeId)) {
			byScope[label].present++;
			continue;
		}
		byScope[label].missing++;
		if (!DRY_RUN) {
			util.ensureThemeLink(th.getUniqueValue());
			created++;
		}
	}

	gs.print('--------------------------------------------------');
	for (var i = 0; i < order.length; i++) {
		var s = byScope[order[i]];
		gs.print('  ' + order[i] + ': ' + s.total + ' theme(s) | linked ' + s.present + ' | missing ' + s.missing);
	}
	gs.print('--------------------------------------------------');
	gs.print(DRY_RUN ? 'DRY RUN - no changes. Set DRY_RUN=false to create the include + links.' : ('Created ' + created + ' link(s).'));
})();
```

---

## Notes

- **Names cap at 40 chars** on Business Rules and Fix Scripts (`sys_script` / `sys_script_fix`). All names above fit.
- **`sp_js_include` may not show a Description field** on the form — if so, skip it there; the `AjaxProxy` name + UI Script reference are self-explanatory.
- **Delete guards are a hard block for everyone.** To allow an admin override, gate the abort on a role, e.g. `if (!gs.hasRole('admin')) { ... setAbortAction(true); }`.
- **Non-portal themes:** the Fix Script links *every* `sp_theme`, which on a full instance includes Next Experience / Workspace / Mobile themes that don't need AjaxProxy. Use `ONLY_SCOPE`, or add a filter, to limit it to real Service Portal themes.
