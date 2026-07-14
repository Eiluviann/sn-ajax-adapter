// AjaxProxy Portal Autoload. Record settings + description: examples/service-portal-autoload/README.md
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
