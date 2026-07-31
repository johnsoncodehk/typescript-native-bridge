#!/usr/bin/env node
/**
 * Witness for issue #47: a dependency that ships raw `.vue` source under
 * node_modules must type-check exactly like a project SFC. The host (Volar)
 * virtualizes those files by extension, so their generated TS must cross the
 * bridge even though the path contains /node_modules/ — the overlay-candidate
 * disk shortcuts (/node_modules/, /lib.) only apply to builtin script
 * extensions, whose honest content is always on disk.
 *
 * Fixture: vendor-ui/VendorComp.vue (real SFC) + RawModule.vue (plain-TS
 * probe) imported from src/Render.vue with a wrong prop on both VendorComp
 * and a local twin. Before the fix, TNB parsed the vendor SFC's raw disk
 * text (TS2306 "not a module") and lost the vendor prop error; RawModule
 * stayed clean under both, proving raw disk text is what reached tsgo.
 *
 * Exit 0: TNB diagnostics match stock. Exit 1: divergence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const fixture = '/tmp/tnb-triage-node-modules-sfc';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
];

function write(rel, content) {
	const file = path.join(fixture, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

fs.rmSync(fixture, { recursive: true, force: true });
fs.cpSync(path.join(volarRoot, 'test-workspace/node_modules/vue'), path.join(fixture, 'node_modules/vue'), { recursive: true });

const sfc = `<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
	<span>{{ label }}</span>
</template>
`;

write('node_modules/vendor-ui/package.json', JSON.stringify({ name: 'vendor-ui', version: '1.0.0', type: 'module' }, null, 2));
write('node_modules/vendor-ui/VendorComp.vue', sfc);
// Not an SFC: raw disk text parses as a valid TS module, so this import is
// clean under both engines — the control that isolates virtualization.
write('node_modules/vendor-ui/RawModule.vue', `export default { name: "raw" };\n`);
write('src/Local.vue', sfc);
write('src/Render.vue', `<script setup lang="ts">
import VendorComp from 'vendor-ui/VendorComp.vue';
import RawModule from 'vendor-ui/RawModule.vue';
import Local from './Local.vue';
console.log(RawModule);
</script>

<template>
	<VendorComp :label="123" />
	<Local :label="123" />
</template>
`);
write('tsconfig.json', JSON.stringify({
	compilerOptions: {
		lib: ['esnext', 'dom'],
		target: 'esnext',
		module: 'esnext',
		moduleResolution: 'bundler',
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		jsx: 'preserve',
		types: [],
	},
	include: ['src'],
}, null, 2));

const renderVue = path.join(fixture, 'src/Render.vue');

async function run(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: renderVue, fileContent: fs.readFileSync(renderVue, 'utf8'), projectRootPath: fixture }] });
		const resp = await send('semanticDiagnosticsSync', { file: renderVue, includeLinePosition: true });
		return (resp?.body ?? []).map((d) => {
			const s = d.start ?? d.startLocation, e = d.end ?? d.endLocation;
			return `${d.code}@${s?.line}:${s?.offset}-${e?.line}:${e?.offset}`;
		}).sort();
	});
}

console.log('=== WITNESS issue-47 (.vue under node_modules virtualized by host) ===');
const tnb = await run(tnbPath, tnbHarnessEnv());
const stock = await run(stockPath, process.env);
const match = JSON.stringify(tnb) === JSON.stringify(stock);
console.log(`-- src/Render.vue verdict=${match ? 'MATCH' : 'DIFF'}`);
console.log(`   TNB   ${JSON.stringify(tnb)}`);
console.log(`   STOCK ${JSON.stringify(stock)}`);
console.log(match ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(match ? 0 : 1);
