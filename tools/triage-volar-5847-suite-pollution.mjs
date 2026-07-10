#!/usr/bin/env node
/**
 * Q3 form B: reproduce #5847 success=false under full-suite-like test order via vitest.
 * Runs component-meta + pug + completions.spec.ts tests before #5847, then #5847 alone.
 *
 * Usage: node tools/triage-volar-5847-suite-pollution.mjs
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const logPath = '/tmp/tnb-volar-5847-pollution.log';

function runVitest(extraArgs, label) {
	console.log(`\n=== ${label} ===`);
	console.log('cmd: npm test --', extraArgs.join(' '));
	const res = spawnSync(
		'npm',
		['test', '--', ...extraArgs],
		{
			cwd: volarRoot,
			encoding: 'utf8',
			env: process.env,
			timeout: 120_000,
		},
	);
	const out = (res.stdout ?? '') + (res.stderr ?? '');
	const summary = out.split('\n').filter(l =>
		/Tests\s+\d/.test(l) || /FAIL/.test(l) || /success=false/.test(l) || /#5847/.test(l),
	).join('\n');
	console.log(summary || out.slice(-2000));
	return { exitCode: res.status, out, summary };
}

// Step 1: run files that precede completions.spec.ts in full suite order
const preFiles = [
	'packages/component-meta/tests/index.spec.ts',
	'packages/language-plugin-pug/tests/baseParse.spec.ts',
];
const pre = runVitest(preFiles, 'pre-completions files (component-meta + pug)');

// Step 2: run completions tests BEFORE #5847 (exclude #5847 and #6110 by running named tests)
const pre5847Tests = [
	'packages/language-server/tests/completions.spec.ts',
	'-t',
	'Vue tags|#4670|HTML tags|Auto import|Boolean props|Directives|Directive modifiers|$event|<script setup>|Slot name|#2454|#3658|#4639|Alias path|Relative path|core#8811|#4796|Auto insert defines',
];
const pre5847 = runVitest(pre5847Tests, 'completions pre-#5847 subset');

// Step 3: run #5847 in same vitest process — vitest isolate:false keeps module state,
// but each npm test spawns fresh process. Instead run single npm test with ordered tests.
const combined = runVitest([
	...preFiles,
	'packages/language-server/tests/completions.spec.ts',
	'-t',
	'#5847',
], 'combined: pre files + completions #5847 only');

// Step 4: full completions.spec.ts for reference
const fullCompletions = runVitest([
	'packages/language-server/tests/completions.spec.ts',
], 'full completions.spec.ts');

const report = {
	preFiles: { exitCode: pre.exitCode, summary: pre.summary },
	pre5847: { exitCode: pre5847.exitCode, summary: pre5847.summary },
	combined: { exitCode: combined.exitCode, summary: combined.summary },
	fullCompletions: { exitCode: fullCompletions.exitCode, summary: fullCompletions.summary },
};
import * as fs from 'node:fs';
fs.writeFileSync(logPath, [
	pre.out,
	pre5847.out,
	combined.out,
	fullCompletions.out,
].join('\n\n===== SEPARATOR =====\n\n'));
fs.writeFileSync('/tmp/tnb-volar-5847-pollution-summary.json', JSON.stringify(report, null, 2));
console.log('\n=== summary written ===');
console.log(JSON.stringify(report, null, 2));
console.log('full log:', logPath);
