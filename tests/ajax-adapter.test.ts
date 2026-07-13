import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { evaluateGlobalScript } from './load-source.js';

type FailOptions = { kind?: string; details?: unknown };
type AjaxFailure = Error & { isAjaxBusinessFailure: true; kind: string; details?: unknown };
type ExposedMethod = (this: object) => string;
type AjaxAdapterApi = {
	VERSION: string;
	PAYLOAD_PARAM: string;
	expose: (privateMethodName: string, parameterNames?: string[]) => ExposedMethod;
	fail: (message?: unknown, options?: FailOptions) => AjaxFailure;
	readArguments: (processor: object, parameterNames?: string[]) => unknown[];
	isFailure: (candidate: unknown) => boolean;
	failureEnvelope: (failure: AjaxFailure) => string;
};
type GsStub = {
	generateGUID: () => string;
	error: Mock<(message: string) => void>;
};
type EnvelopeError = { kind: string; message: string; reference?: string; details?: unknown };
type Envelope = { ok: boolean; result?: unknown; error?: EnvelopeError };
type Processor = Record<string, unknown> & {
	type: string;
	getParameter: (name: string) => string | null;
};

const TEST_REFERENCE = 'test-reference-guid';

describe('AjaxAdapter.expose', () => {
	it('maps payload keys positionally and wraps the result in an ok envelope', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_join', ['first', 'second']);
		const processor = makeProcessor(JSON.stringify({ second: 2, first: 'one' }), {
			_join: (first: unknown, second: unknown) => [first, second],
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({ ok: true, result: ['one', 2] });
	});

	it('preserves value types across the payload: numbers, null, and absent keys', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_echo', ['count', 'missing', 'nothing']);
		const processor = makeProcessor(JSON.stringify({ count: 42, nothing: null }), {
			_echo: (count: unknown, missing: unknown, nothing: unknown) => ({
				count: count,
				missingIsUndefined: missing === undefined,
				nothing: nothing,
			}),
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: true,
			result: { count: 42, missingIsUndefined: true, nothing: null },
		});
	});

	it('omits `result` entirely when the private method returns undefined', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_noop', []);
		const processor = makeProcessor('{}', { _noop: () => undefined });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope).toEqual({ ok: true });
		expect('result' in envelope).toBe(false);
	});

	it('passes undefined for every argument when no payload is sent', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_check', ['a', 'b']);
		const processor = makeProcessor(null, {
			_check: (a: unknown, b: unknown) => [a === undefined, b === undefined],
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({ ok: true, result: [true, true] });
	});

	it('rejects an unparsable payload with kind badRequest', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', []);
		const processor = makeProcessor('this is not json', { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain('not valid JSON');
	});

	it('rejects a non-object payload with kind badRequest', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', []);
		const processor = makeProcessor('"just a string"', { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain('must be a JSON object');
	});

	it('rejects an array payload with kind badRequest instead of all-undefined arguments', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', ['a']);
		const processor = makeProcessor('[1, 2]', { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain('must be a JSON object');
	});

	it('converts a THROWN AjaxAdapter.fail into a business envelope with details, unlogged', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_reject', []);
		const processor = makeProcessor('{}', {
			_reject: () => {
				throw adapter.fail('No manager assigned', { details: { userId: 'u1' } });
			},
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: false,
			error: { kind: 'business', message: 'No manager assigned', details: { userId: 'u1' } },
		});
		expect(gs.error).not.toHaveBeenCalled();
	});

	it('converts a RETURNED AjaxAdapter.fail into the same business envelope', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_reject', []);
		const processor = makeProcessor('{}', { _reject: () => adapter.fail('Nothing to return') });

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: false,
			error: { kind: 'business', message: 'Nothing to return' },
		});
	});

	it('lets a custom fail kind pass through to the envelope', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_reject', []);
		const processor = makeProcessor('{}', {
			_reject: () => {
				throw adapter.fail('Quota exhausted', { kind: 'quota' });
			},
		});

		expect(parseEnvelope(publicMethod.call(processor)).error?.kind).toBe('quota');
	});

	it('anonymizes an unexpected error to a referenced server envelope and logs the detail', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_boom', []);
		const processor = makeProcessor('{}', {
			_boom: () => {
				throw new Error('secret internal detail');
			},
		});

		const answer = publicMethod.call(processor);
		expect(parseEnvelope(answer)).toEqual({
			ok: false,
			error: { kind: 'server', message: 'Unexpected server error', reference: TEST_REFERENCE },
		});
		expect(answer).not.toContain('secret internal detail');

		expect(gs.error).toHaveBeenCalledTimes(1);
		const loggedMessage = gs.error.mock.calls[0]?.[0] ?? '';
		expect(loggedMessage.startsWith(TEST_REFERENCE)).toBe(true);
		expect(loggedMessage).toContain('[AjaxAdapter]');
		expect(loggedMessage).toContain('TestAjax._boom');
		expect(loggedMessage).toContain('secret internal detail');
	});

	it('reports a missing private method as an anonymized server error', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_missing');
		const processor = makeProcessor('{}');

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.kind).toBe('server');
		expect(envelope.error?.message).toBe('Unexpected server error');
		expect(gs.error.mock.calls[0]?.[0] ?? '').toContain('_missing');
	});
});

describe('AjaxAdapter.fail', () => {
	it('throws on a missing, empty, or non-string message', () => {
		const adapter = loadAjaxAdapter(makeGs());

		expect(() => adapter.fail()).toThrow('non-empty message string');
		expect(() => adapter.fail('')).toThrow('non-empty message string');
		expect(() => adapter.fail(42)).toThrow('non-empty message string');
	});

	it('surfaces fail() misuse inside a private method as a logged server error, not a blank business message', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_misuse', []);
		const processor = makeProcessor('{}', {
			_misuse: () => {
				throw adapter.fail('');
			},
		});

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('server');
		expect(gs.error.mock.calls[0]?.[0] ?? '').toContain('non-empty message string');
	});
});

describe('AjaxAdapter.readArguments', () => {
	it('resolves a parameter named like an Object.prototype member to undefined when absent', () => {
		const adapter = loadAjaxAdapter(makeGs());

		expect(adapter.readArguments(makeProcessor('{}'), ['constructor', 'toString'])).toEqual([undefined, undefined]);
	});

	it('still delivers a parameter named like an Object.prototype member when present', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const processor = makeProcessor(JSON.stringify({ constructor: 'x' }));

		expect(adapter.readArguments(processor, ['constructor'])).toEqual(['x']);
	});
});

describe('AjaxAdapter.isFailure / failureEnvelope', () => {
	it('recognizes the marker flag without instanceof, and rejects unmarked values', () => {
		const adapter = loadAjaxAdapter(makeGs());

		// A failure that crossed a scope boundary is not instanceof this scope's Error;
		// only the flag matters.
		expect(adapter.isFailure({ isAjaxBusinessFailure: true, message: 'from another scope' })).toBe(true);
		expect(adapter.isFailure(new Error('plain'))).toBe(false);
		expect(adapter.isFailure(undefined)).toBe(false);
		expect(adapter.isFailure(null)).toBe(false);
	});

	it('drops undefined details from the envelope', () => {
		const adapter = loadAjaxAdapter(makeGs());

		const envelope = parseEnvelope(adapter.failureEnvelope(adapter.fail('No details here')));
		expect('details' in (envelope.error ?? {})).toBe(false);
	});
});

function loadAjaxAdapter(gsStub: GsStub): AjaxAdapterApi {
	const classStub = {
		create: () => function AjaxAdapterStub() { /* property holder, never instantiated */ },
	};
	// Trust boundary: the evaluated first-party ES5 source carries no type information; this is
	// the single point where its runtime shape meets the typed test surface.
	return evaluateGlobalScript(
		'src/ajax-adapter.script-include.js',
		{ Class: classStub, gs: gsStub },
		'AjaxAdapter',
	) as AjaxAdapterApi;
}

function makeGs(): GsStub {
	return {
		generateGUID: () => TEST_REFERENCE,
		error: vi.fn<(message: string) => void>(),
	};
}

function makeProcessor(payloadJson: string | null, methods: Record<string, unknown> = {}): Processor {
	return {
		type: 'TestAjax',
		getParameter: (name: string): string | null => (name === 'sysparm_payload' ? payloadJson : null),
		...methods,
	};
}

function parseEnvelope(answer: string): Envelope {
	// Trust boundary: the adapter's contract is that every answer is an envelope; the
	// assertions on the parsed value verify the shape.
	return JSON.parse(answer) as Envelope;
}

function neverCalled(): never {
	throw new Error('the private method must not run for this input');
}
