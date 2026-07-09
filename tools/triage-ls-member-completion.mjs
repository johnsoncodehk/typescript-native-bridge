/** Language service path: reproduce member completion hang like tsserver */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ls-'));
const testFile = path.join(tmpDir, 'app.ts');
const content = 'const foo = 1;\nfoo.\n';
fs.writeFileSync(testFile, content);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

const host = {
	getCompilationSettings: () => ts.getParsedCommandLineOfConfigFile(
		path.join(tmpDir, 'tsconfig.json'),
		{},
		{ ...ts.sys, getCurrentDirectory: () => tmpDir, onUnRecoverableConfigFileDiagnostic: () => {} },
	).options,
	getCurrentDirectory: () => tmpDir,
	getScriptFileNames: () => [testFile],
	getScriptVersion: () => '1',
	getScriptSnapshot: (f) => f === testFile ? ts.ScriptSnapshot.fromString(content) : undefined,
	getScriptKind: () => ts.ScriptKind.TS,
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
};

const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
const dotPos = content.indexOf('foo.') + 4;

function timed(label, fn, ms = 15000) {
	const t0 = Date.now();
	return Promise.race([
		Promise.resolve().then(fn),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
	]).then(
		r => { console.log(`${label}: ${Date.now() - t0}ms`, Array.isArray(r) ? `entries=${r.length}` : typeof r); return r; },
		e => { console.log(`${label}: ${Date.now() - t0}ms ${e.message}`); },
	);
}

await timed('getCompletionsAtPosition', () => ls.getCompletionsAtPosition(testFile, dotPos));
await timed('getCompletionEntryDetails', () => ls.getCompletionEntryDetails(testFile, dotPos, 'toString'));

fs.rmSync(tmpDir, { recursive: true, force: true });
