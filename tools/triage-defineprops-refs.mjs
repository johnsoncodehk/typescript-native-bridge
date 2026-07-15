#!/usr/bin/env node
// Triage: find references on `defineProps` in main.vue — does the result set
// include the declaration in @vue/runtime-core dist/runtime-core.d.ts?
// Differential TNB vs stock to decide expected behavior.
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
const fileContent = fs.readFileSync(mainVue, 'utf8');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const offset = fileContent.indexOf('defineProps') + 4; // inside the word
function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
const pos = offsetToLineCol(fileContent, offset);
console.log(`target: line=${pos.line} col=${pos.offset}`);

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent, projectRootPath: testWorkspacePath }],
		});
		const refs = await send('references', { file: mainVue, line: pos.line, offset: pos.offset });
		const def = await send('definitionAndBoundSpan', { file: mainVue, line: pos.line, offset: pos.offset });
		return {
			label,
			refs: {
				success: refs?.success, message: refs?.message,
				items: (refs?.body?.refs ?? []).map(r => `${r.file}:${r.start?.line}:${r.start?.offset}${r.isDefinition ? ' [def]' : ''}`),
			},
			def: {
				success: def?.success,
				items: (def?.body?.definitions ?? []).map(d => `${d.file}:${d.start?.line}:${d.start?.offset}`),
			},
		};
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
for (const r of [tnb, stock]) {
	console.log(`\n=== ${r.label} ===`);
	console.log(`references: success=${r.refs.success} count=${r.refs.items.length} msg=${(r.refs.message ?? '').split('\n')[0]}`);
	for (const it of r.refs.items) console.log(`  ref ${it}`);
	console.log(`definitionAndBoundSpan: success=${r.def.success} count=${r.def.items.length}`);
	for (const it of r.def.items) console.log(`  def ${it}`);
}
const hasRt = items => items.some(s => s.includes('runtime-core.d.ts'));
console.log(`\nruntime-core in refs: TNB=${hasRt(tnb.refs.items)} STOCK=${hasRt(stock.refs.items)}`);
console.log(`runtime-core in defs: TNB=${hasRt(tnb.def.items)} STOCK=${hasRt(stock.def.items)}`);
