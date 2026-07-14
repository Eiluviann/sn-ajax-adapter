/**
 * One-time AjaxProxy configuration — put this where it runs once, early (a global UI Script, or
 * the top of your app's bootstrap / a base widget). None of it is required; each feature is opt-in.
 */

// Route every unhandled callback-style failure through one sink (toast, banner, telemetry).
AjaxProxy.setErrorHandler(function (error) {
	showToast(error.kind === AjaxProxy.ErrorKind.BUSINESS ? error.message : 'Something went wrong.');
});

// Raise the default per-call timeout (default 60s).
AjaxProxy.setDefaultTimeout(20000);

// Scoped app? Point correlation references at the scoped log so console links resolve.
AjaxProxy.setLogTable('syslog_app_scope');

// Retry is off by default and only safe for idempotent reads — opt in per call:
AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: someId }, { retry: true })
	.then(render);
