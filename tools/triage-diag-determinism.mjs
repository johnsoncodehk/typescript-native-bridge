#!/usr/bin/env node
/**
 * Determinism witness for issue #42: the session's whole-program
 * diagnostics pass distributed files to checker-pool slots by goroutine
 * queue pickup, so checker-local lazy state (merged global heritage
 * resolution, report dedup) varied run to run — TS2430 blame landed on a
 * varying subset of `interface Window` augmentation sites across identical
 * programs (2–4 of ~8 sites over 30 runs pre-fix; one run even reported
 * none). The fix assigns files to checker groups by index stride, mirroring
 * the compiler pool's fileAssociations — output is now byte-identical
 * across runs and content-identical to plain tsgo on this fixture.
 *
 * Runs `lib/_tsc.js --noEmit` on a self-contained fixture in fresh
 * processes and requires byte-identical error output.
 *
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 20;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-diag-determinism-'));
fs.mkdirSync(path.join(dir, 'node_modules', '@nuxt', 'scripts', 'dist'), { recursive: true });
fs.mkdirSync(path.join(dir, 'declarations'));
fs.mkdirSync(path.join(dir, 'composables'));

fs.writeFileSync(path.join(dir, 'node_modules', '@nuxt', 'scripts', 'package.json'),
	JSON.stringify({ name: '@nuxt/scripts', version: '0.0.0', types: './dist/index.d.ts' }));
fs.writeFileSync(path.join(dir, 'node_modules', '@nuxt', 'scripts', 'dist', 'index.d.ts'),
	`interface DataLayerPush { (...args: unknown[]): void }
interface DataLayer extends Array<unknown> {}
export interface GoogleTagManagerApi { dataLayer: DataLayer & { push: DataLayerPush } }
declare global {
	interface Window extends GoogleTagManagerApi {}
}
export {};
`);
fs.writeFileSync(path.join(dir, 'declarations', 'global.ts'),
	`interface FirstPartyGtm { gtm: { start: number } }
declare global {
	interface Window extends FirstPartyGtm {
		firstParty: string;
	}
}
export {};
`);
fs.writeFileSync(path.join(dir, 'composables', 'useRiskSession.ts'),
	`interface RiskSessionApi { risk: { session: string } }
declare global {
	interface Window extends RiskSessionApi {}
}
export function useRiskSession(): string { return window.risk.session; }
`);
for (const n of ['a', 'b', 'c', 'd']) {
	fs.writeFileSync(path.join(dir, 'declarations', `more-${n}.ts`),
		`declare global {\n\tinterface Window { extra${n}: number }\n}\nexport {};\n`);
}
fs.writeFileSync(path.join(dir, 'declarations', 'conflict.ts'),
	`declare global {\n\tinterface Window { dataLayer: string[] }\n}\nexport {};\n`);
fs.writeFileSync(path.join(dir, 'main.ts'), `import '@nuxt/scripts';\nexport const x: number = 1;\n`);
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', types: [] },
	include: ['**/*.ts'],
}));

const outputs = new Map();
for (let i = 0; i < RUNS; i++) {
	const r = spawnSync(process.execPath, [path.join(repoRoot, 'lib', '_tsc.js'), '--noEmit', '-p', 'tsconfig.json'], {
		cwd: dir,
		encoding: 'utf8',
	});
	if (r.error) {
		console.error(`FAIL: run ${i} spawn error: ${r.error.message}`);
		process.exit(1);
	}
	// Normalize the machine-local fixture prefix; keep per-line order.
	const body = (r.stdout + r.stderr)
		.split('\n')
		.filter(l => l.includes('error TS'))
		.map(l => l.replace(dir, '<fixture>'))
		.join('\n');
	outputs.set(body, (outputs.get(body) ?? 0) + 1);
}

if (outputs.size !== 1) {
	console.error(`FAIL: ${outputs.size} distinct diagnostic outputs over ${RUNS} identical runs`);
	for (const [body, count] of outputs) {
		console.error(`── ${count}× output:\n${body}`);
	}
	process.exit(1);
}
const body = [...outputs.keys()][0];
const ts2430Sites = body.split('\n').filter(l => l.includes('TS2430')).length;
if (ts2430Sites === 0) {
	console.error('FAIL: fixture lost its TS2430s — witness no longer exercises the class');
	process.exit(1);
}
console.log(`PASS: byte-identical diagnostics over ${RUNS} fresh runs (${ts2430Sites} TS2430 sites)`);
