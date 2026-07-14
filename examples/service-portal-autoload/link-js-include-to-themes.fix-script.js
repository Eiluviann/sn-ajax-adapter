// AjaxProxy Portal Autoload. Record settings + description: examples/service-portal-autoload/README.md
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
