/**
 * Service Portal widget — type-ahead search using AjaxProxy.channel.
 *
 * AjaxProxy.channel debounces and drops stale responses: only the latest keystroke's result
 * lands, so fast typing never renders out-of-order results (like RxJS switchMap). Bind
 * c.onQueryChange to ng-change on the input and render c.results.
 *
 * The result assignment re-renders directly — AjaxProxy 1.2.0 schedules the digest for you.
 *
 * Pairs with InventoryAjax.searchItems.
 */
api.controller = function ($scope) {
	var c = this;
	c.query = '';
	c.results = [];

	// One channel bound to the method: 250ms debounce, latest-only.
	var search = AjaxProxy.channel('InventoryAjax', 'searchItems', { debounce: 250 });

	c.onQueryChange = function () {
		if (!c.query) {
			c.results = [];
			return;
		}
		search({ query: c.query }).then(function (items) {
			c.results = items;
		});
	};
};
