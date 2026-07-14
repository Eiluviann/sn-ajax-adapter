/**
 * Date round-trip — any client context (shown here as a plain browser snippet).
 * Pass a JS Date; it arrives server-side as a GlideDateTime, and the GlideDateTime values in the
 * answer come back as JS Dates. On the wire it travels as { "$dateTime": "<ISO 8601 UTC>" } —
 * visible in the network tab, unambiguous, always the instant. Disable per call with { dates: false }.
 *
 * Pairs with InventoryAjax.getItemsAddedSince.
 */
var lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

AjaxProxy.call('InventoryAjax', 'getItemsAddedSince', { since: lastWeek })
	.then(function (data) {
		// data.asOf is a Date; each item.addedOn is a Date.
		console.log(data.count + ' items added since ' + lastWeek.toISOString());
		data.items.forEach(function (item) {
			console.log(item.name + ' - added ' + item.addedOn.toLocaleString());
		});
	})
	.catch(function (error) {
		console.error(error.message);
	});
