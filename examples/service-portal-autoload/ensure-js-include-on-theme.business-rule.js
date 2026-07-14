// AjaxProxy Portal Autoload. Record settings + description: examples/service-portal-autoload/README.md
(function executeRule(current, previous) {
	new AjaxProxyPortalUtil().ensureThemeLink(current.getUniqueValue());
})(current, previous);
