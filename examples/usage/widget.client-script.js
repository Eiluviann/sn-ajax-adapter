/**
 * Service Portal widget — Client controller.
 * Paste into a widget's "Client controller" field. Requires AjaxProxy on the portal
 * (the update set's auto-load handles that).
 *
 * As of AjaxProxy 1.2.0 there's no digest dance: a settled call schedules an Angular digest for
 * you, so setting controller/scope state in .then/.catch re-renders the view directly. (Pre-1.2.0,
 * or after AjaxProxy.setDigestIntegration(false), wrap the state change in $timeout / $scope.$apply.)
 *
 * Pairs with InventoryAjax.getItemStock.
 */
api.controller = function ($scope) {
	var c = this;
	c.stock = undefined;
	c.error = undefined;

	c.checkStock = function (itemId) {
		AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: itemId })
			.then(function (result) {
				c.error = undefined;
				c.stock = result.found ? result : undefined;
			})
			.catch(function (error) {
				c.error = error.message;
			});
	};
};
