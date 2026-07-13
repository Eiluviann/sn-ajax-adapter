import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { evaluateGlobalScript } from './load-source.js';

type FailOptions = { kind?: string; details?: unknown };
type AjaxFailure = Error & { isAjaxBusinessFailure: true; kind: string; details?: unknown };
type ExposedMethod = (this: object) => string;
type ParameterEntry = string | { name: string; type?: string; required?: boolean; default?: unknown };
type AjaxAdapterApi = {
	VERSION: string;
	PAYLOAD_PARAM: string;
	DATETIME_TAG: string;
	VERSION_PARAM: string;
	MAX_PAYLOAD_LENGTH: number;
	expose: (privateMethodName: string, parameterNames?: ParameterEntry[]) => ExposedMethod;
	fail: (message?: unknown, options?: FailOptions) => AjaxFailure;
	readArguments: (processor: object, parameterNames?: ParameterEntry[]) => unknown[];
	isFailure: (candidate: unknown) => boolean;
	failureEnvelope: (failure: AjaxFailure) => string;
};
type GsStub = {
	generateGUID: () => string;
	error: Mock<(message: string) => void>;
	warn: Mock<(message: string) => void>;
};
type EnvelopeError = { kind: string; message: string; reference?: string; details?: unknown };
type Envelope = { ok: boolean; result?: unknown; error?: EnvelopeError };
type Processor = Record<string, unknown> & {
	type: string;
	getParameter: (name: string) => string | null;
};

/** Duck-type-compatible stand-in for the platform GlideDateTime. */
class FakeGlideDateTime {
	#milliseconds = 0;

	getNumericValue(): number {
		return this.#milliseconds;
	}

	setNumericValue(milliseconds: number): void {
		this.#milliseconds = milliseconds;
	}

	getTZOffset(): number {
		return 0;
	}
}

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

describe('AjaxAdapter parameter contracts', () => {
	it('rejects a missing required parameter with badRequest, unlogged', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_never', [{ name: 'userId', type: 'string', required: true }]);
		const processor = makeProcessor('{}', { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toBe("Invalid parameters: 'userId' is required");
		expect(gs.error).not.toHaveBeenCalled();
	});

	it('rejects a mistyped parameter and reports every violation in one message', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', [
			{ name: 'userId', type: 'string', required: true },
			{ name: 'count', type: 'number' },
			{ name: 'flags', type: 'array' },
		]);
		const processor = makeProcessor(JSON.stringify({ count: 'five', flags: {} }), { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toBe(
			"Invalid parameters: 'userId' is required; 'count' must be of type number; 'flags' must be of type array",
		);
	});

	it('enforces required even when no payload was sent at all', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', [{ name: 'userId', required: true }]);
		const processor = makeProcessor(null, { _never: neverCalled });

		expect(parseEnvelope(publicMethod.call(processor)).error?.kind).toBe('badRequest');
	});

	it('fills an absent parameter from its default', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_echo', [
			{ name: 'userId', type: 'string', required: true },
			{ name: 'options', type: 'object', default: { includeGroups: false } },
		]);
		const processor = makeProcessor(JSON.stringify({ userId: 'u1' }), {
			_echo: (userId: unknown, options: unknown) => ({ userId, options }),
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: true,
			result: { userId: 'u1', options: { includeGroups: false } },
		});
	});

	it('does NOT substitute the default for an explicit null (null is a sent value)', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', [{ name: 'options', type: 'object', default: {} }]);
		const processor = makeProcessor(JSON.stringify({ options: null }), { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain("'options' must be of type object");
	});

	it('accepts a valid payload and keeps plain-string entries working alongside contracts', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_join', [{ name: 'first', type: 'number' }, 'second']);
		const processor = makeProcessor(JSON.stringify({ first: 1, second: 'two' }), {
			_join: (first: unknown, second: unknown) => [first, second],
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({ ok: true, result: [1, 'two'] });
	});

	it('throws at expose() time for an unknown contract type (load-time developer bug)', () => {
		const adapter = loadAjaxAdapter(makeGs());

		expect(() => adapter.expose('_x', [{ name: 'when', type: 'integer' }])).toThrow('unknown parameter type "integer"');
		expect(() => adapter.expose('_x', [''])).toThrow('non-empty string name');
	});
});

describe('AjaxAdapter date marshalling', () => {
	it('revives a wire date tag into a GlideDateTime carrying the exact instant', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const iso = '2026-08-01T09:00:00.000Z';
		const publicMethod = adapter.expose('_inspect', [{ name: 'since', type: 'date', required: true }]);
		const processor = makeProcessor(JSON.stringify({ since: { $dateTime: iso } }), {
			_inspect: (since: unknown) => ({
				isFake: since instanceof FakeGlideDateTime,
				ms: since instanceof FakeGlideDateTime ? since.getNumericValue() : undefined,
			}),
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: true,
			result: { isFake: true, ms: Date.parse(iso) },
		});
	});

	it('rejects an unparseable date tag with badRequest', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', ['since']);
		const processor = makeProcessor(JSON.stringify({ since: { $dateTime: 'not-a-date' } }), { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain('not a valid ISO 8601');
	});

	it("the 'date' contract type rejects a plain string that was never a Date", () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_never', [{ name: 'since', type: 'date' }]);
		const processor = makeProcessor(JSON.stringify({ since: '2026-08-01T09:00:00Z' }), { _never: neverCalled });

		expect(parseEnvelope(publicMethod.call(processor)).error?.message).toContain("'since' must be of type date");
	});

	it('does not revive look-alike objects: extra keys or a non-string value stay plain', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_echo', ['a', 'b']);
		const processor = makeProcessor(
			JSON.stringify({ a: { $dateTime: '2026-01-01T00:00:00Z', extra: 1 }, b: { $dateTime: 42 } }),
			{ _echo: (a: unknown, b: unknown) => [a instanceof FakeGlideDateTime, b instanceof FakeGlideDateTime] },
		);

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({ ok: true, result: [false, false] });
	});

	it('serializes a returned GlideDateTime as the wire tag with the ISO instant', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const when = new FakeGlideDateTime();
		when.setNumericValue(Date.parse('2026-08-01T09:00:00.000Z'));
		const publicMethod = adapter.expose('_now', []);
		const processor = makeProcessor('{}', { _now: () => ({ when }) });

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: true,
			result: { when: { $dateTime: '2026-08-01T09:00:00.000Z' } },
		});
	});

	it('serializes a returned server Date the same way, and tags inside failure details too', () => {
		const adapter = loadAjaxAdapter(makeGs());
		const publicMethod = adapter.expose('_reject', []);
		const processor = makeProcessor('{}', {
			_reject: () => {
				throw adapter.fail('Too early', { details: { opensAt: new Date('2026-08-01T09:00:00.000Z') } });
			},
		});

		expect(parseEnvelope(publicMethod.call(processor))).toEqual({
			ok: false,
			error: { kind: 'business', message: 'Too early', details: { opensAt: { $dateTime: '2026-08-01T09:00:00.000Z' } } },
		});
	});
});

describe('AjaxAdapter serialization guardrails', () => {
	it('rejects a returned GlideElement loudly instead of silently serializing {}', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const glideElementFake = { getED: () => ({}), getDisplayValue: () => 'Fix the widget' };
		const publicMethod = adapter.expose('_leak', []);
		const processor = makeProcessor('{}', { _leak: () => ({ name: glideElementFake }) });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('server');
		const loggedMessage = gs.error.mock.calls[0]?.[0] ?? '';
		expect(loggedMessage).toContain('GlideElement');
		expect(loggedMessage).toContain('"name"');
	});

	it('rejects any other Java object (getClass fingerprint) loudly', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const javaObjectFake = { getClass: () => 'class com.glide.script.GlideRecord' };
		const publicMethod = adapter.expose('_leak', []);
		const processor = makeProcessor('{}', { _leak: () => ({ record: javaObjectFake }) });

		expect(parseEnvelope(publicMethod.call(processor)).error?.kind).toBe('server');
		expect(gs.error.mock.calls[0]?.[0] ?? '').toContain('Java object');
	});

	it('rejects an invalid returned Date loudly', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_bad', []);
		const processor = makeProcessor('{}', { _bad: () => ({ when: new Date('nonsense') }) });

		expect(parseEnvelope(publicMethod.call(processor)).error?.kind).toBe('server');
		expect(gs.error.mock.calls[0]?.[0] ?? '').toContain('invalid Date');
	});

	it('keeps the never-throws invariant when a thrown failure has unserializable details', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const circular: Record<string, unknown> = {};
		circular['self'] = circular;
		const publicMethod = adapter.expose('_reject', []);
		const processor = makeProcessor('{}', {
			_reject: () => {
				throw adapter.fail('has circular details', { details: circular });
			},
		});

		// Must not throw; must degrade to the anonymized server envelope.
		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('server');
		expect(gs.error).toHaveBeenCalledTimes(1);
	});

	it('rejects an oversized payload with badRequest before parsing', () => {
		const adapter = loadAjaxAdapter(makeGs());
		adapter.MAX_PAYLOAD_LENGTH = 10;
		const publicMethod = adapter.expose('_never', ['a']);
		const processor = makeProcessor(JSON.stringify({ a: 'a value well beyond ten characters' }), { _never: neverCalled });

		const envelope = parseEnvelope(publicMethod.call(processor));
		expect(envelope.error?.kind).toBe('badRequest');
		expect(envelope.error?.message).toContain('maximum size');
	});
});

describe('AjaxAdapter version skew', () => {
	it('warns when the client major.minor differs', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const publicMethod = adapter.expose('_ok', []);
		const processor = makeProcessor('{}', { _ok: () => 'fine' }, { [adapter.VERSION_PARAM]: '9.9.9' });

		publicMethod.call(processor);
		expect(gs.warn).toHaveBeenCalledTimes(1);
		expect(gs.warn.mock.calls[0]?.[0] ?? '').toContain('version skew');
	});

	it('stays silent for a matching major.minor (patch drift is fine) and for absent versions', () => {
		const gs = makeGs();
		const adapter = loadAjaxAdapter(gs);
		const samePatchDrift = adapter.VERSION.split('.').slice(0, 2).join('.') + '.99';
		const publicMethod = adapter.expose('_ok', []);

		publicMethod.call(makeProcessor('{}', { _ok: () => 'fine' }, { [adapter.VERSION_PARAM]: samePatchDrift }));
		publicMethod.call(makeProcessor('{}', { _ok: () => 'fine' }));
		expect(gs.warn).not.toHaveBeenCalled();
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
		{ Class: classStub, gs: gsStub, GlideDateTime: FakeGlideDateTime },
		'AjaxAdapter',
	) as AjaxAdapterApi;
}

function makeGs(): GsStub {
	return {
		generateGUID: () => TEST_REFERENCE,
		error: vi.fn<(message: string) => void>(),
		warn: vi.fn<(message: string) => void>(),
	};
}

function makeProcessor(
	payloadJson: string | null,
	methods: Record<string, unknown> = {},
	extraParams: Record<string, string> = {},
): Processor {
	return {
		type: 'TestAjax',
		getParameter: (name: string): string | null => {
			if (name === 'sysparm_payload') {
				return payloadJson;
			}
			return extraParams[name] ?? null;
		},
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
