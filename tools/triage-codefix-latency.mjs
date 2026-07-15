#!/usr/bin/env node
// Triage: getCodeFixes latency after a keystroke (IDE lightbulb path), TNB vs stock.
// IDE witness: getCodeFixes took 168ms in front of completionInfo (queue serialization).
// Types r->re->ref at line 12 producing TS2304 "Cannot find name", then requests
// getCodeFixes over the error span. With TNB_RPC_TRACE=1 also decomposes TNB RPC counts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const baseContent = fs.readFileSync(mainVue, 'utf8');
const TRACE = '/tmp/tnb-codefix-rpc.log';
const INSERT_LINE = 12;

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		const steps = [];
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 }); // warm program

		let typed = '';
		for (const ch of ['r', 'e', 'f']) {
			typed += ch;
			await send('updateOpen', {
				changedFiles: [{
					fileName: mainVue,
					textChanges: [{
						start: { line: INSERT_LINE, offset: typed.length },
						end: { line: INSERT_LINE, offset: typed.length },
						newText: ch,
					}],
				}],
				openFiles: [], closedFiles: [],
			});
			if (label === 'TNB') fs.appendFileSync(TRACE, `${Date.now()} PHASE codefix-${typed}\n`);
			const t0 = Date.now();
			const fix = await send('getCodeFixes', {
				file: mainVue,
				startLine: INSERT_LINE, startOffset: 1,
				endLine: INSERT_LINE, endOffset: typed.length + 1,
				errorCodes: [2304],
			}).catch(e => ({ err: String(e) }));
			const ms = Date.now() - t0;
			if (label === 'TNB') fs.appendFileSync(TRACE, `${Date.now()} PHASE_END codefix-${typed}\n`);
			steps.push({ step: `'${typed}' getCodeFixes`, ms, n: fix?.body?.length ?? -1, err: fix?.err });
		}
		// Steady-state repeat (no edit in between).
		const tR = Date.now();
		await send('getCodeFixes', {
			file: mainVue,
			startLine: INSERT_LINE, startOffset: 1,
			endLine: INSERT_LINE, endOffset: typed.length + 1,
			errorCodes: [2304],
		}).catch(() => {});
		steps.push({ step: 'repeat-no-edit', ms: Date.now() - tR });
		return { label, steps };
	});
}

fs.writeFileSync(TRACE, `# triage-codefix-latency ${new Date().toISOString()}\n`);
const results = [];
results.push(await run('TNB', tnbPath, tnbHarnessEnv({ TNB_TRACE_RPC: '1', TNB_RPC_TRACE_FILE: TRACE })));
results.push(await run('STOCK', stockPath, process.env));
for (const r of results) {
	console.log(`\n=== ${r.label} ===`);
	for (const s of r.steps) console.log(`  ${s.step}: ${s.ms}ms fixes=${s.n ?? '-'}${s.err ? ' ERR=' + s.err : ''}`);
}

// RPC decomposition per phase from the trace.
const lines = fs.readFileSync(TRACE, 'utf8').split('\n');
let phase = null;
const byPhase = new Map();
for (const line of lines) {
	const mPhase = line.match(/ PHASE (\S+)$/);
	if (mPhase) { phase = mPhase[1]; byPhase.set(phase, new Map()); continue; }
	if (/ PHASE_END /.test(line)) { phase = null; continue; }
	if (!phase) continue;
	const mEnter = line.match(/ENTER \d+ .*?(?:JSON|BIN) (\S+)/);
	if (mEnter) {
		const m = byPhase.get(phase);
		m.set(mEnter[1], (m.get(mEnter[1]) ?? 0) + 1);
	}
}
console.log('\n=== TNB RPC counts during getCodeFixes phases ===');
for (const [ph, counts] of byPhase) {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	console.log(`${ph}: totalRPC=${total} top=${top.map(([k, v]) => `${k}×${v}`).join(' ')}`);
}
console.log(`trace → ${TRACE}`);
