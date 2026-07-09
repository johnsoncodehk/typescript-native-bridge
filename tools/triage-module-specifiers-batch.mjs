/** Measure getModuleSpecifiersBatch via completionInfo verbose log. */
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
const logFile = '/tmp/tnb-batch-triage.log';

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
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
], undefined, env);
let seq = 1;
const send = async (command, args, timeoutMs = 120_000) => {
	const t0 = Date.now();
	const res = await Promise.race([
		server.message({ seq: seq++, type: 'request', command, arguments: args }),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
	]);
	console.log(`${command}: ${Date.now() - t0}ms ok=${res.success}`);
	return res;
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
await send('completionInfo', {
	file: testFile,
	line,
	offset: col,
	includeExternalModuleExports: true,
	includeInsertTextCompletions: true,
});
try {
	const log = fs.readFileSync(logFile, 'utf8');
	const hits = log.split('\n').filter(l => /collectAutoImports|module specifier/i.test(l));
	console.log('--- log ---');
	console.log(hits.slice(-15).join('\n'));
} catch (e) {
	console.log('no log', e.message);
}
server.kill?.();
