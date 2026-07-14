// AjaxProxy Portal Autoload. Record settings + description: examples/service-portal-autoload/README.md
(function executeRule(current, previous) {
	var includeId = new AjaxProxyPortalUtil().getIncludeId();
	if (includeId && current.getValue('sp_js_include') === includeId) {
		gs.addErrorMessage('AjaxProxy is a required Service Portal dependency and cannot be removed from a theme.');
		current.setAbortAction(true);
	}
})(current, previous);
