#!/usr/bin/env node
/**
 * End-to-end witness for the V8-sandbox binary-transport fix: hijack
 * cp.fork's execPath so the harness spawns tsserver under VS Code's Electron
 * runtime ("Code Helper (Plugin)" + ELECTRON_RUN_AS_NODE), then probe the
 * component-meta/#4577/main.vue cases from the 2026-07-20 crash logs.
 *
 * Background: napi_create_external_buffer with a Go heap pointer fails under
 * Electron's V8 sandbox, killing every binary RPC session-wide (quickinfo /
 * definition / references / classifications all degraded or crashing). The
 * V8-allocated buffer + memcpy path works on every runtime.
 *
 * Exit-coded: 0 = all probes succeed. Requires a local VS Code install and
 * the volar checkout (VOLAR_ROOT override as usual).
 */
import cp from 'node:child_process';

const ELECTRON = process.env.TNB_ELECTRON_BIN
	?? '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';
const origFork = cp.fork;
cp.fork = function (modulePath, args, options = {}) {
	options.execPath = ELECTRON;
	options.env = { ...options.env, ELECTRON_RUN_AS_NODE: '1' };
	return origFork.call(this, modulePath, args, options);
};

const { tnbHarnessEnv, withTsserver } = await import('./tsserver-harness.mjs');
const { resolveVolarRoot } = await import('./volar-root.mjs');
const fs = await import('node:fs');
const path = await import('node:path');

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const extRoot = process.env.TNB_VOLAR_EXT_ROOT
	?? '/Users/johnsonchu/.vscode/extensions/vue.volar-3.2.6';
const file = path.join(volarRoot, 'test-workspace/component-meta/#4577/main.vue');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', 'vue-typescript-plugin-pack',
	'--pluginProbeLocations', extRoot,
	'--suppressDiagnosticEvents',
];

await withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv(), deadlineMs: 180_000 }, async ({ send }) => {
	await send('configure', { preferences: {} });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: volarRoot, plugins: ['vue-typescript-plugin-pack'] }] });

	const probes = [
		['qi@4:21', 'quickinfo', { file, line: 4, offset: 21 }],
		['def@4:21', 'definitionAndBoundSpan', { file, line: 4, offset: 21 }],
		['qi@3:24', 'quickinfo', { file, line: 3, offset: 24 }],
		['semCls', 'encodedSemanticClassifications-full', { file, start: 0, length: 2000, format: '2020' }],
		['getComponentNames', '_vue:getComponentNames', [file]],
		['refs@4:21', 'references', { file, line: 4, offset: 21 }],
	];
	let failed = 0;
	for (const [tag, cmd, args] of probes) {
		const r = await send(cmd, args);
		const msg = String(r?.message ?? '').split('\n')[0].slice(0, 200);
		const extra = r?.body?.displayString ?? (r?.body?.definitions ? JSON.stringify(r.body.definitions.map((d) => `${d.file.split('/').pop()}|${d.start.line}|${d.start.offset}`)) : r?.body ? JSON.stringify(r.body).slice(0, 100) : '');
		if (!r?.success) failed++;
		console.log(`${tag}: success=${!!r?.success} ${msg} ${String(extra).slice(0, 160)}`);
	}
	console.log(failed === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${failed}/${probes.length} failed)`);
	process.exitCode = failed === 0 ? 0 : 1;
});
console.log('ELECTRON-E2E-DONE');
