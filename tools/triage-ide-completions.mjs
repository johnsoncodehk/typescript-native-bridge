/**
 * Minimal IDE completion repro via @typescript/server-harness.
 * Usage: node tools/triage-ide-completions.mjs [--no-plugin] [--stock]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const args = new Set(process.argv.slice(2));
const usePlugin = !args.has('--no-plugin');
const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);

const tsserverPath = args.has('--stock')
	? path.join(volarRoot, 'node_modules/typescript-ide/lib/tsserver.js')
	: path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-comp-'));
const testFile = path.join(tmpDir, 'app.ts');
const tsconfig = path.join(tmpDir, 'tsconfig.json');
fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
const content = 'const foo = 1;\nfoo.\n';
const offset = content.indexOf('foo.') + 4;

const tnbEnv = { ...process.env };
if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(tnbEnv.GODEBUG ?? '')) {
	tnbEnv.GODEBUG = tnbEnv.GODEBUG ? `${tnbEnv.GODEBUG},asyncpreemptoff=1` : 'asyncpreemptoff=1';
}

console.log('tsserver:', fs.realpathSync(tsserverPath));
console.log('vue plugin:', usePlugin);
console.log('GODEBUG:', tnbEnv.GODEBUG);

const serverArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];
if (usePlugin) {
	serverArgs.push('--globalPlugins', '@vue/typescript-plugin', '--pluginProbeLocations', pluginProbe);
}

const server = launchServer(tsserverPath, serverArgs, undefined, tnbEnv);
let seq = 1;
const send = async (command, arguments_) => {
	const t0 = Date.now();
	const res = await Promise.race([
		server.message({ seq: seq++, type: 'request', command, arguments: arguments_ }),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${command}`)), 30_000)),
	]);
	console.log(`${command}: ${Date.now() - t0}ms success=${res.success} msg=${(res.message ?? '').slice(0, 120)}`);
	return res;
};

try {
	await send('configure', { preferences: {} });
	await send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: testFile, fileContent: content, projectRootPath: tmpDir }],
	});
	const comp = await send('completions', { file: testFile, position: offset });
	const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
	console.log('entries:', entries.length);
	console.log('sample:', entries.slice(0, 8).map(e => e.name));
} catch (e) {
	console.error('FAIL:', e.message);
} finally {
	server.kill?.();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}
