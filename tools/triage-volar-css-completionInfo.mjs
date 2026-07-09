/** completionInfo at volar css.ts with @vue/typescript-plugin (IDE path). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;

function offsetToLineCol(text, pos) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < pos; i++) {
		if (text[i] === '\n') { line++; col = 1; } else { col++; }
	}
	return { line, offset: col };
}

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, env);
let seq = 1;
const send = async (command, args, timeoutMs = 60_000) => {
	const t0 = Date.now();
	try {
		const res = await Promise.race([
			server.message({ seq: seq++, type: 'request', command, arguments: args }),
			new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
		]);
		console.log(`${command}: ${Date.now() - t0}ms ok=${res.success} msg=${(res.message ?? '').slice(0, 160)}`);
		return res;
	} catch (e) {
		console.log(`${command}: ${Date.now() - t0}ms ${e.message}`);
		return undefined;
	}
};

await send('configure', {
	preferences: {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	},
});
await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
});
const { line, offset: col } = offsetToLineCol(content, offset);
const comp = await send('completionInfo', {
	file: testFile,
	line,
	offset: col,
	includeExternalModuleExports: true,
	includeInsertTextCompletions: true,
});
const entries = comp?.body?.entries ?? [];
const names = entries.map(e => e.name);
console.log(`entries=${names.length} hasBar=${names.includes('bar')} sample=${JSON.stringify(names.slice(0, 10))}`);
server.kill?.();
