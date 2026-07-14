/**
 * InventoryAjax: the shared server endpoint for every client example in this folder.
 *
 * The whole point: write the logic ONCE on the server, then call it identically from a
 * Service Portal widget, a catalog client script, a classic form, or a UI Action. The
 * private methods take typed args and return plain values, so they're unit-testable too.
 *
 * Script Include settings:
 *   Name:            InventoryAjax
 *   Client callable: true
 *   Accessible from: All application scopes (if you share it across scopes)
 *
 * The `u_inventory_item` table below is a stand-in — point these at whatever table you have.
 */
var InventoryAjax = Class.create();
InventoryAjax.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {

	/* Public: GlideAjax boundary, one line each. */
	getItemStock: AjaxAdapter.expose('_getItemStock', [
		{ name: 'itemId', type: 'string', required: true },
	]),
	searchItems: AjaxAdapter.expose('_searchItems', [
		{ name: 'query', type: 'string', required: true },
	]),
	reserveItem: AjaxAdapter.expose('_reserveItem', [
		{ name: 'itemId', type: 'string', required: true },
		{ name: 'quantity', type: 'number', required: true },
	]),

	/* Private: typed in, typed out. */

	/**
	 * @param {string} itemId - sys_id of a u_inventory_item record.
	 * @returns {{ found: true, name: string, inStock: number } | { found: false }}
	 */
	_getItemStock: function (itemId) {
		var gr = new GlideRecord('u_inventory_item');
		if (!gr.get(itemId)) {
			return { found: false };
		}
		return {
			found: true,
			name: String(gr.getValue('name') || ''),
			inStock: Number(gr.getValue('in_stock')) || 0,
		};
	},

	/**
	 * Type-ahead search. Kept small and fast; the client throttles with AjaxProxy.channel.
	 *
	 * @param {string} query
	 * @returns {Array<{ id: string, name: string }>}
	 */
	_searchItems: function (query) {
		var results = [];
		var gr = new GlideRecord('u_inventory_item');
		gr.addQuery('name', 'CONTAINS', query);
		gr.orderBy('name');
		gr.setLimit(10);
		gr.query();
		while (gr.next()) {
			results.push({ id: gr.getUniqueValue(), name: String(gr.getValue('name')) });
		}
		return results;
	},

	/**
	 * Reserves stock. A write, and a demonstration of an expected business failure the caller
	 * must handle: not enough stock rejects with kind 'business' and a safe, unlogged message.
	 *
	 * @param {string} itemId
	 * @param {number} quantity - already a number (the contract guarantees it).
	 * @returns {{ reserved: number, remaining: number }}
	 * @throws {Error} Via AjaxAdapter.fail (kind 'business') on bad quantity / missing item / short stock.
	 */
	_reserveItem: function (itemId, quantity) {
		if (quantity <= 0) {
			throw AjaxAdapter.fail('Quantity must be greater than zero');
		}
		var gr = new GlideRecord('u_inventory_item');
		if (!gr.get(itemId)) {
			throw AjaxAdapter.fail('That item no longer exists');
		}
		var inStock = Number(gr.getValue('in_stock')) || 0;
		if (quantity > inStock) {
			throw AjaxAdapter.fail('Only ' + inStock + ' in stock', { details: { available: inStock } });
		}
		var remaining = inStock - quantity;
		gr.setValue('in_stock', remaining);
		gr.update();
		return { reserved: quantity, remaining: remaining };
	},

	type: 'InventoryAjax',
});
