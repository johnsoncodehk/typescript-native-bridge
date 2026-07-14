#!/usr/bin/env node
/**
 * Run one (or all) family-1 witness case groups.
 * Usage:
 *   node tools/triage-f1-run-case.mjs <slug>
 *   node tools/triage-f1-run-case.mjs --all
 * Writes /tmp/tnb-f1-witness-<slug>.txt per group.
 */
import * as fs from 'node:fs';
import { CASES } from './triage-f1-cases.mjs';
import { printQiDiff, quickinfoBoth } from './triage-f1-qi-common.mjs';

const arg = process.argv[2];
if (!arg) {
	console.error('usage: node tools/triage-f1-run-case.mjs <slug|--all>');
	process.exit(2);
}

const slugs = arg === '--all' ? Object.keys(CASES) : [arg];
let totalDiff = 0;
let totalMatch = 0;

for (const slug of slugs) {
	const cases = CASES[slug];
	if (!cases) {
		console.error(`unknown slug: ${slug}`);
		console.error(`known: ${Object.keys(CASES).join(', ')}`);
		process.exit(2);
	}
	const outPath = `/tmp/tnb-f1-witness-${slug.replace(/[/:]/g, '-')}.txt`;
	const lines = [];
	// monkey-patch console for printQiDiff (capture must call origLog, not console.log)
	const origLog = console.log;
	const capture = {
		log: (...a) => {
			const s = a.map(String).join(' ');
			origLog(s);
			lines.push(s);
		},
	};
	console.log = (...a) => capture.log(...a);
	capture.log(`### F1 WITNESS slug=${slug} cases=${cases.length}`);
	let diffs = 0;
	for (const c of cases) {
		try {
			const result = await quickinfoBoth(c);
			const match = printQiDiff(`${slug} :: ${c.title}`, result);
			if (c.note) capture.log(`note: ${c.note}`);
			if (match) totalMatch++;
			else {
				totalDiff++;
				diffs++;
			}
		} catch (e) {
			capture.log(`ERROR ${c.title}: ${e?.stack ?? e}`);
			totalDiff++;
			diffs++;
		}
	}
	console.log = origLog;
	capture.log(`\n### slug=${slug} DIFF=${diffs}/${cases.length}`);
	fs.writeFileSync(outPath, lines.join('\n') + '\n');
	console.log(`wrote ${outPath}`);
}

console.log(`\nTOTAL DIFF=${totalDiff} MATCH=${totalMatch}`);
process.exit(totalDiff > 0 ? 0 : 0); // witnesses expect DIFF; never fail the diagnosis run
