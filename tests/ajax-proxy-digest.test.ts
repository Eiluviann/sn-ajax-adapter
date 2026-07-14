import { describe, expect, it, vi } from 'vitest';
import { evaluateGlobalScript } from './load-source.js';

/**
 * Covers the Service Portal digest integration: with AngularJS present, a settled call schedules
 * a digest ($rootScope.$applyAsync) so a .then handler's state change renders; disabling it stops
 * that. (The other proxy tests inject no `angular`, so they exercise the no-op path.)
 */

type AnswerCallback = (answer: string) => void;

class FakeGlideAjax {
	static last: FakeGlideAjax | undefined;
	#callback: AnswerCallback | undefined;

	constructor() {
		FakeGlideAjax.last = this;
	}

	addParam(): void { /* no-op */ }

	getXMLAnswer(callback: AnswerCallback): void {
		this.#callback = callback;
	}

	resolve(answer: string): void {
		if (this.#callback) {
			this.#callback(answer);
		}
	}
}

type ProxyApi = {
	call: (scriptInclude: string, method: string, params?: object) => Promise<unknown>;
	setDigestIntegration: (enabled: boolean) => void;
};

function loadProxyWithAngular(applyAsync: () => void): ProxyApi {
	const rootScope = { $applyAsync: applyAsync };
	const injector = { has: () => true, get: () => rootScope };
	const angular = { element: () => ({ injector: () => injector }) };
	const documentStub = { body: {}, documentElement: {}, querySelector: () => null };
	// Trust boundary: the evaluated ES5 source carries no types; single cast to the test surface.
	return evaluateGlobalScript(
		'src/ajax-proxy.ui-script.js',
		{ GlideAjax: FakeGlideAjax, angular, document: documentStub },
		'AjaxProxy',
	) as ProxyApi;
}

describe('AjaxProxy — Service Portal digest integration', () => {
	it('schedules a digest after a call settles', async () => {
		const applyAsync = vi.fn();
		const proxy = loadProxyWithAngular(applyAsync);
		const settled = proxy.call('X', 'y', {});
		FakeGlideAjax.last?.resolve(JSON.stringify({ ok: true, result: 42 }));
		await settled;
		expect(applyAsync).toHaveBeenCalled();
	});

	it('does not schedule a digest when turned off', async () => {
		const applyAsync = vi.fn();
		const proxy = loadProxyWithAngular(applyAsync);
		proxy.setDigestIntegration(false);
		const settled = proxy.call('X', 'y', {});
		FakeGlideAjax.last?.resolve(JSON.stringify({ ok: true, result: 42 }));
		await settled;
		expect(applyAsync).not.toHaveBeenCalled();
	});
});
