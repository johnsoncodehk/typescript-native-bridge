#!/usr/bin/env node
/**
 * Parse vitest full-suite log(s) into failure table rows.
 * Usage:
 *   node tools/triage-volar-suite-parse.mjs /tmp/tnb-volar-suite-run1.log [/tmp/tnb-volar-suite-run2.log]
 */
import * as fs from 'node:fs';

const ALLOWLIST = {
	'component-meta/reference-type-model > barModifiers w/ tsconfig': 'component-meta-1',
	'component-meta/reference-type-model > barModifiers w/o tsconfig': 'component-meta-2',
	'component-meta/reference-type-props > nestedOptional w/ tsconfig': 'component-meta-3',
	'component-meta/reference-type-props > nestedOptional w/o tsconfig': 'component-meta-4',
	'renaming/CSS': 'rename-1',
	'renaming/Same Name Shorthand': 'rename-2',
	'vue-tsc': 'vue-tsc-1',
};

function parseLog(text) {
	const lines = text.split('\n');
	const results = new Map();
	let currentSpec = null;
	let summary = null;

	for (const line of lines) {
		const failSpec = line.match(/^ FAIL\s+(.+?)\s+>\s+(.+)$/);
		if (failSpec) {
			const spec = failSpec[1].trim();
			const test = failSpec[2].trim();
			const key = `${spec} > ${test}`;
			results.set(key, { spec, test, status: 'FAIL', failType: 'unknown' });
			currentSpec = key;
			continue;
		}

		const failFile = line.match(/^ FAIL\s+(.+\.spec\.[tj]s)\s/);
		if (failFile && !line.includes(' > ')) {
			const spec = failFile[1].trim();
			results.set(spec, { spec, test: '(file-level)', status: 'FAIL', failType: 'crash' });
			currentSpec = spec;
			continue;
		}

		if (line.includes('Error: Test timed out') || line.includes('Exceeded timeout')) {
			if (currentSpec && results.has(currentSpec)) {
				results.get(currentSpec).failType = 'timeout';
			}
		}
		if (line.includes('Snapshot') || line.includes('toMatchInlineSnapshot')) {
			if (currentSpec && results.has(currentSpec)) {
				const r = results.get(currentSpec);
				if (r.failType === 'unknown') r.failType = 'snapshot';
			}
		}
		if (line.includes('AssertionError') || line.includes('expected') && line.includes('to')) {
			if (currentSpec && results.has(currentSpec)) {
				const r = results.get(currentSpec);
				if (r.failType === 'unknown') r.failType = 'assert diff';
			}
		}

		const sum = line.match(
			/Tests\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?/,
		);
		if (sum) {
			summary = {
				failed: Number(sum[1]),
				passed: Number(sum[2]),
				skipped: Number(sum[3] ?? 0),
			};
		}
		const fileSum = line.match(
			/Test Files\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?/,
		);
		if (fileSum) {
			summary = {
				...(summary ?? {}),
				filesFailed: Number(fileSum[1]),
				filesPassed: Number(fileSum[2]),
				filesSkipped: Number(fileSum[3] ?? 0),
				raw: line.trim(),
			};
		}
	}

	return { results, summary };
}

function classifyAllowlist(spec, test) {
	const key = `${spec} > ${test}`;
	if (spec.includes('component-meta') && test === 'reference-type-model') {
		return 'component-meta (barModifiers order)';
	}
	if (spec.includes('component-meta') && test === 'reference-type-props') {
		return 'component-meta (nestedOptional order)';
	}
	if (spec.includes('renaming.spec') && test === 'CSS') return 'rename-1 (CSS order)';
	if (spec.includes('renaming.spec') && test === 'Same Name Shorthand') return 'rename-2 (Same Name Shorthand order)';
	if (spec.includes('typecheck.spec') && test === 'vue-tsc') return 'vue-tsc-1';
	if (spec.includes('index.spec') && test.includes('reference-type-model')) return 'component-meta (barModifiers order)';
	if (spec.includes('index.spec') && test.includes('reference-type-props') && !test.includes('destructured') && !test.includes('non-ascii') && !test.includes('js')) {
		return 'component-meta (nestedOptional order)';
	}
	return 'BEYOND';
}

const logs = process.argv.slice(2);
if (logs.length === 0) {
	console.error('Usage: node tools/triage-volar-suite-parse.mjs <log1> [log2]');
	process.exit(1);
}

const parsed = logs.map(p => ({ path: p, ...parseLog(fs.readFileSync(p, 'utf8')) }));
const allKeys = new Set();
for (const p of parsed) {
	for (const k of p.results.keys()) allKeys.add(k);
}

const rows = [...allKeys].sort().map(key => {
	const [spec, test] = key.includes(' > ') ? key.split(' > ') : [key, '(file-level)'];
	const run1 = parsed[0]?.results.get(key);
	const run2 = parsed[1]?.results.get(key);
	const failType = run1?.failType ?? run2?.failType ?? 'n/a';
	const allow = classifyAllowlist(spec, test);
	return { spec, test, run1: run1 ? 'FAIL' : 'PASS', run2: run2 ? 'FAIL' : 'PASS', failType, allow };
});

console.log('=== SUMMARIES ===');
for (const p of parsed) {
	console.log(`${p.path}:`, JSON.stringify(p.summary));
}
console.log('\n=== FAIL TABLE ===');
console.log('spec file | test name | run1 | run2 | fail type | allowlist');
for (const r of rows) {
	console.log(`${r.spec} | ${r.test} | ${r.run1} | ${r.run2} | ${r.failType} | ${r.allow}`);
}
