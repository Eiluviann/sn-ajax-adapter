import { describe, expect, it } from 'vitest';
import { evaluateGlobalScript } from './load-source.js';

/**
 * Proves the selling point behind examples/usage/inventory-ajax.script-include.js: the private
 * methods take typed args and return typed values, so they're unit-testable directly — no
 * GlideAjax transport to mock, just a stand-in GlideRecord over an in-memory table.
 */

type StockResult = { found: true; name: string; inStock: number } | { found: false };
type ReserveResult = { reserved: number; remaining: number };
type InventoryInstance = {
	_getItemStock: (itemId: string) => StockResult;
	_reserveItem: (itemId: string, quantity: number) => ReserveResult;
};
type InventoryAjaxCtor = new () => InventoryInstance;

type Row = Record<string, string>;
type Store = Record<string, Row[]>;

/** Minimal in-memory GlideRecord: only the members the two methods under test touch. */
function makeGlideRecord(store: Store) {
	return class FakeGlideRecord {
		#table: string;
		#current: Row | undefined;

		constructor(table: string) {
			this.#table = table;
		}

		get(sysId: string): boolean {
			this.#current = (store[this.#table] ?? []).find((row) => row.sys_id === sysId);
			return this.#current !== undefined;
		}

		getValue(field: string): string {
			return this.#current?.[field] ?? '';
		}

		setValue(field: string, value: unknown): void {
			if (this.#current) {
				this.#current[field] = String(value);
			}
		}

		update(): string {
			return this.#current?.sys_id ?? '';
		}
	};
}

function loadAdapter(): unknown {
	const classStub = { create: () => function AjaxAdapterStub() { /* property holder */ } };
	const gsStub = { generateGUID: () => 'guid', error: () => {}, warn: () => {} };
	return evaluateGlobalScript(
		'src/ajax-adapter.script-include.js',
		{ Class: classStub, gs: gsStub },
		'AjaxAdapter',
	);
}

function loadInventoryAjax(store: Store): InventoryAjaxCtor {
	const classStub = { create: () => function InventoryAjaxStub() { /* prototype reassigned by source */ } };
	class AbstractAjaxProcessor {}
	const extendsObject = (parent: { prototype: object }, proto: object): object =>
		Object.assign(Object.create(parent.prototype), proto);
	// Trust boundary: the evaluated ES5 example carries no types; the one cast to the test surface.
	return evaluateGlobalScript(
		'examples/usage/inventory-ajax.script-include.js',
		{
			Class: classStub,
			Object: { extendsObject },
			global: { AbstractAjaxProcessor },
			AjaxAdapter: loadAdapter(),
			GlideRecord: makeGlideRecord(store),
		},
		'InventoryAjax',
	) as InventoryAjaxCtor;
}

function isBusinessFailure(error: unknown): boolean {
	return error instanceof Error && 'isAjaxBusinessFailure' in error && error.isAjaxBusinessFailure === true;
}

function seed(): Store {
	return { u_inventory_item: [{ sys_id: 'i1', name: 'Widget', in_stock: '5' }] };
}

describe('InventoryAjax example — private methods, no transport', () => {
	it('_getItemStock returns the found item', () => {
		const inventory = new (loadInventoryAjax(seed()))();
		expect(inventory._getItemStock('i1')).toEqual({ found: true, name: 'Widget', inStock: 5 });
	});

	it('_getItemStock models absence as a value, not an error', () => {
		const inventory = new (loadInventoryAjax(seed()))();
		expect(inventory._getItemStock('missing')).toEqual({ found: false });
	});

	it('_reserveItem decrements stock and returns the remainder', () => {
		const store = seed();
		const inventory = new (loadInventoryAjax(store))();
		expect(inventory._reserveItem('i1', 2)).toEqual({ reserved: 2, remaining: 3 });
		expect(store.u_inventory_item?.[0]?.in_stock).toBe('3');
	});

	it('_reserveItem raises a business failure when stock is short', () => {
		const inventory = new (loadInventoryAjax(seed()))();
		let thrown: unknown;
		try {
			inventory._reserveItem('i1', 999);
		} catch (error) {
			thrown = error;
		}
		expect(isBusinessFailure(thrown)).toBe(true);
		expect(thrown instanceof Error ? thrown.message : '').toBe('Only 5 in stock');
	});
});
