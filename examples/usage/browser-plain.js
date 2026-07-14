/**
 * Plain browser / UI Page — no g_form, just AjaxProxy. Also shows AjaxProxy.for(), which binds
 * a script include (and any shared options) once so each call reads as `inventory('method', {...})`.
 *
 * Drop this in a UI Page client script, a portal page script tag, or the browser console.
 *
 * Pairs with InventoryAjax.getItemStock.
 */

// Bind the script include + shared defaults once.
var inventory = AjaxProxy.for('InventoryAjax', { timeout: 15000 });

// ...then every call is just method + params:
inventory('getItemStock', { itemId: someId })
	.then(function (result) {
		render(result.found ? result : { name: 'Unknown', inStock: 0 });
	})
	.catch(function (error) {
		showError(error.message);
	});
