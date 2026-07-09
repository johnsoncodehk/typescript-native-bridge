/** Reproduce getContextualType hang with proper configFilePath (tsgo path). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ctx2-'));
const testFile = path.join(tmpDir, 'app.ts');
const tsconfig = path.join(tmpDir, 'tsconfig.json');
const content = 'const foo = 1;\nfoo.\n';
fs.writeFileSync(testFile, content);
fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => tmpDir,
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
		getCanonicalFileName: f => f,
		getCurrentDirectory: () => tmpDir,
		getNewLine: () => '\n',
	}));
	},
});

const program = ts.createProgram({
	rootNames: parsed.fileNames.length ? parsed.fileNames : [testFile],
	options: { ...parsed.options, configFilePath: tsconfig },
});
const sf = program.getSourceFile(testFile);
const checker = program.getTypeChecker();
const dotPos = content.indexOf('foo.') + 4;
const prev = ts.getTokenAtPosition(sf, dotPos - 1);
console.log('configFilePath:', program.getCompilerOptions().configFilePath);
console.log('prev', ts.SyntaxKind[prev.kind]);

function timed(label, fn, ms = 15000) {
	const t0 = Date.now();
	return Promise.race([
		Promise.resolve().then(fn),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
	]).then(
		() => console.log(`${label}: ${Date.now() - t0}ms ok`),
		e => console.log(`${label}: ${Date.now() - t0}ms ${e.message}`),
	);
}

await timed('getContextualType(dot)', () => checker.getContextualType(prev));
await timed('getCompletionsAtPosition', () => {
	const svc = ts.createLanguageService({
		getCompilationSettings: () => program.getCompilerOptions(),
		getCurrentDirectory: () => tmpDir,
		getScriptFileNames: () => [testFile],
		getScriptVersion: () => '1',
		getScriptSnapshot: f => f === testFile ? ts.ScriptSnapshot.fromString(content) : undefined,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
	}, ts.createDocumentRegistry());
	return svc.getCompletionsAtPosition(testFile, dotPos);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
