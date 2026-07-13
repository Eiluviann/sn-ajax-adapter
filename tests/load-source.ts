import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Evaluates one of the ES5 platform scripts with the given stand-ins for ServiceNow globals
 * (GlideAjax, gs, Class, ...) injected as scoped bindings, and returns the value of
 * resultExpression — the top-level `var` the script declares.
 *
 * The sources are plain global scripts, not modules, so this is the seam that lets Vitest
 * exercise them without a ServiceNow instance.
 *
 * @param relativePath - Script path relative to the repo root.
 * @param globals - Name-to-value map of the platform globals the script expects.
 * @param resultExpression - Expression evaluated after the script body, e.g. 'AjaxProxy'.
 * @returns The evaluated expression; callers narrow it to their typed test surface.
 */
export function evaluateGlobalScript(
	relativePath: string,
	globals: Record<string, unknown>,
	resultExpression: string,
): unknown {
	const source = readFileSync(join(repoRoot, relativePath), 'utf8');
	const parameterNames = Object.keys(globals);
	const parameterValues = parameterNames.map((name) => globals[name]);
	const factory = new Function(...parameterNames, `${source}\n;return ${resultExpression};`);
	return factory(...parameterValues);
}
