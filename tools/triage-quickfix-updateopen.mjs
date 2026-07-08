/**
 * Repro moduleResolution (#5818) → quickFix updateOpen flake on TNB.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspace = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const tnbEnv = { ...process.env };
if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(tnbEnv.GODEBUG ?? '')) {
	tnbEnv.GODEBUG = tnbEnv.GODEBUG ? `${tnbEnv.GODEBUG},asyncpreemptoff=1` : 'asyncpreemptoff=1';
}

const runs = Number(process.argv.find((a, i) => process.argv[i - 1] === '--runs') ?? 30);

async function runOnce(server, seqRef) {
	const seq = () => ++seqRef.value;
	const msg = (command, args) =>
		server.message({ seq: seq(), type: 'request', command, arguments: args });

	const workspaceDir = path.join(testWorkspace, 'tsconfigProject');
	const mainPath = path.join(workspaceDir, 'module-rename-main.vue');
	const oldComponentPath = path.join(workspaceDir, 'module-rename-comp.vue');
	const newComponentPath = path.join(workspaceDir, 'module-rename-comp-renamed.vue');

	fs.writeFileSync(oldComponentPath, '<template>Comp</template>');
	const mainContent = `
<script setup lang="ts">
import Comp from './module-rename-comp-renamed.vue'
</script>
        `;
	fs.writeFileSync(mainPath, mainContent);

	let res = await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: mainPath, fileContent: mainContent }],
	});
	if (!res.success) throw new Error(`open main: ${res.message} ${JSON.stringify(res.body)}`);

	fs.renameSync(oldComponentPath, newComponentPath);

	for (let i = 0; i < 50; i++) {
		const d = await msg('semanticDiagnosticsSync', { file: mainPath });
		const has2307 = (d.body ?? []).some(x => x.code === 2307);
		if (!has2307) break;
		await new Promise(r => setTimeout(r, 100));
	}

	res = await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [mainPath],
		openFiles: [],
	});
	if (!res.success) throw new Error(`close main: ${res.message} ${JSON.stringify(res.body)}`);

	fs.rmSync(mainPath, { force: true });
	fs.rmSync(newComponentPath, { force: true });

	// quickFix
	const fixtureTs = path.join(workspaceDir, 'fixture.ts');
	const fixtureVue = path.join(workspaceDir, 'fixture.vue');
	const vueContent = `
    <template>
            <button @click="foo"></button>
    </template>

    <script setup lang="ts">
    </script>
    `;

	res = await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixtureTs, fileContent: 'export function foo() {}' }],
	});
	if (!res.success) {
		throw new Error(`open fixture.ts FAILED: success=${res.success} message=${JSON.stringify(res.message)} body=${JSON.stringify(res.body)}`);
	}

	res = await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixtureVue, fileContent: vueContent }],
	});
	if (!res.success) {
		throw new Error(`open fixture.vue FAILED: success=${res.success} message=${JSON.stringify(res.message)} body=${JSON.stringify(res.body)}`);
	}

	await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [fixtureTs, fixtureVue],
		openFiles: [],
	});
}

let fails = 0;
const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, tnbEnv);
const seqRef = { value: 0 };
await server.message({ seq: ++seqRef.value, type: 'request', command: 'configure', arguments: { preferences: {} } });

for (let i = 1; i <= runs; i++) {
	try {
		await runOnce(server, seqRef);
		console.log(`run ${i}: ok`);
	} catch (err) {
		fails++;
		console.error(`run ${i}: ${err.message.slice(0, 200)}`);
	}
}
server.kill();
console.log(`\n${fails}/${runs} failed`);
process.exit(fails ? 1 : 0);
