#!/usr/bin/env node
/**
 * Witness: completionEntryDetails ARRAY form (`entryNames`) — VS Code's actual
 * request shape — must not crash the auto-import slow path for pnpm-store
 * modules (volar test-workspace component-meta/#4577, `ref` from 'vue', whose
 * realpath lives under node_modules/.pnpm/...).
 *
 * Why the legacy probes missed it: the singular `entryName` form is rejected
 * by the tsserver handler (returns an empty array), so tools using it (e.g.
 * triage-completion-details-data.mjs before its array-form fix) could never
 * reach the crashing path. The array form reaches getCompletionEntryDetails →
 * getCompletionEntryCodeActionsAndSourceDisplay → getImportCompletionAction →
 * module-specifier computation; with an empty project symlink cache the pnpm
 * realpath mis-parses into a garbage ".pnpm/.../node_modules/vue" specifier
 * and Debug.assert(moduleSpecifier === data.moduleSpecifier) fails the request
 * ("Debug Failure. False expression." — surfaced via collectAutoImports /
 * getCompletionData in the IDE stack).
 *
 * Checks on component-meta/#4577/main.vue line 12 (`ref|`), TNB vs STOCK:
 *   1. legacy singular form succeeds (parity baseline)
 *   2. array form with data succeeds (the crash case)
 *   3. array form without data succeeds
 *   4. array-form sourceDisplay text matches STOCK (both "vue")
 * Exit 1 on any TNB failure or TNB≠STOCK divergence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');
const file = path.join(tw, 'component-meta/#4577/main.vue');
// main.vue line 12: `ref|` — offset 4 sits right after "ref".
const line = 12;
const offset = 4;

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];
const prefs = {
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
};

function displayText(parts) {
	return (parts ?? []).map((p) => p.text).join('');
}

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: prefs });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: tw }] });
		const info = await send('completionInfo', { file, line, offset, includeExternalModuleExports: true, includeInsertTextCompletions: true });
		const e = (info?.body?.entries ?? []).find((x) => x.name === 'ref');
		if (!e?.data) return { label, fatal: `no data-bearing 'ref' entry (entries=${info?.body?.entries?.length ?? 0})` };
		const legacy = await send('completionEntryDetails', { file, line, offset, entryName: e.name, source: e.source, data: e.data });
		const arr = await send('completionEntryDetails', { file, line, offset, entryNames: [{ name: e.name, source: e.source, data: e.data }] });
		const arrNoData = await send('completionEntryDetails', { file, line, offset, entryNames: [{ name: e.name, source: e.source }] });
		const firstLine = (r) => String(r?.message ?? '').split('\n')[0];
		return {
			label,
			legacy: { ok: !!legacy?.success, msg: legacy?.success ? '' : firstLine(legacy) },
			arr: { ok: !!arr?.success, msg: arr?.success ? '' : firstLine(arr), sourceDisplay: displayText(arr?.body?.[0]?.sourceDisplay) },
			arrNoData: { ok: !!arrNoData?.success, msg: arrNoData?.success ? '' : firstLine(arrNoData) },
		};
	});
}

console.log('=== WITNESS completion-details-array (#4577 ref| pnpm auto-import) ===');
const results = [];
for (const [label, p, env] of [['TNB', tnbPath, tnbHarnessEnv()], ['STOCK', stockPath, process.env]]) {
	try {
		const r = await run(label, p, env);
		results.push(r);
		if (r.fatal) {
			console.log(`${label}: FATAL ${r.fatal}`);
		} else {
			console.log(`${label}: legacy=${r.legacy.ok ? 'OK' : 'FAIL ' + r.legacy.msg} array=${r.arr.ok ? 'OK' : 'FAIL ' + r.arr.msg} arrayNoData=${r.arrNoData.ok ? 'OK' : 'FAIL ' + r.arrNoData.msg} sourceDisplay=${JSON.stringify(r.arr.sourceDisplay)}`);
		}
	} catch (err) {
		results.push({ label, fatal: String(err?.message ?? err).split('\n')[0] });
		console.log(`${label}: HARNESS-FAIL ${String(err?.message ?? err).split('\n')[0]}`);
	}
}

const tnb = results.find((r) => r.label === 'TNB');
const stock = results.find((r) => r.label === 'STOCK');
let bad = 0;
if (!tnb || tnb.fatal || !tnb.legacy?.ok || !tnb.arr?.ok || !tnb.arrNoData?.ok) {
	console.log('VERDICT: FAIL — TNB did not complete all three request shapes');
	bad = 1;
} else if (stock && !stock.fatal && stock.arr?.ok && tnb.arr.sourceDisplay !== stock.arr.sourceDisplay) {
	console.log(`VERDICT: FAIL — sourceDisplay diverges: TNB=${JSON.stringify(tnb.arr.sourceDisplay)} STOCK=${JSON.stringify(stock.arr.sourceDisplay)}`);
	bad = 1;
} else {
	console.log('VERDICT: PASS');
}
process.exit(bad);
