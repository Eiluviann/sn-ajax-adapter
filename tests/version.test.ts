import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version consistency', () => {
	it('both src files and package.json carry the same semver, per the CHANGELOG rule', () => {
		const adapterVersion = extractVersion('src/ajax-adapter.script-include.js', /AjaxAdapter\.VERSION = '([^']+)'/);
		const proxyVersion = extractVersion('src/ajax-proxy.ui-script.js', /var VERSION = '([^']+)'/);
		const packageJson: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		const packageVersion = typeof packageJson === 'object' && packageJson !== null && 'version' in packageJson
			? packageJson.version
			: undefined;

		expect(adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(proxyVersion).toBe(adapterVersion);
		expect(packageVersion).toBe(adapterVersion);
	});

	it('the CHANGELOG documents the shipped version', () => {
		const adapterVersion = extractVersion('src/ajax-adapter.script-include.js', /AjaxAdapter\.VERSION = '([^']+)'/);
		const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');

		expect(changelog).toContain(`## [${adapterVersion}]`);
	});
});

function extractVersion(relativePath: string, pattern: RegExp): string {
	const source = readFileSync(join(repoRoot, relativePath), 'utf8');
	const version = pattern.exec(source)?.[1];
	if (version === undefined) {
		throw new Error(`no VERSION found in ${relativePath}`);
	}
	return version;
}
