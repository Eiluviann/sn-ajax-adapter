/**
 * AjaxAdapter: factory that adapts a private method to the GlideAjax calling convention.
 * Client-side counterpart: AjaxProxy.
 *
 * Full documentation, install steps, and design notes: https://github.com/Eiluviann/sn-ajax-adapter
 */
var AjaxAdapter = Class.create();

/** Semver of this file. Bump on every change (see the repo's CHANGELOG.md). */
AjaxAdapter.VERSION = '1.1.0';

/**
 * Single carrier param for the JSON argument payload. Must match AjaxProxy. GlideAjax only
 * reserves its own sysparm_name / sysparm_processor, so this name is free to rebrand per app.
 */
AjaxAdapter.PAYLOAD_PARAM = 'sysparm_payload';

/**
 * Single-key wrapper marking a date-time on the wire: { $dateTime: '<ISO 8601 UTC>' }.
 * Must match AjaxProxy. A client Date arrives as a GlideDateTime, a returned GlideDateTime
 * (or server Date) arrives as a client Date. Only an object whose SOLE key is this tag is
 * converted, so ordinary data can't collide by accident.
 */
AjaxAdapter.DATETIME_TAG = '$dateTime';

/** Param carrying the client AjaxProxy version, so the server can warn on a mismatched install. */
AjaxAdapter.VERSION_PARAM = 'sysparm_adapter_version';

/**
 * Maximum accepted payload length in characters (default 1,000,000). A larger payload is
 * rejected as badRequest instead of grinding through parse and query time. Raise it per
 * app by assigning to this property before the first call.
 */
AjaxAdapter.MAX_PAYLOAD_LENGTH = 1000000;

/** Types a parameter contract may declare. 'date' matches a revived GlideDateTime. */
AjaxAdapter.PARAMETER_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'date'];

/**
 * Creates a public GlideAjax-facing method that delegates to a private method.
 *
 * The returned function is assigned directly on the prototype of a script include
 * extending AbstractAjaxProcessor. When GlideAjax invokes it, `this` is the
 * processor instance, so getParameter() and the private method are both reachable.
 *
 * Invariant: the generated method never throws. Success, an expected AjaxAdapter.fail, and an
 * unexpected bug all become a JSON envelope string, so GlideAjax always hands the client a
 * well-formed answer and getXMLAnswer never has to cope with a raw exception.
 *
 * @param {string} privateMethodName - Name of the private method on the same prototype (e.g. '_getUserSummary').
 * @param {Array<string | { name: string, type?: string, required?: boolean, default?: * }>} [parameterNames] -
 *   Payload keys, in the positional order the private method expects them. A plain string is just a
 *   mapping; an object adds a contract enforced at the boundary: `type` (one of PARAMETER_TYPES),
 *   `required`, and `default` (used when the key is absent). Violations reject the call with kind
 *   'badRequest' — all of them at once — and the private method never runs, so it can trust its
 *   arguments and skip the guard clauses. A name that is absent, optional, and defaultless arrives
 *   as undefined.
 * @returns {function(): string} Public method returning the stringified answer envelope.
 * @throws {Error} At definition time, when a contract entry is malformed (developer bug).
 */
AjaxAdapter.expose = function(privateMethodName, parameterNames) {
	// Contracts are validated eagerly so a typo in a type name fails when the script include
	// loads, in development, not on the first client call in production.
	var contracts = (parameterNames || []).map(function(entry) {
		return AjaxAdapter.normalizeParameter(entry);
	});
	return function() {
		var processor = this;
		try {
			AjaxAdapter.warnOnVersionSkew(processor);
			var privateMethod = processor[privateMethodName];
			if (typeof privateMethod !== 'function') {
				throw new Error('Private method "' + privateMethodName + '" does not exist on ' + processor.type);
			}
			var args = AjaxAdapter.readArguments(processor, contracts);
			var value = privateMethod.apply(processor, args);
			if (AjaxAdapter.isFailure(value)) {
				return AjaxAdapter.failureEnvelope(value);
			}
			return AjaxAdapter.resultEnvelope(value);
		} catch (error) {
			if (AjaxAdapter.isFailure(error)) {
				try {
					return AjaxAdapter.failureEnvelope(error);
				} catch (envelopeError) {
					// A failure whose details cannot be serialized (circular value, Java object)
					// falls through to the anonymized path below, so the generated method keeps
					// its never-throws invariant.
					error = envelopeError;
				}
			}
			var reference = gs.generateGUID();
			var message = error && error.message ? String(error.message) : String(error);
			var stack = error && error.stack ? '\n' + String(error.stack) : '';
			// Reference FIRST so the client's ref id finds this row instantly via
			// syslog.message STARTSWITH <ref>. The [AjaxAdapter] tag supports a LIKE sweep. The private
			// method name stays in the log only, it never crosses to the client on the anonymized path.
			gs.error(reference + ' [AjaxAdapter] ' + processor.type + '.' + privateMethodName + ': ' + message + stack);
			return JSON.stringify({
				ok: false,
				error: {
					kind: 'server',
					message: 'Unexpected server error',
					reference: reference,
				},
			});
		}
	};
};

/**
 * Signals an EXPECTED, user-facing failure from inside a private method.
 * Throw it (or return it) to reject the client call with a safe, unlogged message.
 *
 * Throwing reads best as a guard clause, and returning suits a Result-style method. Either way the
 * adapter recognizes the marker and converts it to a business envelope.
 *
 * @param {string} message - Developer-authored message, safe to show to the caller.
 * @param {{ kind?: string, details?: * }} [options] - kind overrides the 'business' discriminator. details is
 *   serialized into the client envelope, so keep it free of anything the caller shouldn't see.
 * @returns {Error} A marked failure the adapter converts to an { ok: false } envelope.
 * @throws {Error} When message is not a non-empty string (developer bug). Thrown from inside a
 *   private method, the adapter logs it and anonymizes it to a 'server' envelope, so the misuse
 *   surfaces in the log instead of shipping a blank message to the user.
 */
AjaxAdapter.fail = function(message, options) {
	if (typeof message !== 'string' || message === '') {
		throw new Error('AjaxAdapter.fail requires a non-empty message string');
	}
	var failure = new Error(message);
	failure.isAjaxBusinessFailure = true;
	failure.kind = options && options.kind ? String(options.kind) : 'business';
	if (options && options.details !== undefined) {
		failure.details = options.details;
	}
	return failure;
};

AjaxAdapter.prototype = {
	type: 'AjaxAdapter',
};

/**
 * Reads the positional arguments for a private method from the request and enforces the
 * parameter contracts.
 *
 * Every parameter arrives inside one JSON object under PAYLOAD_PARAM. getParameter()
 * returns a Java string under the Rhino engine. `new String()` moves it to the JS side
 * and the outer String() collapses the String *object* wrapper into a primitive before
 * JSON.parse. Values that come back out of JSON.parse are already JS primitives. A
 * number is a number, not '42', and needs no further wrapping. A date tag becomes a
 * GlideDateTime via the reviver.
 *
 * @param {*} processor - The AbstractAjaxProcessor instance handling the request.
 * @param {Array<string | Object>} parameterContracts - Entries accepted by expose(); raw or normalized.
 * @returns {Array<*>} Parsed arguments. An omitted key (or no payload at all) is undefined
 *   unless the contract supplies a default.
 * @throws {Error} Via AjaxAdapter.fail (kind 'badRequest') when the payload is oversized, not a
 *   JSON object, carries an invalid date tag, or violates a parameter contract.
 */
AjaxAdapter.readArguments = function(processor, parameterContracts) {
	var contracts = (parameterContracts || []).map(function(entry) {
		return AjaxAdapter.normalizeParameter(entry);
	});
	var rawParam = processor.getParameter(AjaxAdapter.PAYLOAD_PARAM);
	// Coerce the Java string to a JS primitive BEFORE any comparison: a Java "" is not === '' in
	// Rhino, so testing the raw value would misclassify a genuinely empty payload as non-empty.
	var payloadRaw = (rawParam === null || rawParam === undefined) ? '' : String(new String(rawParam));

	if (payloadRaw.length > AjaxAdapter.MAX_PAYLOAD_LENGTH) {
		throw AjaxAdapter.fail(AjaxAdapter.PAYLOAD_PARAM + ' exceeds the maximum size of ' + AjaxAdapter.MAX_PAYLOAD_LENGTH + ' characters', { kind: 'badRequest' });
	}

	// No payload (e.g. a raw GlideAjax caller sending nothing): treated as an empty object, so
	// required/default contracts still apply.
	var payload = {};
	if (payloadRaw !== '') {
		try {
			payload = JSON.parse(payloadRaw, AjaxAdapter.reviveWireValue);
		} catch (parseError) {
			if (AjaxAdapter.isFailure(parseError)) {
				throw parseError; // a reviver rejection (invalid date tag) is already typed
			}
			throw AjaxAdapter.fail(AjaxAdapter.PAYLOAD_PARAM + ' is not valid JSON: ' + parseError.message, { kind: 'badRequest' });
		}
		// Array.isArray: an array is typeof 'object' too, but its "arguments" would all silently
		// resolve to undefined. Reject it as the contract violation it is.
		if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
			throw AjaxAdapter.fail(AjaxAdapter.PAYLOAD_PARAM + ' must be a JSON object', { kind: 'badRequest' });
		}
	}

	// Collect EVERY violation before failing, so a sloppy caller fixes the call in one
	// round trip instead of one message per attempt.
	var violations = [];
	var args = contracts.map(function(contract) {
		// hasOwnProperty so a parameter named like an Object.prototype member ('constructor',
		// 'toString', …) resolves to undefined when absent, not to an inherited function.
		var isPresent = Object.prototype.hasOwnProperty.call(payload, contract.name);
		var value = isPresent ? payload[contract.name] : undefined;
		if (value === undefined && Object.prototype.hasOwnProperty.call(contract, 'default')) {
			return contract['default'];
		}
		if (value === undefined) {
			if (contract.required) {
				violations.push("'" + contract.name + "' is required");
			}
			return undefined;
		}
		if (contract.type !== undefined && !AjaxAdapter.matchesType(value, contract.type)) {
			violations.push("'" + contract.name + "' must be of type " + contract.type);
		}
		return value;
	});
	if (violations.length > 0) {
		throw AjaxAdapter.fail('Invalid parameters: ' + violations.join('; '), { kind: 'badRequest' });
	}
	return args;
};

/**
 * Detects an AjaxAdapter.fail marker. Uses a named boolean flag rather than instanceof because a
 * failure created in one script-include scope must still be recognized here. instanceof is
 * unreliable across ServiceNow scope boundaries, a plain flag is not.
 *
 * @param {*} candidate
 * @returns {boolean} True when the value is a marked AjaxAdapter.fail failure.
 */
AjaxAdapter.isFailure = function(candidate) {
	return Boolean(candidate) && candidate.isAjaxBusinessFailure === true;
};

/**
 * Serializes a marked failure into an { ok: false } envelope. undefined fields (e.g. details) drop
 * out. No method name is emitted. The client already knows the public method it called.
 *
 * @param {Error} failure - An AjaxAdapter.fail value.
 * @returns {string}
 * @throws {Error} When details cannot be serialized (circular value, Java object); expose()
 *   converts that into the anonymized server path.
 */
AjaxAdapter.failureEnvelope = function(failure) {
	return JSON.stringify({
		ok: false,
		error: {
			kind: failure.kind || 'business',
			message: String(failure.message),
			details: failure.details,
		},
	}, AjaxAdapter.serializeWireValue);
};

/**
 * Serializes a private method's return value into an { ok: true } envelope.
 * Faithful round-trip: undefined omits `result` (JSON.stringify drops it) and the client reads
 * it back as undefined. null is preserved. No undefined-to-null.
 *
 * @param {*} value - The private method's return value.
 * @returns {string}
 * @throws {Error} When the value contains something JSON cannot represent (see serializeWireValue).
 */
AjaxAdapter.resultEnvelope = function(value) {
	return JSON.stringify({ ok: true, result: value }, AjaxAdapter.serializeWireValue);
};

/**
 * Normalizes one expose() parameter entry into { name, type?, required, default? }.
 * Idempotent: feeding a normalized contract back in returns an equivalent contract.
 *
 * @param {string | { name: string, type?: string, required?: boolean, default?: * }} entry
 * @returns {{ name: string, type: (string|undefined), required: boolean, default?: * }}
 * @throws {Error} When the entry or its type is malformed (developer bug, thrown at load time).
 */
AjaxAdapter.normalizeParameter = function(entry) {
	if (typeof entry === 'string' && entry !== '') {
		return { name: entry, type: undefined, required: false };
	}
	if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name !== '') {
		if (entry.type !== undefined && AjaxAdapter.PARAMETER_TYPES.indexOf(entry.type) === -1) {
			throw new Error('AjaxAdapter.expose: unknown parameter type "' + entry.type + '" for "' + entry.name + '" (expected one of: ' + AjaxAdapter.PARAMETER_TYPES.join(', ') + ')');
		}
		var contract = { name: entry.name, type: entry.type, required: entry.required === true };
		if (Object.prototype.hasOwnProperty.call(entry, 'default')) {
			contract['default'] = entry['default'];
		}
		return contract;
	}
	throw new Error('AjaxAdapter.expose: each parameter must be a non-empty string name or a { name, type?, required?, default? } contract');
};

/**
 * @param {*} value - A payload value (post-revive, so a date tag is already a GlideDateTime).
 * @param {string} type - One of PARAMETER_TYPES.
 * @returns {boolean} True when the value satisfies the declared type. null satisfies none.
 */
AjaxAdapter.matchesType = function(value, type) {
	switch (type) {
		case 'string': return typeof value === 'string';
		case 'number': return typeof value === 'number';
		case 'boolean': return typeof value === 'boolean';
		case 'array': return Array.isArray(value);
		case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
		case 'date': return AjaxAdapter.isGlideDateTime(value);
		default: return true; // unreachable: normalizeParameter validated the type
	}
};

/**
 * JSON.stringify replacer for outbound envelopes: converts date-times to the wire tag and fails
 * LOUDLY on platform objects JSON cannot represent (which would otherwise serialize as {}).
 *
 * Reads `this[key]` rather than `value` because Date.prototype.toJSON runs before a replacer
 * sees the value; the holder object still has the original.
 *
 * @param {string} key
 * @param {*} value
 * @returns {*}
 * @throws {Error} On an invalid Date, a GlideElement, or any other Java object in the result.
 */
AjaxAdapter.serializeWireValue = function(key, value) {
	var original = this[key];
	if (original instanceof Date) {
		if (isNaN(original.getTime())) {
			throw new Error('result value at "' + key + '" is an invalid Date');
		}
		return AjaxAdapter.dateTimeTag(original.getTime());
	}
	if (AjaxAdapter.isGlideDateTime(original)) {
		return AjaxAdapter.dateTimeTag(Number(original.getNumericValue()));
	}
	if (AjaxAdapter.isGlideElement(original)) {
		throw new Error('result value at "' + key + '" is a GlideElement, which JSON serializes as {}. Return a plain value instead: String(gr.getValue(...)) or gr.<field>.getDisplayValue()');
	}
	if (AjaxAdapter.isJavaObject(original)) {
		throw new Error('result value at "' + key + '" is a Java object, which JSON cannot represent. Coerce it with String()/Number() first');
	}
	return value;
};

/**
 * JSON.parse reviver for the inbound payload: converts a wire date tag into a GlideDateTime.
 *
 * @param {string} key
 * @param {*} value
 * @returns {*}
 * @throws {Error} Via AjaxAdapter.fail (kind 'badRequest') when a tag's value is not a parseable
 *   ISO 8601 date-time.
 */
AjaxAdapter.reviveWireValue = function(key, value) {
	if (!AjaxAdapter.isDateTag(value)) {
		return value;
	}
	var milliseconds = Date.parse(value[AjaxAdapter.DATETIME_TAG]);
	if (isNaN(milliseconds)) {
		throw AjaxAdapter.fail(AjaxAdapter.DATETIME_TAG + ' value "' + value[AjaxAdapter.DATETIME_TAG] + '" is not a valid ISO 8601 date-time', { kind: 'badRequest' });
	}
	var dateTime = new GlideDateTime();
	dateTime.setNumericValue(milliseconds);
	return dateTime;
};

/**
 * @param {number} milliseconds - Epoch milliseconds.
 * @returns {Object} The single-key wire tag with the ISO 8601 UTC representation.
 */
AjaxAdapter.dateTimeTag = function(milliseconds) {
	var tag = {};
	tag[AjaxAdapter.DATETIME_TAG] = new Date(milliseconds).toISOString();
	return tag;
};

/**
 * @param {*} candidate
 * @returns {boolean} True when the value is exactly a wire date tag: one own key, the tag, a string.
 */
AjaxAdapter.isDateTag = function(candidate) {
	return Boolean(candidate) &&
		typeof candidate === 'object' &&
		!Array.isArray(candidate) &&
		typeof candidate[AjaxAdapter.DATETIME_TAG] === 'string' &&
		Object.keys(candidate).length === 1;
};

/**
 * Duck-typed GlideDateTime detection. instanceof is unreliable when a scoped app hands its
 * GlideDateTime to this global adapter (the same reason isFailure uses a flag), so the
 * fingerprint is the method trio no other Glide value class carries together.
 *
 * @param {*} candidate
 * @returns {boolean}
 */
AjaxAdapter.isGlideDateTime = function(candidate) {
	return Boolean(candidate) &&
		typeof candidate.getNumericValue === 'function' &&
		typeof candidate.setNumericValue === 'function' &&
		typeof candidate.getTZOffset === 'function';
};

/**
 * Duck-typed GlideElement detection: getED (the element descriptor accessor) is unique to
 * record fields among the values a private method plausibly returns.
 *
 * @param {*} candidate
 * @returns {boolean}
 */
AjaxAdapter.isGlideElement = function(candidate) {
	return Boolean(candidate) &&
		typeof candidate.getED === 'function' &&
		typeof candidate.getDisplayValue === 'function';
};

/**
 * Generic Java-object detection: Rhino exposes getClass() on wrapped Java objects; plain JS
 * values have no such member. Catches GlideRecord, GlideDuration, and friends.
 *
 * @param {*} candidate
 * @returns {boolean}
 */
AjaxAdapter.isJavaObject = function(candidate) {
	return Boolean(candidate) &&
		typeof candidate === 'object' &&
		typeof candidate.getClass === 'function';
};

/**
 * Logs a warning when the calling AjaxProxy's major.minor differs from this file's. The two
 * files share one wire format, so a skewed install surfaces here instead of as confusing
 * 'malformed' errors. Silent when the param is absent (a pre-1.1 proxy or a raw GlideAjax caller).
 *
 * @param {*} processor - The AbstractAjaxProcessor instance handling the request.
 */
AjaxAdapter.warnOnVersionSkew = function(processor) {
	var rawVersion = processor.getParameter(AjaxAdapter.VERSION_PARAM);
	if (rawVersion === null || rawVersion === undefined || rawVersion === '') {
		return;
	}
	var clientVersion = String(new String(rawVersion));
	if (AjaxAdapter.majorMinorOf(clientVersion) === AjaxAdapter.majorMinorOf(AjaxAdapter.VERSION)) {
		return;
	}
	gs.warn('[AjaxAdapter] version skew: client AjaxProxy ' + clientVersion + ' vs server AjaxAdapter ' + AjaxAdapter.VERSION + '. Install matching versions of both files (they share one wire format)');
};

/**
 * @param {string} version - A semver string.
 * @returns {string} The 'major.minor' prefix.
 */
AjaxAdapter.majorMinorOf = function(version) {
	return String(version).split('.').slice(0, 2).join('.');
};
