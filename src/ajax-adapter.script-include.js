/**
 * AjaxAdapter: factory that adapts a private method to the GlideAjax calling convention.
 * Client-side counterpart: AjaxProxy.
 *
 * Full documentation, install steps, and design notes: https://github.com/Eiluviann/sn-ajax-adapter
 */
var AjaxAdapter = Class.create();

/** Semver of this file. Bump on every change (see the repo's CHANGELOG.md). */
AjaxAdapter.VERSION = '1.0.0';

/**
 * Single carrier param for the JSON argument payload. Must match AjaxProxy. GlideAjax only
 * reserves its own sysparm_name / sysparm_processor, so this name is free to rebrand per app.
 */
AjaxAdapter.PAYLOAD_PARAM = 'sysparm_payload';

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
 * @param {string[]} parameterNames - Payload keys, in the positional order the private method expects them. A
 *   name absent from the payload arrives as undefined, so keep optional parameters last and guard them.
 * @returns {function(): string} Public method returning the stringified answer envelope.
 */
AjaxAdapter.expose = function(privateMethodName, parameterNames) {
	return function() {
		var processor = this;
		try {
			var privateMethod = processor[privateMethodName];
			if (typeof privateMethod !== 'function') {
				throw new Error('Private method "' + privateMethodName + '" does not exist on ' + processor.type);
			}
			var args = AjaxAdapter.readArguments(processor, parameterNames);
			var value = privateMethod.apply(processor, args);
			if (AjaxAdapter.isFailure(value)) {
				return AjaxAdapter.failureEnvelope(value);
			}
			// Faithful round-trip: undefined omits `result` (JSON.stringify drops it) and
			// the client reads it back as undefined. null is preserved. No undefined-to-null.
			return JSON.stringify({ ok: true, result: value });
		} catch (error) {
			if (AjaxAdapter.isFailure(error)) {
				return AjaxAdapter.failureEnvelope(error);
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
 */
AjaxAdapter.fail = function(message, options) {
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
 * Reads the positional arguments for a private method from the request.
 *
 * Every parameter arrives inside one JSON object under PAYLOAD_PARAM. getParameter()
 * returns a Java string under the Rhino engine. `new String()` moves it to the JS side
 * and the outer String() collapses the String *object* wrapper into a primitive before
 * JSON.parse. Values that come back out of JSON.parse are already JS primitives. A
 * number is a number, not '42', and needs no further wrapping.
 *
 * @param {*} processor - The AbstractAjaxProcessor instance handling the request.
 * @param {string[]} parameterNames - Payload keys in positional order.
 * @returns {Array<*>} Parsed arguments. An omitted key (or no payload at all) is undefined.
 * @throws {Error} Via AjaxAdapter.fail (kind 'badRequest') when the payload is present but not a JSON object.
 */
AjaxAdapter.readArguments = function(processor, parameterNames) {
	var names = parameterNames || [];
	var rawParam = processor.getParameter(AjaxAdapter.PAYLOAD_PARAM);
	// Coerce the Java string to a JS primitive BEFORE any comparison: a Java "" is not === '' in
	// Rhino, so testing the raw value would misclassify a genuinely empty payload as non-empty.
	var payloadRaw = (rawParam === null || rawParam === undefined) ? '' : String(new String(rawParam));

	// No payload (e.g. a method with no parameters): every argument is undefined.
	if (payloadRaw === '') {
		return names.map(function() {
			return undefined;
		});
	}

	var payload;
	try {
		payload = JSON.parse(payloadRaw);
	} catch (parseError) {
		throw AjaxAdapter.fail(AjaxAdapter.PAYLOAD_PARAM + ' is not valid JSON: ' + parseError.message, { kind: 'badRequest' });
	}
	if (payload === null || typeof payload !== 'object') {
		throw AjaxAdapter.fail(AjaxAdapter.PAYLOAD_PARAM + ' must be a JSON object', { kind: 'badRequest' });
	}
	return names.map(function(name) {
		// hasOwnProperty so a parameter named like an Object.prototype member ('constructor',
		// 'toString', …) resolves to undefined when absent, not to an inherited function.
		return Object.prototype.hasOwnProperty.call(payload, name) ? payload[name] : undefined;
	});
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
 */
AjaxAdapter.failureEnvelope = function(failure) {
	return JSON.stringify({
		ok: false,
		error: {
			kind: failure.kind || 'business',
			message: String(failure.message),
			details: failure.details,
		},
	});
};
