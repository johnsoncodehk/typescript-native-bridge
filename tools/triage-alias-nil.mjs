#!/usr/bin/env node
/**
 * getImmediateAliasedSymbol on the synthetic `default` alias of a CommonJS
 * module must come back null, not panic natively (issue #18). Drives the raw
 * bridge session directly: the JS adapter's declarations guard (correctly)
 * prevents this RPC in production, so only a raw probe covers the Go path —
 * a panic here aborts the process and fails the gate.
 *
 * Usage: node tools/triage-alias-nil.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const addon = require2(path.join(repoRoot, 'native', 'bridge.node'));
process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');

// ── Fixture (issue #18 repro shape) ──────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-alias-nil-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', esModuleInterop: true, noEmit: true },
	include: ['src.ts', 'dep.cts'],
}));
const srcText = `import * as m from './dep.cjs';\nm.default;\n`;
fs.writeFileSync(path.join(dir, 'src.ts'), srcText);
fs.writeFileSync(path.join(dir, 'dep.cts'), `export = {};\n`);

// ── Session (JSON transport) ─────────────────────────────────────────────
const h = addon.newSession(dir);
if (!h) { console.error('newSession failed'); process.exit(1); }
const H = BigInt(h);
const call = (method, params) => {
	const r = addon.call(H, method, params == null ? null : JSON.stringify(params));
	return typeof r === 'string' ? JSON.parse(r) : r;
};
call('initialize', null);
const snap = call('updateSnapshot', { openProjects: [path.join(dir, 'tsconfig.json')] });
const snapshot = snap.snapshot ?? snap.id;
const project = (snap.projects ?? [])[0]?.id;
if (snapshot == null || !project) { console.error('updateSnapshot: no snapshot/project'); process.exit(1); }

const srcTs = path.join(dir, 'src.ts');
const sym = call('getSymbolAtPosition', { snapshot, project, file: srcTs, position: srcText.indexOf('default') });
if (!sym || sym.name !== 'default') {
	console.error(`FAIL: no 'default' alias symbol at m.default (got ${JSON.stringify(sym)})`);
	process.exit(1);
}
// Pre-fix this call panicked natively ("Unexpected nil in
// getImmediateAliasedSymbol") — the process never returns. Stock TS resolves
// no target for a declaration-less synthetic alias and answers undefined.
const aliased = call('getImmediateAliasedSymbol', { snapshot, project, symbol: sym.id });
if (aliased !== null && aliased !== undefined) {
	console.error(`FAIL: expected null for targetless synthetic alias, got ${JSON.stringify(aliased)}`);
	process.exit(1);
}
console.log('ok getImmediateAliasedSymbol returns null on synthetic CJS default alias');
