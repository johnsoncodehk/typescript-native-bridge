#!/usr/bin/env node
/**
 * Determinism witnesses for whole-program diagnostics grouping.
 *
 * Scenario "stride5" — issue #51 (residual of #42): the whole-program
 * diagnostics stride pass released each group's checker at group end, and
 * the pool prefers an existing idle slot — so a fast group plus a goroutine
 * startup skew let one warm checker serve two groups. Checker-local lazy
 * state (`interfaceChecked` on merged globals) then carried across groups:
 * the second group's first `interface Window` augmentation saw the gate
 * already set and its TS2430 blame site was silently dropped (~1/300 fresh
 * runs; 1 of 2 sites here, 3 of 4 on the original #42 fixture). The fix
 * defers all group releases until after `wg.RunAndWait()`, so no slot goes
 * idle mid-pass and group↔slot pairing is 1:1 by construction. 5 checkable
 * files puts the two `Window`-declaring files in different stride groups.
 * 4 runs at natural scheduling + 12 with GOMAXPROCS=1 in the spawn env —
 * serializing the group goroutines opens the release-before-lease window on
 * nearly every pre-fix run, so teeth do not depend on winning a ~1/300
 * scheduling race.
 *
 * Scenario "small2" — small-program parity: programs with at most 4
 * checkable files used to take a dedicated single-checker path, which
 * resolves the merged `Window` heritage once per pass and reports TS2430 at
 * only one of the two augmentation sites — deterministic but wrong: stock
 * tsc and pristine tsgo CLI both report both sites (the internal compiler
 * pool sizes itself to min(4, files) checkers and strides files across
 * them). The dedicated path is gone; the stride pass degenerates to one
 * group per file below the group count, matching the internal pool's
 * grouping at every program size.
 *
 * Both scenarios run `lib/_tsc.js --noEmit` on a self-contained fixture in
 * fresh processes and require byte-identical error output containing
 * exactly both expected TS2430 sites — the surviving-site mode varies
 * (either augmentation can be the one dropped), so a bare count would not
 * catch a stably-wrong output.
 *
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATURAL_RUNS = 4;
const FORCED_RUNS = 12; // with GOMAXPROCS=1
const RUNS = NATURAL_RUNS + FORCED_RUNS;

const WINDOW_FILES = {
	'a-base.ts':
		`interface GTM { dataLayer: string }
declare global {
	interface Window extends GTM {}
}
export {};
`,
	'b-conflict.ts':
		`declare global {
	interface Window { dataLayer: number }
}
export {};
`,
};
const EXPECTED_SITES = [
	`a-base.ts(3,12): error TS2430: Interface 'Window' incorrectly extends interface 'GTM'.`,
	`b-conflict.ts(2,12): error TS2430: Interface 'Window' incorrectly extends interface 'GTM'.`,
];

function runScenario(name, padNames) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tnb-diag-determinism-${name}-`));
	for (const [fileName, content] of Object.entries(WINDOW_FILES)) {
		fs.writeFileSync(path.join(dir, fileName), content);
	}
	for (const n of padNames) {
		fs.writeFileSync(path.join(dir, `${n}-pad.ts`), `export const x${n}: number = 1;\n`);
	}
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', types: [] },
		include: ['**/*.ts'],
	}));

	const outputs = new Map();
	for (let i = 0; i < RUNS; i++) {
		const r = spawnSync(process.execPath, [path.join(repoRoot, 'lib', '_tsc.js'), '--noEmit', '-p', 'tsconfig.json'], {
			cwd: dir,
			encoding: 'utf8',
			env: i < NATURAL_RUNS ? process.env : { ...process.env, GOMAXPROCS: '1' },
		});
		if (r.error) {
			console.error(`FAIL[${name}]: run ${i} spawn error: ${r.error.message}`);
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
		console.error(`FAIL[${name}]: ${outputs.size} distinct diagnostic outputs over ${RUNS} identical runs`);
		for (const [body, count] of outputs) {
			console.error(`── ${count}× output:\n${body}`);
		}
		process.exit(1);
	}
	const body = [...outputs.keys()][0];
	const bodyLines = body.split('\n');
	const ts2430Sites = bodyLines.filter(l => l.includes('TS2430')).length;
	const missing = EXPECTED_SITES.filter(l => !bodyLines.includes(l));
	if (missing.length > 0 || ts2430Sites !== EXPECTED_SITES.length) {
		console.error(`FAIL[${name}]: expected exactly these ${EXPECTED_SITES.length} TS2430 sites:\n${EXPECTED_SITES.join('\n')}\n── got (${ts2430Sites} sites):\n${body}`);
		process.exit(1);
	}
	console.log(`PASS[${name}]: byte-identical diagnostics over ${RUNS} fresh runs (${NATURAL_RUNS} natural + ${FORCED_RUNS} GOMAXPROCS=1, ${ts2430Sites} TS2430 sites)`);
}

runScenario('stride5', ['c', 'd', 'e']);
runScenario('small2', []);
