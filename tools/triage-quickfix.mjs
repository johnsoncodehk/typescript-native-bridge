/**
 * Minimal repro: quickFix getCodeFixes hang on TNB.
 * node tools/triage-quickfix.mjs
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

async function timed(label, promise, ms = 15000) {
	const t0 = Date.now();
	const timer = setTimeout(() => console.error(`[TIMEOUT ${ms}ms] ${label}`), ms);
	try {
		const res = await promise;
		console.log(`[${Date.now() - t0}ms] ${label} success=${res?.success}`);
		return res;
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const tsserver = launchServer(tsserverPath, [
		'--disableAutomaticTypingAcquisition',
		'--globalPlugins', '@vue/typescript-plugin',
		'--pluginProbeLocations', pluginProbe,
		'--suppressDiagnosticEvents',
	]);

	let seq = 1;
	const send = (command, args) =>
		tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

	const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
	const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
	const vueContent = `
    <template>
            <button @click="foo"></button>
    </template>

    <script setup lang="ts">
    </script>
    `;
	const offset = vueContent.indexOf('foo');

	await timed('updateOpen fixture.ts', send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixtureTs, fileContent: 'export function foo() {}' }],
	}));

	await timed('updateOpen fixture.vue', send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixtureVue, fileContent: vueContent }],
	}));

	const diags = await timed('semanticDiagnosticsSync', send('semanticDiagnosticsSync', {
		file: fixtureVue,
		startLine: 3,
		startOffset: offset + 1,
		endLine: 3,
		endOffset: offset + 4,
	}));
	const errorCodes = (diags?.body ?? [])
		.map(d => d.code)
		.filter(c => typeof c === 'number');
	console.log('errorCodes:', errorCodes);

	await timed('getCodeFixes', send('getCodeFixes', {
		file: fixtureVue,
		startLine: 3,
		startOffset: offset + 1,
		endLine: 3,
		endOffset: offset + 4,
		errorCodes,
	}), 30000);

	tsserver.kill();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
