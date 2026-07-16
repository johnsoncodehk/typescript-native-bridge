#!/usr/bin/env node
/**
 * Probe: completionEntryDetails fast-path crash ("Should not run 'collectAutoImports'
 * when faster path is available via `data`" — completions.ts:4233).
 * Repro chain: completionInfo (external module exports) → for entries with `data`,
 * completionEntryDetails → success=false / server error = repro.
 * Buckets entries by data.fileName extension (.vue vs .ts) and details-queries a
 * sample of each bucket (fast path fails per-source-module, so bucket coverage
 * matters more than raw count). Runs TNB vs STOCK.
 * Case A: plain .ts in workspace. Case B: .vue script setup.
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

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];
const prefs = {
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
	includeCompletionsWithClassMemberSnippets: true,
};

// A: plain .ts inside workspace; B: .vue script setup. Both import from 'vue'
// first so the auto-import provider covers the module (a file importing nothing
// gets no data-bearing entries — verified against stock).
const tsFile = path.join(tw, 'tsc/completion-details-probe.ts');
fs.writeFileSync(tsFile, `import { ref } from 'vue';\nconst x = comput\n`);
const vueFile = path.join(tw, 'tsc/completion-details-probe.vue');
fs.writeFileSync(vueFile, `<script setup lang="ts">\nimport { ref } from 'vue';\nconst x = comput\n</script>\n`);
// C: inside tsc/components (own tsconfig) — sibling .vue default export +
// ../shared .ts named export both enter the auto-import provider via main.vue.
// This is the .vue-bucket / light-stub suspect case.
const compDir = path.join(tw, 'tsc/components');
const vueFileC = path.join(compDir, 'completion-details-probe-c.vue');
fs.writeFileSync(vueFileC, `<script setup lang="ts">\nimport ScriptSetup from './script-setup.vue';\nconst a = ScriptSetupE\nconst b = exact\n</script>\n`);

function bucketOf(e) {
	const f = e.data?.fileName ?? '';
	if (f.endsWith('.vue')) return 'vue';
	if (f.endsWith('.d.ts') || f.endsWith('.d.mts') || f.endsWith('.d.cts')) return 'dts';
	return 'ts';
}

async function run(label, tsserverPath, env, file, line, offset) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: prefs });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: tw }] });
		const info = await send('completionInfo', { file, line, offset, includeExternalModuleExports: true, includeInsertTextCompletions: true });
		const entries = info?.body?.entries ?? [];
		const withData = entries.filter((e) => e.data != null);
		const buckets = new Map();
		for (const e of withData) {
			const b = bucketOf(e);
			if (!buckets.has(b)) buckets.set(b, []);
			buckets.get(b).push(e);
		}
		const out = { label, total: entries.length, withData: withData.length, bucketSizes: {}, crashes: [], fails: [], okCount: 0, queried: 0 };
		for (const [b, list] of buckets) {
			out.bucketSizes[b] = list.length;
			for (const e of list.slice(0, 50)) {
				out.queried++;
				try {
					const det = await send('completionEntryDetails', { file, line, offset, entryName: e.name, source: e.source, data: e.data });
					if (!det?.success) out.fails.push({ bucket: b, name: e.name, msg: String(det?.message ?? '').split('\n')[0] });
					else out.okCount++;
				} catch (err) {
					out.crashes.push({ bucket: b, name: e.name, err: String(err?.message ?? err).split('\n')[0] });
					break; // server likely dead
				}
			}
		}
		return out;
	});
}

console.log('=== PROBE completion-details-data ===');
for (const [tag, file, line, offset] of [
	['A ts', tsFile, 2, 15],
	['B vue', vueFile, 3, 15],
	['C vue->.vue', vueFileC, 3, 21],
	['D vue->ts', vueFileC, 4, 14],
]) {
	for (const [label, p, env] of [['TNB', tnbPath, tnbHarnessEnv()], ['STOCK', stockPath, process.env]]) {
		try {
			const r = await run(label, p, env, file, line, offset);
			console.log(`${tag} ${label}: total=${r.total} withData=${r.withData} buckets=${JSON.stringify(r.bucketSizes)} queried=${r.queried} ok=${r.okCount} fails=${r.fails.length} crashes=${r.crashes.length}`);
			for (const f of r.fails.slice(0, 5)) console.log(`   FAIL [${f.bucket}] ${f.name}: ${f.msg}`);
			for (const c of r.crashes.slice(0, 5)) console.log(`   CRASH [${c.bucket}] ${c.name}: ${c.err}`);
		} catch (err) {
			console.log(`${tag} ${label}: HARNESS-FAIL ${String(err?.message ?? err).split('\n')[0]}`);
		}
	}
}
fs.unlinkSync(tsFile);
fs.unlinkSync(vueFile);
fs.unlinkSync(vueFileC);
