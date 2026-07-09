/** Simulate tsserver host: preferHostSourceFiles + getContextualType on DotToken */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-host-'));
const testFile = path.join(tmpDir, 'app.ts');
const tsconfig = path.join(tmpDir, 'tsconfig.json');
const content = 'const foo = 1;\nfoo.\n';
fs.writeFileSync(testFile, content);
fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

const host = {
	projectService: {}, // triggers preferHostSourceFiles
	getCompilationSettings: () => ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
		...ts.sys,
		getCurrentDirectory: () => tmpDir,
		onUnRecoverableConfigFileDiagnostic: () => {},
	}).options,
	getCurrentDirectory: () => tmpDir,
	getScriptFileNames: () => [testFile],
	getScriptVersion: () => '1',
	getScriptSnapshot: f => f === testFile ? ts.ScriptSnapshot.fromString(content) : undefined,
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
};

const program = ts.createProgram({
	rootNames: [testFile],
	options: { ...host.getCompilationSettings(), configFilePath: tsconfig },
}, host);
const sf = program.getSourceFile(testFile);
const checker = program.getTypeChecker();
const dotPos = content.indexOf('foo.') + 4;
const prev = ts.getTokenAtPosition(sf, dotPos - 1);
console.log('hostBound', !!(sf).__tnbHostBound);
console.log('prev', ts.SyntaxKind[prev.kind], prev.getText(sf));

const t0 = Date.now();
try {
	checker.getContextualType(prev);
	console.log(`getContextualType: ${Date.now() - t0}ms ok`);
} catch (e) {
	console.log(`getContextualType: ${Date.now() - t0}ms ERR`, e.message?.slice(0, 200));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
