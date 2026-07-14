/**
 * Server-side reuse — the InventoryAjax class works OFF the AJAX path too. Because the private
 * methods never touch this.request, a Business Rule, scheduled job, or another Script Include can
 * call them directly: same logic, no GlideAjax, no transport to fake.
 *
 * Business Rule settings: e.g. before insert/update on your order table.
 *
 * Pairs with InventoryAjax._getItemStock (called directly, not via AjaxProxy).
 */
(function executeRule(current, previous) {
	var stock = new InventoryAjax()._getItemStock(current.getValue('item'));
	if (stock.found && stock.inStock === 0) {
		current.setValue('status', 'backordered');
	}
})(current, previous);
