/**
 * Catalog client script — onChange. Runs in BOTH Service Portal and the classic catalog,
 * so it's the same code either way; just make sure AjaxProxy is loaded on each (Service
 * Portal: the auto-load update set; classic: Global + UI Type Desktop).
 *
 * Catalog Client Script settings:
 *   Applies to:  A Catalog Item / Variable Set
 *   UI Type:     All (catalog scripts, unlike UI Scripts, run fine on "All")
 *   Type:        onChange, on the driving variable
 *
 * Pairs with InventoryAjax.getItemStock.
 */
function onChange(control, oldValue, newValue, isLoading) {
	if (isLoading || newValue === '') {
		return;
	}
	AjaxProxy.call('InventoryAjax', 'getItemStock', { itemId: newValue })
		.then(function (result) {
			if (result.found) {
				g_form.setValue('in_stock', result.inStock);
			} else {
				g_form.clearValue('in_stock');
				g_form.showFieldMsg('in_stock', 'Item not found', 'error');
			}
		})
		.catch(function (error) {
			g_form.addErrorMessage(error.message);
		});
}
