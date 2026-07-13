/**
 * AjaxProxy: client-side remote proxy for AjaxAdapter script includes.
 * Server-side counterpart: AjaxAdapter.
 *
 * Full documentation, install steps, and design notes: https://github.com/Eiluviann/sn-ajax-adapter
 */
var AjaxProxy = (function() {

	/** Single carrier param for the JSON argument payload. Must match AjaxAdapter.PAYLOAD_PARAM. */
	var PAYLOAD_PARAM = 'sysparm_payload';

	/** Discriminators on a rejected call's Error.kind. Branch on these, not on messages. */
	var ErrorKind = {
		SERVER: 'server', // unexpected server bug, carries a `reference` for the server log
		BUSINESS: 'business', // expected, developer-authored failure (AjaxAdapter.fail), safe to show
		BAD_REQUEST: 'badRequest', // the server could not read the request (malformed payload)
		TIMEOUT: 'timeout', // no answer within the timeout window
		EMPTY: 'empty', // empty answer: client_callable flag, ACL, unknown method, or session timeout
		MALFORMED: 'malformed', // answer was not the AjaxAdapter envelope
	};

	/** @type {number} Milliseconds before a call rejects with ErrorKind.TIMEOUT. */
	var defaultTimeoutMs = 60000;

	/** @type {string} Table the correlation reference deep-links into. Set 'syslog_app_scope' for a scoped adapter. */
	var logTable = 'syslog';

	/** @type {function(Error): void} Global fallback error handler. Replace via setErrorHandler. */
	var globalErrorHandler = function(error) {
		if (typeof console === 'undefined' || typeof console.error !== 'function') {
			return;
		}
		var link = logUrl(error);
		console.error('[AjaxProxy] ' + error.message + (link ? '\nLog: ' + link : ''));
	};

	/**
	 * Calls one public method on an AjaxAdapter script include.
	 *
	 * @param {string} scriptIncludeName - e.g. 'UserLookupAjax' (add the scope prefix for scoped includes).
	 * @param {string} publicMethodName - e.g. 'getUserSummary'.
	 * @param {Object<string, *>} [parameters] - Sent as one JSON payload (sysparm_payload). Because the whole
	 *   object is JSON-stringified, every value keeps its exact type on the server. A number stays a number,
	 *   never '42'. An undefined value (or an omitted key) sends nothing and the private method receives
	 *   undefined. null is sent and received as null.
	 * @param {{ onSuccess?: function(*): void, onError?: function(Error): void, onComplete?: function(): void, timeout?: number, retry?: boolean|number|{ attempts?: number, delay?: number, on?: string[] } }} [options]
	 *   Passing any handler selects callback style. Omitting them all is promise style. onError (when provided)
	 *   replaces the global handler for this call. timeout overrides the default for this call. retry controls
	 *   automatic re-attempts, OFF by default. Opt in with retry: true (retry a transient ErrorKind.TIMEOUT
	 *   once with backoff), a number for total attempts, or { attempts, delay, on } to tune which kinds retry.
	 *   Retry re-sends the same payload, so only enable it for idempotent (read) methods (see header).
	 * @returns {Promise<*>} Resolves with the private method's return value. Rejects with a typed Error (see ErrorKind).
	 * @throws {Error} When a provided handler is not a function (caller bug).
	 */
	function call(scriptIncludeName, publicMethodName, parameters, options) {
		var opts = options || {};
		assertHandler(opts.onSuccess, 'onSuccess');
		assertHandler(opts.onError, 'onError');
		assertHandler(opts.onComplete, 'onComplete');

		var timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : defaultTimeoutMs;
		var promise = invokeWithRetry(scriptIncludeName, publicMethodName, parameters, timeoutMs, normalizeRetry(opts.retry));

		var hasCallback = Boolean(opts.onSuccess || opts.onError || opts.onComplete);

		// Promise style (no callbacks): hand back the raw promise untouched. The caller owns
		// the outcome through .then/.catch. An ignored rejection surfaces once via the browser's
		// native unhandled-rejection warning. We attach no logger, so a caller that added .catch
		// never sees a duplicate console entry.
		if (!hasCallback) {
			return promise;
		}

		// Callback style: drive the handlers on an internal branch. The error sink is the per-call
		// onError when provided, otherwise the global handler, so a failure is never silently
		// swallowed. When onError IS provided the global handler never runs. A throw inside a user
		// callback is caught and logged (its own bug surfacing), never lost. onComplete always runs.
		var errorSink = typeof opts.onError === 'function' ? opts.onError : globalErrorHandler;
		promise
			.then(
				function(result) {
					if (typeof opts.onSuccess === 'function') {
						opts.onSuccess(result);
					}
				},
				function(error) {
					errorSink(error);
				},
			)
			.catch(function(callbackError) {
				globalErrorHandler(callbackError);
			})
			.then(function() {
				if (typeof opts.onComplete === 'function') {
					opts.onComplete();
				}
			});

		return promise;
	}

	/**
	 * Binds call() to one script include, with optional per-proxy defaults.
	 *
	 * @example
	 *   var userLookup = AjaxProxy.for('UserLookupAjax', { onError: showToast, timeout: 15000 });
	 *   userLookup('getUserSummary', { userId: g_form.getUniqueValue() }).then(render);
	 *
	 * @param {string} scriptIncludeName - The script include every returned call targets.
	 * @param {{ onSuccess?: function(*): void, onError?: function(Error): void, onComplete?: function(): void, timeout?: number, retry?: boolean|number|Object }} [defaults]
	 *   Any option call() accepts. Merged under each call's own options, which win per field, so a
	 *   proxy-wide onError/timeout/retry applies unless a specific call overrides it.
	 * @returns {function(string, Object<string, *>=, Object=): Promise<*>} (publicMethodName, parameters, options) => Promise.
	 */
	function forScriptInclude(scriptIncludeName, defaults) {
		var baseDefaults = defaults || {};
		return function(publicMethodName, parameters, options) {
			return call(scriptIncludeName, publicMethodName, parameters, mergeOptions(baseDefaults, options));
		};
	}

	/**
	 * Opt-in layer for rapid-fire calls (type-ahead, live search): debounce and/or drop stale
	 * responses. Returns a call function bound to one method. A superseded call is ABANDONED. Its
	 * promise silently never settles (like RxJS switchMap), so `search(q).then(render)` renders only
	 * the latest and stale keystrokes quietly do nothing. Consequence of never settling: a stale
	 * call's .finally()/.then() never runs, so don't hang cleanup you always need off a channel call.
	 * Nothing here touches call()/for(). Reach for it only when you want it, and keep using your own
	 * debouncing if you already have it.
	 *
	 * @example
	 *   var search = AjaxProxy.channel('UserLookupAjax', 'searchUsers', { debounce: 250 });
	 *   input.addEventListener('input', function() { search({ query: input.value }).then(render); });
	 *
	 * @param {string} scriptIncludeName
	 * @param {string} publicMethodName
	 * @param {{ debounce?: number, latest?: boolean, timeout?: number, retry?: * }} [channelOptions]
	 *   debounce waits that many ms of quiet before firing. latest (default true) drops out-of-order
	 *   responses. timeout/retry pass through to each underlying call.
	 * @returns {function(Object<string, *>=): Promise<*>} (parameters) => Promise for the latest call only.
	 */
	function channel(scriptIncludeName, publicMethodName, channelOptions) {
		var settings = channelOptions || {};
		var debounceMs = typeof settings.debounce === 'number' ? settings.debounce : 0;
		var dropStale = settings.latest !== false;
		var callOptions = { timeout: settings.timeout, retry: settings.retry };
		var seq = 0;
		var latestSeq = 0;
		var debounceTimer;

		return function(parameters) {
			seq += 1;
			var mySeq = seq;
			latestSeq = mySeq;
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			return new Promise(function(resolve, reject) {
				function fire() {
					debounceTimer = undefined;
					call(scriptIncludeName, publicMethodName, parameters, callOptions).then(
						function(result) {
							// Abandon superseded responses: only the newest call settles.
							if (!dropStale || mySeq === latestSeq) {
								resolve(result);
							}
						},
						function(error) {
							if (!dropStale || mySeq === latestSeq) {
								reject(error);
							}
						},
					);
				}
				if (debounceMs > 0) {
					debounceTimer = setTimeout(fire, debounceMs);
				} else {
					fire();
				}
			});
		};
	}

	/**
	 * Replaces the global handler used as the error sink for callback-style calls that omit onError.
	 * Promise-style calls own their errors through .catch and are unaffected by this.
	 *
	 * @param {function(Error): void} handler
	 * @throws {Error} When handler is not a function (caller bug).
	 */
	function setErrorHandler(handler) {
		if (typeof handler !== 'function') {
			throw new Error('AjaxProxy.setErrorHandler requires a function');
		}
		globalErrorHandler = handler;
	}

	/**
	 * Sets the default per-call timeout in milliseconds.
	 *
	 * @param {number} milliseconds - Must be a positive number.
	 * @throws {Error} When milliseconds is not a positive number (caller bug).
	 */
	function setDefaultTimeout(milliseconds) {
		if (typeof milliseconds !== 'number' || !(milliseconds > 0)) {
			throw new Error('AjaxProxy.setDefaultTimeout requires a positive number of milliseconds');
		}
		defaultTimeoutMs = milliseconds;
	}

	/**
	 * Sets the table the server correlation reference deep-links into (default 'syslog').
	 * Point this at 'syslog_app_scope' when the adapter runs inside a scoped application.
	 *
	 * @param {string} tableName
	 * @throws {Error} When tableName is not a non-empty string (caller bug).
	 */
	function setLogTable(tableName) {
		if (typeof tableName !== 'string' || tableName === '') {
			throw new Error('AjaxProxy.setLogTable requires a non-empty table name');
		}
		logTable = tableName;
	}

	/**
	 * Fires the GlideAjax transport and resolves/rejects with the unwrapped envelope.
	 * A single settle guard makes the timeout and the answer callback mutually exclusive.
	 *
	 * @param {string} scriptIncludeName
	 * @param {string} publicMethodName
	 * @param {Object<string, *>} [parameters]
	 * @param {number} timeoutMs
	 * @returns {Promise<*>}
	 */
	function invoke(scriptIncludeName, publicMethodName, parameters, timeoutMs) {
		return new Promise(function(resolve, reject) {
			var lbl = scriptIncludeName + '.' + publicMethodName;

			// Guard serialization up front: a circular / non-serializable parameter is the
			// caller's bug, so fail fast with a typed badRequest rather than waiting for the
			// server to reject a payload it never received.
			var payloadJson;
			try {
				payloadJson = JSON.stringify(parameters || {});
			} catch (serializeError) {
				reject(ajaxError(ErrorKind.BAD_REQUEST, lbl + ' has non-serializable parameters: ' + serializeError.message, {
					scriptInclude: scriptIncludeName,
					method: publicMethodName,
				}));
				return;
			}

			var settled = false;
			var timer;
			function settle(action, argument) {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				action(argument);
			}

			// Build the transport first, then arm the timer: if the constructor ever throws, no
			// stray timer is left running (the Promise executor rejects with that error).
			var ajax = new GlideAjax(scriptIncludeName);
			ajax.addParam('sysparm_name', publicMethodName);
			ajax.addParam(PAYLOAD_PARAM, payloadJson);

			timer = setTimeout(function() {
				settle(reject, ajaxError(ErrorKind.TIMEOUT, lbl + ' timed out after ' + timeoutMs + 'ms', {
					scriptInclude: scriptIncludeName,
					method: publicMethodName,
				}));
			}, timeoutMs);

			ajax.getXMLAnswer(function(answer) {
				if (answer === null || answer === undefined || answer === '') {
					settle(reject, ajaxError(ErrorKind.EMPTY, lbl + ' returned no answer (possible causes: client_callable flag, ACL, unknown method name, or session timeout)', {
						scriptInclude: scriptIncludeName,
						method: publicMethodName,
					}));
					return;
				}
				var envelope;
				try {
					envelope = JSON.parse(answer);
				} catch (parseError) {
					settle(reject, ajaxError(ErrorKind.MALFORMED, lbl + ' returned a non-JSON answer: ' + parseError.message, {
						scriptInclude: scriptIncludeName,
						method: publicMethodName,
					}));
					return;
				}
				// Require a boolean `ok`, so a parseable-but-foreign JSON object (a script include that
				// isn't AjaxAdapter-based) is reported as malformed rather than a fabricated 'server' error.
				if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
					settle(reject, ajaxError(ErrorKind.MALFORMED, lbl + ' returned an unrecognized answer shape', {
						scriptInclude: scriptIncludeName,
						method: publicMethodName,
					}));
					return;
				}
				if (envelope.ok === true) {
					settle(resolve, envelope.result);
					return;
				}
				var serverError = envelope.error || {};
				settle(reject, ajaxError(serverError.kind || ErrorKind.SERVER, serverError.message || 'unknown server error', {
					scriptInclude: scriptIncludeName,
					method: serverError.method || publicMethodName,
					reference: serverError.reference,
					details: serverError.details,
				}));
			});
		});
	}

	/**
	 * Runs invoke() and re-attempts on a retryable failure with exponential backoff.
	 * Transparent to the caller: same resolve/reject contract, just resilient.
	 *
	 * @param {string} scriptIncludeName
	 * @param {string} publicMethodName
	 * @param {Object<string, *>} [parameters]
	 * @param {number} timeoutMs
	 * @param {{ attempts: number, delay: number, on: string[] }} retry
	 * @returns {Promise<*>}
	 */
	function invokeWithRetry(scriptIncludeName, publicMethodName, parameters, timeoutMs, retry) {
		var attempt = 0;
		function run() {
			return invoke(scriptIncludeName, publicMethodName, parameters, timeoutMs).then(null, function(error) {
				attempt += 1;
				var canRetry = attempt < retry.attempts && retry.on.indexOf(error.kind) !== -1;
				if (!canRetry) {
					throw error;
				}
				return delay(retry.delay * Math.pow(2, attempt - 1)).then(run);
			});
		}
		return run();
	}

	/**
	 * Normalizes the `retry` option into { attempts, delay, on }. Retry is OFF by default. Opt in
	 * with retry: true (retry a transient timeout once), a number (total attempts), or an object
	 * (tune each field). undefined/false/0 disable it.
	 *
	 * @param {boolean|number|{ attempts?: number, delay?: number, on?: string[] }} [retry]
	 * @returns {{ attempts: number, delay: number, on: string[] }}
	 */
	function normalizeRetry(retry) {
		var off = { attempts: 1, delay: 0, on: [] };
		var on = { attempts: 2, delay: 500, on: [ErrorKind.TIMEOUT] };
		if (retry === undefined || retry === false || retry === 0) {
			return off;
		}
		if (retry === true) {
			return on;
		}
		if (typeof retry === 'number') {
			return { attempts: Math.max(1, retry), delay: on.delay, on: on.on };
		}
		return {
			attempts: typeof retry.attempts === 'number' ? Math.max(1, retry.attempts) : on.attempts,
			delay: typeof retry.delay === 'number' ? retry.delay : on.delay,
			on: Array.isArray(retry.on) ? retry.on : on.on,
		};
	}

	/**
	 * @param {number} ms
	 * @returns {Promise<void>} Resolves after ms milliseconds (immediately when ms <= 0).
	 */
	function delay(ms) {
		return new Promise(function(resolve) {
			if (ms > 0) {
				setTimeout(resolve, ms);
			} else {
				resolve();
			}
		});
	}

	/**
	 * Deep-links to the server log row for a server error's correlation reference, so a developer
	 * clicks straight from the console to the exact entry (message STARTSWITH <reference>). No data
	 * leaks: the URL only opens for users whose roles grant access to the log table.
	 *
	 * @param {Error|string} [referenceOrError] - A server error (uses its .reference) or a raw reference.
	 * @returns {string|undefined} The filtered list URL, or undefined when there is no reference.
	 */
	function logUrl(referenceOrError) {
		var reference = typeof referenceOrError === 'string' ? referenceOrError : (referenceOrError && referenceOrError.reference);
		if (!reference) {
			return undefined;
		}
		var origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
		return origin + '/' + logTable + '_list.do?sysparm_query=' + encodeURIComponent('messageSTARTSWITH' + reference);
	}

	/**
	 * Builds a typed rejection Error. undefined extras are simply not attached.
	 *
	 * @param {string} kind - One of ErrorKind.
	 * @param {string} message
	 * @param {{ scriptInclude?: string, method?: string, reference?: string, details?: * }} [extra]
	 * @returns {Error}
	 */
	function ajaxError(kind, message, extra) {
		var error = new Error(message);
		error.name = 'AjaxProxyError';
		error.kind = kind;
		var info = extra || {};
		if (info.scriptInclude !== undefined) {
			error.scriptInclude = info.scriptInclude;
		}
		if (info.method !== undefined) {
			error.method = info.method;
		}
		if (info.reference !== undefined) {
			error.reference = info.reference;
		}
		if (info.details !== undefined) {
			error.details = info.details;
		}
		return error;
	}

	/**
	 * @param {*} value
	 * @param {string} name - Handler name, for the error message.
	 * @throws {Error} When value is defined but not a function.
	 */
	function assertHandler(value, name) {
		if (value !== undefined && typeof value !== 'function') {
			throw new Error('AjaxProxy: ' + name + ' must be a function');
		}
	}

	/**
	 * @param {Object} base - Per-proxy defaults.
	 * @param {Object} [override] - Per-call options. Each present field wins.
	 * @returns {Object}
	 */
	function mergeOptions(base, override) {
		var over = override || {};
		return {
			onSuccess: over.onSuccess !== undefined ? over.onSuccess : base.onSuccess,
			onError: over.onError !== undefined ? over.onError : base.onError,
			onComplete: over.onComplete !== undefined ? over.onComplete : base.onComplete,
			timeout: over.timeout !== undefined ? over.timeout : base.timeout,
			retry: over.retry !== undefined ? over.retry : base.retry,
		};
	}

	return {
		call: call,
		for: forScriptInclude,
		channel: channel,
		setErrorHandler: setErrorHandler,
		setDefaultTimeout: setDefaultTimeout,
		setLogTable: setLogTable,
		logUrl: logUrl,
		ErrorKind: ErrorKind,
	};
})();
