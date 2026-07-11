#!/usr/bin/env node
/**
 * Triage: goto definition on Vue component default-export scenarios, TNB vs stock.
 * Covers the cases that motivated host default-export span anchors:
 *   1. import name        `import C|omponent from './empty.vue'` (fixture1.ts)
 *   2. module specifier   `import Component from '|./empty.vue'` (fixture2.ts)
 *   3. specifier -> .vue with explicit `export default` in script (#2600 shape)
 * Usage: node tools/triage-goto-def-component.mjs [--dump /tmp/out.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = process.argv.slice(2);
const dumpIdx = args.indexOf('--dump');
const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;

const volarRoot = resolveVolarRoot();
const defaultStock = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const stockPath = process.env.STOCK_TSSERVER_PATH ?? defaultStock;
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const projDir = path.join(testWorkspacePath, 'tsconfigProject');

const emptyVue = path.join(projDir, 'empty.vue');
const fooVue = path.join(projDir, 'triage-gtd-foo.vue');
const fixture1 = path.join(projDir, 'triage-gtd-fixture1.ts');
const fixture2 = path.join(projDir, 'triage-gtd-fixture2.ts');
const fixture3 = path.join(projDir, 'triage-gtd-fixture3.ts');

const fooVueContent = `<template>
	<h1>{{ msg }}</h1>
</template>

<script lang="ts">
export default defineProps<{ msg: string }>()
</script>
`;
const fixture1Content = `import Component from './empty.vue';\nconsole.log(Component);\n`;
const fixture2Content = `import Component from './empty.vue';\nconsole.log(Component);\n`;
const fixture3Content = `import Foo from './triage-gtd-foo.vue';\nconsole.log(Foo);\n`;
// #2600 shape: request from inside a .vue script setup, alias path, target has explicit export default
const fixtureVue = path.join(projDir, 'triage-gtd-fixture.vue');
const fixtureVueContent = `
<script setup lang="ts">
import Foo from '@/triage-gtd-foo.vue';
</script>
`;

/** @type {{ id: string; file: string; content: string; offset: number }[]} */
const CASES = [
	{ id: 'importName', file: fixture1, content: fixture1Content, offset: fixture1Content.indexOf('Component') + 3 },
	{ id: 'specifier', file: fixture2, content: fixture2Content, offset: fixture2Content.indexOf('./empty.vue') + 1 },
	{ id: 'specifierExplicitDefault', file: fixture3, content: fixture3Content, offset: fixture3Content.indexOf('./triage-gtd-foo.vue') + 1 },
	{ id: 'issue2600', file: fixtureVue, content: fixtureVueContent, offset: fixtureVueContent.indexOf(`'@/triage-gtd-foo.vue'`) + 1 },
];

function normalizeDefs(body) {
	const defs = body?.definitions ?? body ?? [];
	if (!Array.isArray(defs)) return [];
	return defs.map(d => ({
		file: d.file,
		start: d.start,
		end: d.end,
		contextStart: d.contextStart,
		contextEnd: d.contextEnd,
		unverified: d.unverified,
	}));
}

function defKey(defs) {
	return JSON.stringify(defs);
}

async function runAll(label, tsserverPath, env) {
	return withTsserver({
		tsserverPath,
		args: [
			'--disableAutomaticTypingAcquisition',
			'--globalPlugins', '@vue/typescript-plugin',
			'--pluginProbeLocations', pluginProbe,
			'--suppressDiagnosticEvents',
		],
		env,
	}, async ({ send }) => {
		await send('configure', { preferences: {} });
		const openFiles = [
			{ file: fooVue, fileContent: fooVueContent, projectRootPath: testWorkspacePath },
			...CASES.map(c => ({ file: c.file, fileContent: c.content, projectRootPath: testWorkspacePath })),
		];
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const out = {};
		for (const c of CASES) {
			const res = await send('definition', { file: c.file, position: c.offset });
			out[c.id] = { success: res?.success, defs: normalizeDefs(res?.body) };
		}
		return out;
	});
}

console.log('TNB:', fs.realpathSync(tnbPath));
console.log('STOCK:', stockPath);
if (!fs.existsSync(stockPath)) {
	console.error(`Stock tsserver missing: ${stockPath}`);
	process.exit(1);
}

const tnb = await runAll('TNB', tnbPath, tnbHarnessEnv());
const stock = await runAll('STOCK', stockPath, process.env);

const matrix = CASES.map(c => ({
	case: c.id,
	match: defKey(tnb[c.id].defs) === defKey(stock[c.id].defs),
	tnb: tnb[c.id].defs,
	stock: stock[c.id].defs,
}));

console.log('\n=== matrix ===');
console.log(JSON.stringify(matrix, null, 2));
const allMatch = matrix.every(r => r.match);
console.log(`\n=== verdict: ${allMatch ? 'ALL MATCH' : 'DIFF PRESENT'} ===`);

if (dumpPath) {
	fs.writeFileSync(dumpPath, JSON.stringify({ tnb, stock, matrix }, null, 2));
	console.log(`Wrote ${dumpPath}`);
}
