import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateGlobalScript } from './load-source.js';

type AjaxProxyError = Error & {
	kind: string;
	scriptInclude?: string;
	method?: string;
	reference?: string;
	details?: unknown;
};
type CallOptions = {
	onSuccess?: (result: unknown) => void;
	onError?: (error: AjaxProxyError) => void;
	onComplete?: () => void;
	timeout?: number;
	retry?: boolean | number | { attempts?: number; delay?: number; on?: string[] };
	dates?: boolean;
};
type ChannelOptions = { debounce?: number; latest?: boolean; timeout?: number; retry?: CallOptions['retry'] };
type AjaxProxyApi = {
	VERSION: string;
	call: (scriptIncludeName: string, publicMethodName: string, parameters?: Record<string, unknown>, options?: CallOptions) => Promise<unknown>;
	for: (scriptIncludeName: string, defaults?: CallOptions) => (publicMethodName: string, parameters?: Record<string, unknown>, options?: CallOptions) => Promise<unknown>;
	channel: (scriptIncludeName: string, publicMethodName: string, channelOptions?: ChannelOptions) => (parameters?: Record<string, unknown>) => Promise<unknown>;
	setErrorHandler: (handler: (error: unknown) => void) => void;
	setDefaultTimeout: (milliseconds: number) => void;
	setLogTable: (tableName: string) => void;
	logUrl: (referenceOrError?: unknown) => string | undefined;
	ErrorKind: {
		SERVER: string;
		BUSINESS: string;
		BAD_REQUEST: string;
		TIMEOUT: string;
		EMPTY: string;
		MALFORMED: string;
	};
};
type AnswerCallback = (answer: string | null) => void;

/** Scriptable stand-in for the platform GlideAjax transport. */
class FakeGlideAjax {
	static instances: FakeGlideAjax[] = [];

	readonly scriptInclude: string;
	readonly params = new Map<string, string>();
	#answerCallback: AnswerCallback | undefined;

	constructor(scriptInclude: string) {
		this.scriptInclude = scriptInclude;
		FakeGlideAjax.instances.push(this);
	}

	addParam(name: string, value: string): void {
		this.params.set(name, value);
	}

	getXMLAnswer(callback: AnswerCallback): void {
		this.#answerCallback = callback;
	}

	/** Delivers the server answer to the pending callback, like the platform would. */
	answer(value: string | null): void {
		if (this.#answerCallback === undefined) {
			throw new Error('getXMLAnswer was never called on this request');
		}
		this.#answerCallback(value);
	}
}

const OK_ENVELOPE = JSON.stringify({ ok: true, result: 'the result' });

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('AjaxProxy.call — transport and envelope', () => {
	it('sends the method name and one JSON payload param, and resolves with the unwrapped result', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('UserLookupAjax', 'getUserSummary', { userId: 'u1', count: 2, flag: null });

		const request = lastRequest();
		expect(request.scriptInclude).toBe('UserLookupAjax');
		expect(request.params.get('sysparm_name')).toBe('getUserSummary');
		expect(JSON.parse(request.params.get('sysparm_payload') ?? '')).toEqual({ userId: 'u1', count: 2, flag: null });

		request.answer(JSON.stringify({ ok: true, result: { name: 'Ada' } }));
		await expect(pending).resolves.toEqual({ name: 'Ada' });
	});

	it('sends an empty JSON object when parameters are omitted', () => {
		const proxy = loadAjaxProxy();
		void proxy.call('X', 'read').catch(() => undefined);

		expect(lastRequest().params.get('sysparm_payload')).toBe('{}');
	});

	it('sends its version with every call for the server-side skew warning', () => {
		const proxy = loadAjaxProxy();
		void proxy.call('X', 'read').catch(() => undefined);

		expect(lastRequest().params.get('sysparm_adapter_version')).toBe(proxy.VERSION);
	});

	it('resolves with undefined when the envelope omits result', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read');

		lastRequest().answer('{"ok":true}');
		await expect(pending).resolves.toBeUndefined();
	});

	it('rejects an empty answer with kind empty and the call coordinates attached', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer('');
		const error = await rejection;
		expect(error.kind).toBe(proxy.ErrorKind.EMPTY);
		expect(error.message).toContain('client_callable');
		expect(error.scriptInclude).toBe('X');
		expect(error.method).toBe('read');
	});

	it('rejects a null answer with kind empty', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer(null);
		expect((await rejection).kind).toBe(proxy.ErrorKind.EMPTY);
	});

	it('rejects a non-JSON answer with kind malformed', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer('<xml>not the envelope</xml>');
		expect((await rejection).kind).toBe(proxy.ErrorKind.MALFORMED);
	});

	it('rejects parseable-but-foreign JSON (no boolean ok) with kind malformed, not a fabricated server error', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer('{"foo": 1}');
		const error = await rejection;
		expect(error.kind).toBe(proxy.ErrorKind.MALFORMED);
		expect(error.message).toContain('unrecognized answer shape');
	});

	it('rejects an ok:false envelope with the server error fields, keeping the CALLED method name', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer(JSON.stringify({
			ok: false,
			error: { kind: 'business', message: 'No manager assigned', reference: 'ref-1', details: { userId: 'u1' }, method: 'spoofed' },
		}));
		const error = await rejection;
		expect(error.kind).toBe(proxy.ErrorKind.BUSINESS);
		expect(error.message).toBe('No manager assigned');
		expect(error.reference).toBe('ref-1');
		expect(error.details).toEqual({ userId: 'u1' });
		// The adapter never emits a method name; whatever the envelope claims is ignored.
		expect(error.method).toBe('read');
	});

	it('defaults a bare ok:false envelope to kind server with a generic message', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer('{"ok":false}');
		const error = await rejection;
		expect(error.kind).toBe(proxy.ErrorKind.SERVER);
		expect(error.message).toBe('unknown server error');
	});

	it('rejects non-serializable parameters with kind badRequest before any request is fired', async () => {
		const proxy = loadAjaxProxy();
		const circular: Record<string, unknown> = {};
		circular['self'] = circular;

		const error = await rejectionOf(proxy.call('X', 'write', circular));
		expect(error.kind).toBe(proxy.ErrorKind.BAD_REQUEST);
		expect(FakeGlideAjax.instances).toHaveLength(0);
	});
});

describe('AjaxProxy.call — date marshalling', () => {
	const ISO = '2026-08-01T09:00:00.000Z';

	it('sends a Date parameter as the wire tag, at any nesting depth', () => {
		const proxy = loadAjaxProxy();
		void proxy.call('X', 'reschedule', { due: new Date(ISO), nested: { list: [new Date(ISO)] } }).catch(() => undefined);

		expect(JSON.parse(lastRequest().params.get('sysparm_payload') ?? '')).toEqual({
			due: { $dateTime: ISO },
			nested: { list: [{ $dateTime: ISO }] },
		});
	});

	it('rejects an invalid Date parameter with badRequest before any request is fired', async () => {
		const proxy = loadAjaxProxy();

		const error = await rejectionOf(proxy.call('X', 'reschedule', { due: new Date('nonsense') }));
		expect(error.kind).toBe(proxy.ErrorKind.BAD_REQUEST);
		expect(error.message).toContain('invalid Date');
		expect(FakeGlideAjax.instances).toHaveLength(0);
	});

	it('revives a tagged date-time in the result as a real Date', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read');

		lastRequest().answer(JSON.stringify({ ok: true, result: { count: 3, asOf: { $dateTime: ISO } } }));
		// toEqual only matches when asOf is a real Date with this exact time; a plain
		// { $dateTime } object or an ISO string would fail it.
		expect(await pending).toEqual({ count: 3, asOf: new Date(ISO) });
	});

	it('revives a tagged date-time inside error details too', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		lastRequest().answer(JSON.stringify({
			ok: false,
			error: { kind: 'business', message: 'Too early', details: { opensAt: { $dateTime: ISO } } },
		}));
		const error = await rejection;
		expect(error.details).toEqual({ opensAt: new Date(ISO) });
	});

	it('leaves look-alike objects alone: extra keys or a non-string tag value', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read');

		lastRequest().answer(JSON.stringify({ ok: true, result: { a: { $dateTime: ISO, extra: 1 }, b: { $dateTime: 42 } } }));
		expect(await pending).toEqual({ a: { $dateTime: ISO, extra: 1 }, b: { $dateTime: 42 } });
	});

	it('dates: false disables both directions for that call', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', { due: new Date(ISO) }, { dates: false });

		// Sent as the plain toJSON ISO string, not the tag.
		expect(JSON.parse(lastRequest().params.get('sysparm_payload') ?? '')).toEqual({ due: ISO });

		// A tag in the answer stays a plain object.
		lastRequest().answer(JSON.stringify({ ok: true, result: { asOf: { $dateTime: ISO } } }));
		expect(await pending).toEqual({ asOf: { $dateTime: ISO } });
	});
});

describe('AjaxProxy.call — timeout', () => {
	it('rejects with kind timeout after the default 60s when no answer arrives', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read'));

		let isSettled = false;
		rejection.then(() => {
			isSettled = true;
		});
		await vi.advanceTimersByTimeAsync(59999);
		expect(isSettled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const error = await rejection;
		expect(error.kind).toBe(proxy.ErrorKind.TIMEOUT);
		expect(error.message).toContain('60000ms');
	});

	it('honors a per-call timeout override', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read', {}, { timeout: 100 }));

		await vi.advanceTimersByTimeAsync(100);
		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
	});

	it('ignores an answer that arrives after the timeout already rejected', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read', {}, { timeout: 100 }));
		const request = lastRequest();

		await vi.advanceTimersByTimeAsync(100);
		request.answer(OK_ENVELOPE); // must be a silent no-op
		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
	});

	it('does not fire the timeout after the answer already resolved', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', {}, { timeout: 100 });

		lastRequest().answer(OK_ENVELOPE);
		await expect(pending).resolves.toBe('the result');
		await vi.advanceTimersByTimeAsync(1000); // a stray timer would reject and trip Vitest's unhandled-rejection check
	});
});

describe('AjaxProxy.call — callback style', () => {
	it('runs onSuccess then onComplete, in order', async () => {
		const proxy = loadAjaxProxy();
		const events: string[] = [];
		proxy.call('X', 'read', {}, {
			onSuccess: (result) => events.push(`success:${String(result)}`),
			onComplete: () => events.push('complete'),
		});

		lastRequest().answer(OK_ENVELOPE);
		await flushMicrotasks();
		expect(events).toEqual(['success:the result', 'complete']);
	});

	it('routes a failure to onError and never to the global handler; onComplete still runs', async () => {
		const proxy = loadAjaxProxy();
		const globalHandler = vi.fn();
		proxy.setErrorHandler(globalHandler);
		const events: string[] = [];
		proxy.call('X', 'read', {}, {
			onError: (error) => events.push(`error:${error.kind}`),
			onComplete: () => events.push('complete'),
		});

		lastRequest().answer('');
		await flushMicrotasks();
		expect(events).toEqual([`error:${proxy.ErrorKind.EMPTY}`, 'complete']);
		expect(globalHandler).not.toHaveBeenCalled();
	});

	it('falls back to the global handler when onError is omitted', async () => {
		const proxy = loadAjaxProxy();
		const globalHandler = vi.fn();
		proxy.setErrorHandler(globalHandler);
		proxy.call('X', 'read', {}, { onSuccess: () => undefined });

		lastRequest().answer('');
		await flushMicrotasks();
		expect(globalHandler).toHaveBeenCalledTimes(1);
	});

	it('reports a throw inside onSuccess to the global handler and still runs onComplete', async () => {
		const proxy = loadAjaxProxy();
		const globalHandler = vi.fn();
		proxy.setErrorHandler(globalHandler);
		const onComplete = vi.fn();
		proxy.call('X', 'read', {}, {
			onSuccess: () => {
				throw new Error('broken onSuccess');
			},
			onComplete: onComplete,
		});

		lastRequest().answer(OK_ENVELOPE);
		await flushMicrotasks();
		expect(globalHandler).toHaveBeenCalledWith(new Error('broken onSuccess'));
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('reports a throw inside onComplete to the global handler instead of leaking an unhandled rejection', async () => {
		const proxy = loadAjaxProxy();
		const globalHandler = vi.fn();
		proxy.setErrorHandler(globalHandler);
		proxy.call('X', 'read', {}, {
			onSuccess: () => undefined,
			onComplete: () => {
				throw new Error('broken onComplete');
			},
		});

		lastRequest().answer(OK_ENVELOPE);
		await flushMicrotasks();
		expect(globalHandler).toHaveBeenCalledWith(new Error('broken onComplete'));
	});

	it('still runs onComplete when the global handler itself throws while reporting', async () => {
		const proxy = loadAjaxProxy();
		proxy.setErrorHandler(() => {
			throw new Error('broken global handler');
		});
		const onComplete = vi.fn();
		proxy.call('X', 'read', {}, { onComplete: onComplete });

		lastRequest().answer(''); // rejects; the sink is the (broken) global handler
		await flushMicrotasks();
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('returns the promise in callback style too, for callers that want both', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', {}, { onSuccess: () => undefined });

		lastRequest().answer(OK_ENVELOPE);
		await expect(pending).resolves.toBe('the result');
	});
});

describe('AjaxProxy.call — retry', () => {
	it('retry: true retries a timeout once after a 500ms backoff', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', {}, { retry: true, timeout: 1000 });
		expect(FakeGlideAjax.instances).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1000); // first attempt times out
		expect(FakeGlideAjax.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500); // backoff elapses
		expect(FakeGlideAjax.instances).toHaveLength(2);

		lastRequest().answer(OK_ENVELOPE);
		await expect(pending).resolves.toBe('the result');
	});

	it('rejects with the last timeout once attempts are exhausted', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read', {}, { retry: 2, timeout: 1000 }));

		await vi.advanceTimersByTimeAsync(1000); // attempt 1 times out
		await vi.advanceTimersByTimeAsync(500); // backoff
		await vi.advanceTimersByTimeAsync(1000); // attempt 2 times out

		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
		expect(FakeGlideAjax.instances).toHaveLength(2);
	});

	it('doubles the backoff between successive attempts', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', {}, { retry: { attempts: 3, delay: 100 }, timeout: 1000 });

		await vi.advanceTimersByTimeAsync(1000); // attempt 1 times out
		await vi.advanceTimersByTimeAsync(100); // backoff 100 * 2^0
		expect(FakeGlideAjax.instances).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1000); // attempt 2 times out
		await vi.advanceTimersByTimeAsync(100); // half of backoff 100 * 2^1
		expect(FakeGlideAjax.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(100); // the other half
		expect(FakeGlideAjax.instances).toHaveLength(3);

		lastRequest().answer(OK_ENVELOPE);
		await expect(pending).resolves.toBe('the result');
	});

	it('does not retry kinds outside the on-list', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read', {}, { retry: true }));

		lastRequest().answer(''); // kind empty; default on-list is timeout only
		expect((await rejection).kind).toBe(proxy.ErrorKind.EMPTY);
		expect(FakeGlideAjax.instances).toHaveLength(1);
	});

	it('retries the kinds listed in retry.on', async () => {
		const proxy = loadAjaxProxy();
		const pending = proxy.call('X', 'read', {}, { retry: { attempts: 2, delay: 0, on: ['empty'] } });

		lastRequest().answer('');
		await flushMicrotasks();
		expect(FakeGlideAjax.instances).toHaveLength(2);

		lastRequest().answer(OK_ENVELOPE);
		await expect(pending).resolves.toBe('the result');
	});

	it('is off by default', async () => {
		const proxy = loadAjaxProxy();
		const rejection = rejectionOf(proxy.call('X', 'read', {}, { timeout: 100 }));

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(10000);
		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
		expect(FakeGlideAjax.instances).toHaveLength(1);
	});
});

describe('AjaxProxy.for', () => {
	it('binds the script include and applies proxy-wide defaults', async () => {
		const proxy = loadAjaxProxy();
		const errors: string[] = [];
		const users = proxy.for('UserLookupAjax', { timeout: 100, onError: (error: AjaxProxyError) => errors.push(error.kind) });
		users('getUserSummary', { userId: 'u1' });

		expect(lastRequest().scriptInclude).toBe('UserLookupAjax');
		expect(lastRequest().params.get('sysparm_name')).toBe('getUserSummary');

		await vi.advanceTimersByTimeAsync(100);
		await flushMicrotasks();
		expect(errors).toEqual([proxy.ErrorKind.TIMEOUT]);
	});

	it('lets per-call options override the defaults', async () => {
		const proxy = loadAjaxProxy();
		const users = proxy.for('UserLookupAjax', { timeout: 5000 });
		const rejection = rejectionOf(users('getUserSummary', {}, { timeout: 50 }));

		await vi.advanceTimersByTimeAsync(50);
		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
	});
});

describe('AjaxProxy.channel', () => {
	it('debounces: only the latest call within the quiet window fires, with its own parameters', async () => {
		const proxy = loadAjaxProxy();
		const search = proxy.channel('X', 'search', { debounce: 250 });

		const first = search({ q: 'a' });
		await vi.advanceTimersByTimeAsync(100);
		const second = search({ q: 'ab' });
		await vi.advanceTimersByTimeAsync(250);

		expect(FakeGlideAjax.instances).toHaveLength(1);
		expect(JSON.parse(lastRequest().params.get('sysparm_payload') ?? '')).toEqual({ q: 'ab' });

		lastRequest().answer(JSON.stringify({ ok: true, result: ['row'] }));
		await expect(second).resolves.toEqual(['row']);
		await expectNeverSettles(first);
	});

	it('drops a stale response: only the newest call settles, even when the old answer arrives first', async () => {
		const proxy = loadAjaxProxy();
		const search = proxy.channel('X', 'search');

		const first = search({ q: 'a' });
		const second = search({ q: 'ab' });
		expect(FakeGlideAjax.instances).toHaveLength(2);

		requestAt(0).answer(JSON.stringify({ ok: true, result: 'stale' }));
		requestAt(1).answer(JSON.stringify({ ok: true, result: 'fresh' }));

		await expect(second).resolves.toBe('fresh');
		await expectNeverSettles(first);
	});

	it('drops a stale rejection too', async () => {
		const proxy = loadAjaxProxy();
		const search = proxy.channel('X', 'search');

		const first = search({ q: 'a' });
		const second = search({ q: 'ab' });

		requestAt(0).answer(''); // would reject, but the call is superseded
		requestAt(1).answer(JSON.stringify({ ok: true, result: 'fresh' }));

		await expect(second).resolves.toBe('fresh');
		await expectNeverSettles(first);
	});

	it('latest: false lets every call settle', async () => {
		const proxy = loadAjaxProxy();
		const search = proxy.channel('X', 'search', { latest: false });

		const first = search({ q: 'a' });
		const second = search({ q: 'ab' });

		requestAt(0).answer(JSON.stringify({ ok: true, result: 'one' }));
		requestAt(1).answer(JSON.stringify({ ok: true, result: 'two' }));

		await expect(first).resolves.toBe('one');
		await expect(second).resolves.toBe('two');
	});
});

describe('AjaxProxy configuration', () => {
	it('setDefaultTimeout validates and applies to subsequent calls', async () => {
		const proxy = loadAjaxProxy();
		expect(() => proxy.setDefaultTimeout(0)).toThrow('positive number');
		expect(() => proxy.setDefaultTimeout(-5)).toThrow('positive number');

		proxy.setDefaultTimeout(10);
		const rejection = rejectionOf(proxy.call('X', 'read'));
		await vi.advanceTimersByTimeAsync(10);
		expect((await rejection).kind).toBe(proxy.ErrorKind.TIMEOUT);
	});

	it('setErrorHandler rejects non-functions', () => {
		const proxy = loadAjaxProxy();
		expect(() => proxy.setErrorHandler(undefined as unknown as () => void)).toThrow('requires a function');
	});

	it('logUrl builds a STARTSWITH deep link and setLogTable retargets it', () => {
		const proxy = loadAjaxProxy();
		expect(proxy.logUrl('ref-1')).toBe('/syslog_list.do?sysparm_query=' + encodeURIComponent('messageSTARTSWITHref-1'));

		proxy.setLogTable('syslog_app_scope');
		expect(proxy.logUrl('ref-1')).toBe('/syslog_app_scope_list.do?sysparm_query=' + encodeURIComponent('messageSTARTSWITHref-1'));
		expect(() => proxy.setLogTable('')).toThrow('non-empty table name');
	});

	it('logUrl reads the reference off a server error and returns undefined without one', () => {
		const proxy = loadAjaxProxy();
		const serverError = Object.assign(new Error('boom'), { reference: 'ref-2' });

		expect(proxy.logUrl(serverError)).toContain(encodeURIComponent('messageSTARTSWITHref-2'));
		expect(proxy.logUrl(new Error('no reference'))).toBeUndefined();
		expect(proxy.logUrl()).toBeUndefined();
	});
});

function loadAjaxProxy(): AjaxProxyApi {
	FakeGlideAjax.instances = [];
	// Trust boundary: the evaluated first-party ES5 source carries no type information; this is
	// the single point where its runtime shape meets the typed test surface.
	return evaluateGlobalScript(
		'src/ajax-proxy.ui-script.js',
		{ GlideAjax: FakeGlideAjax },
		'AjaxProxy',
	) as AjaxProxyApi;
}

function lastRequest(): FakeGlideAjax {
	return requestAt(FakeGlideAjax.instances.length - 1);
}

function requestAt(index: number): FakeGlideAjax {
	const request = FakeGlideAjax.instances[index];
	if (request === undefined) {
		throw new Error(`no GlideAjax request at index ${index} (fired: ${FakeGlideAjax.instances.length})`);
	}
	return request;
}

/** Captures a promise's expected rejection so tests can assert on the typed error. */
async function rejectionOf(promise: Promise<unknown>): Promise<AjaxProxyError> {
	try {
		await promise;
	} catch (error) {
		// Trust boundary: every rejection AjaxProxy produces is a typed AjaxProxyError; the
		// assertions on kind/message verify it.
		return error as AjaxProxyError;
	}
	throw new Error('expected the promise to reject');
}

/** Flushes pending microtasks (promise reactions) without advancing timers. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

/** Asserts an abandoned channel promise stayed unsettled after microtasks drained. */
async function expectNeverSettles(promise: Promise<unknown>): Promise<void> {
	let hasSettled = false;
	promise.then(
		() => {
			hasSettled = true;
		},
		() => {
			hasSettled = true;
		},
	);
	await flushMicrotasks();
	expect(hasSettled).toBe(false);
}
