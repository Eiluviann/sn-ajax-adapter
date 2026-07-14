// AjaxProxy Portal Autoload. Record settings + description: examples/service-portal-autoload/README.md
(function executeRule(current, previous) {
	if (current.getUniqueValue() === new AjaxProxyPortalUtil().getIncludeId()) {
		gs.addErrorMessage('AjaxProxy is a required Service Portal dependency and cannot be deleted.');
		current.setAbortAction(true);
	}
})(current, previous);
