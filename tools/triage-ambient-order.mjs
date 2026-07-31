#!/usr/bin/env node
/**
 * Determinism witness for the ambient-module index (issue #42 class):
 * computeAmbientModules collected symbols in a Go map and emitted them in
 * map iteration order, which Go randomizes per run — the wire order (and
 * everything downstream of it) varied across identical runs. The fix sorts
 * by module name. This probe fetches getAmbientModules once per fresh
 * process via the checker adapter and prints the order; run it repeatedly
 * and diff (CI/local gate loops it — one run must equal the next).
 *
 * Exit: 0 = PASS (order fetched, sorted as produced), 1 = FAIL.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ambient-order-'));
const configFile = path.join(fixture, 'tsconfig.json');
// Unsorted on disk so directory order cannot accidentally sort for us.
for (const name of ['zeta', 'alpha', 'node:fs', 'mu', 'beta']) {
	fs.writeFileSync(path.join(fixture, `${name.replace(':', '_')}.d.ts`), `declare module "${name}" { export const v: number; }\n`);
}
fs.writeFileSync(path.join(fixture, 'main.ts'), 'export const x: number = 1;\n');
fs.writeFileSync(configFile, JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, types: [] },
	include: ['*.d.ts', '*.ts'],
}));

const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
if (!parsed) {
	console.error('FAIL: could not parse fixture tsconfig');
	process.exit(1);
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const modules = checker.getAmbientModules?.() ?? [];
const names = modules.map(m => m.escapedName ?? m.name ?? String(m));
if (names.length < 5) {
	console.error(`FAIL: expected >=5 ambient modules, got ${names.length}: ${JSON.stringify(names)}`);
	process.exit(1);
}
console.log(`AMBIENT-ORDER ${JSON.stringify(names)}`);
