/**
 * Client-side UI Action — a write with typed error handling.
 *
 * UI Action settings:
 *   Action name: reserve_item
 *   Client:      checked
 *   Onclick:     reserveItem()
 *   Form button: checked
 *
 * Demonstrates branching on error.kind: a 'business' failure carries a safe, authored message
 * (e.g. "Only 3 in stock") you can show as-is; anything else is an unexpected server bug —
 * show a generic message and let error.reference deep-link the developer to the log row.
 *
 * Pairs with InventoryAjax.reserveItem.
 */
function reserveItem() {
	var itemId = g_form.getUniqueValue();

	AjaxProxy.call('InventoryAjax', 'reserveItem', { itemId: itemId, quantity: 1 })
		.then(function (result) {
			g_form.addInfoMessage('Reserved 1. ' + result.remaining + ' remaining.');
		})
		.catch(function (error) {
			if (error.kind === AjaxProxy.ErrorKind.BUSINESS) {
				g_form.addErrorMessage(error.message);
			} else {
				g_form.addErrorMessage('Could not reserve the item. Please try again.');
				console.error('[reserveItem] ' + (AjaxProxy.logUrl(error) || error.message));
			}
		});
}
