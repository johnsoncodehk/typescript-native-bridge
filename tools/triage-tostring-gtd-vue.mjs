#!/usr/bin/env node
// Triage: goto definition on `toString` in main.vue L12 (''.toString;) — TNB vs stock.
// Regression witness for the bundled:///libs/* fileName leak in DefinitionInfo.
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

const offset = fileContent.indexOf("''.toString") + "''.".length + 2; // inside toString
function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
const pos = offsetToLineCol(fileContent, offset);
console.log(`target: line=${pos.line} col=${pos.offset} (offset=${offset})`);

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent, projectRootPath: testWorkspacePath }],
		});
		const defBound = await send('definitionAndBoundSpan', { file: mainVue, line: pos.line, offset: pos.offset });
		const def = await send('definition', { file: mainVue, line: pos.line, offset: pos.offset });
		const qi = await send('quickinfo', { file: mainVue, line: pos.line, offset: pos.offset });
		return {
			label,
			defBound: { success: defBound?.success, message: defBound?.message, defs: defBound?.body?.definitions ?? [] },
			def: { success: def?.success, message: def?.message, defs: def?.body ?? [] },
			quickinfo: { success: qi?.success, displayString: qi?.body?.displayString },
		};
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
for (const r of [tnb, stock]) {
	console.log(`\n=== ${r.label} ===`);
	console.log(`definitionAndBoundSpan: success=${r.defBound.success} count=${r.defBound.defs.length} msg=${(r.defBound.message ?? '').split('\n')[0]}`);
	for (const d of r.defBound.defs) console.log(`  -> ${d.file}:${d.start?.line}:${d.start?.offset}`);
	console.log(`definition: success=${r.def.success} count=${r.def.defs.length}`);
	console.log(`quickinfo: success=${r.quickinfo.success} display=${JSON.stringify(r.quickinfo.displayString)}`);
}
const parity = tnb.defBound.success === stock.defBound.success
	&& tnb.defBound.defs.length === stock.defBound.defs.length
	&& tnb.defBound.defs.every(d => !String(d.file ?? '').startsWith('bundled://'));
console.log(`\nverdict: ${parity ? 'PARITY' : 'DIFF'}`);
