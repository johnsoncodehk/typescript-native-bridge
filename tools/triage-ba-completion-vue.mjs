/** ba| in .vue script block with @vue/typescript-plugin */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-vue-ba-'));
const testFile = path.join(tmpDir, 'app.vue');
const snippet = `
<script setup lang="ts">
let bar;
ba|
</script>
`;
const offset = snippet.indexOf('|');
const body = snippet.slice(0, offset) + snippet.slice(offset + 1);
fs.writeFileSync(testFile, body);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, jsx: 'preserve' },
	include: ['**/*'],
}, null, 2));

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, env);
let seq = 1;
const send = async (command, args, timeoutMs = 30_000) => {
	const t0 = Date.now();
	try {
		const res = await Promise.race([
			server.message({ seq: seq++, type: 'request', command, arguments: args }),
			new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
		]);
		console.log(`${command}: ${Date.now() - t0}ms ok=${res.success}`);
		return res;
	} catch (e) {
		console.log(`${command}: ${Date.now() - t0}ms ${e.message}`);
		return undefined;
	}
};

await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: body, projectRootPath: tmpDir }] });
const comp = await send('completions', { file: testFile, position: offset });
const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
const names = entries.map(e => e.name);
console.log(`entries=${names.length} hasBar=${names.includes('bar')} sample=${JSON.stringify(names.slice(0, 10))}`);
server.kill?.();
fs.rmSync(tmpDir, { recursive: true, force: true });
