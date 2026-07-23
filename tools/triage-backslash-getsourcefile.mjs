#!/usr/bin/env node
/**
 * program.getSourceFile must accept Windows backslash paths (stock parity:
 * stock resolves fileName through toPath, which normalizes slashes).
 *
 * Pre-fix (volar win32 CI, ts-named-exports): the thin program's membership
 * gate compared the raw input against the forward-slash nameSet, so
 * getSourceFile("D:\\a\\component.ts") returned undefined — and
 * getSymbolAtLocation(undefined) crashed downstream with
 * "Cannot read properties of undefined (reading 'getSourceFile')".
 *
 * Usage: node tools/triage-backslash-getsourcefile.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require2(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-bs-gsf-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
const host = {
	getScriptFileNames: () => [path.join(dir, 'a.ts')],
	getScriptVersion: () => '1',
	getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
	getCurrentDirectory: () => dir,
	getCompilationSettings: () => ({ strict: true, noEmit: true, configFilePath: path.join(dir, 'tsconfig.json') }),
	getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
	directoryExists: ts.sys.directoryExists,
	getDirectories: ts.sys.getDirectories,
	useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
	getNewLine: () => '\n',
};
const program = ts.createLanguageService(host).getProgram();
const backslash = path.join(dir, 'a.ts').replace(/\//g, '\\');
const sf = program.getSourceFile(backslash);
if (!sf) {
	console.error(`FAIL: getSourceFile(${JSON.stringify(backslash)}) returned undefined for a program file`);
	process.exit(1);
}
console.log('ok getSourceFile accepts backslash paths (membership gate normalizes input)');
