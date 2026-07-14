/**
 * Classic UI form Client Script — onChange, in the platform (backend) UI.
 * AjaxProxy loads here via the UI Script's Global + UI Type Desktop.
 *
 * Client Script settings:
 *   Table:   <your table>
 *   UI Type: Desktop
 *   Type:    onChange, on the driving field
 *
 * This one shows CALLBACK style instead of a promise — same call(), just pass handlers.
 * Reach for it when a promise chain doesn't read better (e.g. you also want onComplete).
 *
 * Pairs with InventoryAjax.getItemStock.
 */
function onChange(control, oldValue, newValue, isLoading) {
	if (isLoading || newValue === '') {
		return;
	}
	AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: newValue }, {
		onSuccess: function (result) {
			g_form.setValue('stock_level', result.found ? result.inStock : 0);
		},
		onError: function (error) {
			g_form.addErrorMessage(error.message);
		},
	});
}
