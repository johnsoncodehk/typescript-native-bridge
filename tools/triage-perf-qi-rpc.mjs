#!/usr/bin/env node
// Perf diagnosis: edit→quickinfo wall vs createTsgoProgram stage timers + RPC.
// Requires TNB_TRACE_RPC (default off). Uses withTsserver (lock=1).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const baseContent = fs.readFileSync(mainVue, 'utf8');
const TRACE = process.env.TNB_TRACE_RPC_FILE || '/tmp/tnb-perf-qi-rpc.log';
const REPEATS = Math.max(3, Number(process.env.TNB_PERF_REPEATS || 3));
const INSERT_LINE = 12;
const QI = { line: 11, offset: 13 };

const args = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

fs.writeFileSync(TRACE, `# triage-perf-qi-rpc ${new Date().toISOString()}\n`);
const walls = [];
for (let run = 1; run <= REPEATS; run++) {
	await withTsserver({
		tsserverPath: tnbPath,
		args,
		env: tnbHarnessEnv({ TNB_TRACE_RPC: '1', TNB_TRACE_RPC_FILE: TRACE }),
	}, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		await send('quickinfo', { file: mainVue, ...QI });
		let typed = '';
		for (const ch of ['r', 'e', 'f']) {
			typed += ch;
			const phase = `run${run}-edit-${typed}-qi`;
			fs.appendFileSync(TRACE, `${Date.now()} PHASE ${phase}\n`);
			const t0 = Date.now();
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
			const editMs = Date.now() - t0;
			const t1 = Date.now();
			await send('quickinfo', { file: mainVue, ...QI });
			const qiMs = Date.now() - t1;
			fs.appendFileSync(TRACE, `${Date.now()} PHASE_END ${phase}\n`);
			walls.push({ run, typed, editMs, qiMs, total: editMs + qiMs, phase });
			console.log(`run${run} '${typed}': edit=${editMs} qi=${qiMs} total=${editMs + qiMs}`);
		}
	});
}

const text = fs.readFileSync(TRACE, 'utf8').split('\n');
console.log('\n=== pre-createTsgoProgram gaps (PHASE → first thinProgram.t) ===');
for (const w of walls) {
	let phaseStart = null;
	let firstT = null;
	for (const line of text) {
		if (line.includes(` PHASE ${w.phase}`)) phaseStart = Number(line.split(' ')[0]);
		if (phaseStart != null && line.includes('EVENT thinProgram.t afterEnsureBridge') && firstT == null) {
			firstT = Number(line.split(' ')[0]);
			break;
		}
	}
	console.log(`${w.phase}: wall=${w.total} preCreateProgram=${firstT != null && phaseStart != null ? firstT - phaseStart : 'n/a'}`);
}
console.log(`\ntrace → ${TRACE}`);
