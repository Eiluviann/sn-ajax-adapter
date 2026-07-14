/**
 * Service Portal widget — Client controller.
 * Paste into a widget's "Client controller" field. Requires AjaxProxy on the portal
 * (the update set's auto-load handles that).
 *
 * GOTCHA worth internalizing: AjaxProxy hands back a NATIVE promise, and AngularJS does not
 * run a digest when a native promise resolves — so a bare `c.stock = ...` in .then() updates
 * the property but the template won't re-render. Re-enter Angular with $timeout (or
 * $scope.$apply) around the state change. This is the one thing that trips people up in widgets.
 *
 * Pairs with InventoryAjax.getItemStock.
 */
api.controller = function ($scope, $timeout) {
	var c = this;
	c.stock = undefined;
	c.error = undefined;

	c.checkStock = function (itemId) {
		AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: itemId })
			.then(function (result) {
				$timeout(function () {
					c.error = undefined;
					c.stock = result.found ? result : undefined;
				});
			})
			.catch(function (error) {
				$timeout(function () {
					c.error = error.message;
				});
			});
	};
};
