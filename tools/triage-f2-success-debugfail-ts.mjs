#!/usr/bin/env node
/**
 * F2 witness: Debug Failure on plain .ts (minimize away from .vue if possible).
 * Rep from cluster: component-meta/reference-type-exposed/my-exposed.ts L1:1
 * Also tries /tmp minimal import { ref } from 'vue' under test-workspace root.
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
const exposedTs = path.join(tw, 'component-meta/reference-type-exposed/my-exposed.ts');
const minDir = '/tmp/tnb-f2-min-ts';
const minTs = path.join(minDir, 'main.ts');

fs.mkdirSync(minDir, { recursive: true });
fs.writeFileSync(
	minTs,
	`import { ref } from 'vue';\nconst title = ref('');\nexport { title };\n`,
);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function runCase(label, tsserverPath, env, file, line, offset, projectRoot) {
	const content = fs.readFileSync(file, 'utf8');
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file, fileContent: content, projectRootPath: projectRoot }],
		});
		const refs = await send('references', { file, line, offset });
		const hl = await send('documentHighlights', {
			file,
			line,
			offset,
			filesToSearch: [file],
		});
		return {
			label,
			file,
			refs: {
				success: !!refs?.success,
				message: String(refs?.message ?? '').slice(0, 1200),
				n: (refs?.body?.refs ?? []).length,
			},
			hl: {
				success: !!hl?.success,
				message: String(hl?.message ?? '').slice(0, 400),
				n: (hl?.body ?? []).reduce((a, it) => a + (it.highlightSpans?.length ?? 0), 0),
			},
		};
	});
}

console.log('=== WITNESS f2-success-debugfail-ts ===');
// Case A: known ts cluster rep
{
	const tnb = await runCase('TNB', tnbPath, tnbHarnessEnv(), exposedTs, 1, 1, tw);
	const stock = await runCase('STOCK', stockPath, process.env, exposedTs, 1, 1, tw);
	console.log('\n--- my-exposed.ts L1:1 ---');
	console.log('TNB refs', tnb.refs.success, tnb.refs.n, tnb.refs.message.split('\n')[0]);
	if (!tnb.refs.success) console.log(tnb.refs.message);
	console.log('STOCK refs', stock.refs.success, stock.refs.n);
	console.log('TNB hl', tnb.hl.success, tnb.hl.n, tnb.hl.message.split('\n')[0]);
	console.log('STOCK hl', stock.hl.success, stock.hl.n);
}
// Case B: minimal ts under /tmp but projectRoot=tw for vue resolution
{
	const tnb = await runCase('TNB', tnbPath, tnbHarnessEnv(), minTs, 1, 10, tw); // 'ref'
	const stock = await runCase('STOCK', stockPath, process.env, minTs, 1, 10, tw);
	console.log('\n--- /tmp min main.ts ref import ---');
	console.log('TNB refs', tnb.refs.success, tnb.refs.n, tnb.refs.message.split('\n')[0]);
	if (!tnb.refs.success) console.log(tnb.refs.message);
	console.log('STOCK refs', stock.refs.success, stock.refs.n);
}
