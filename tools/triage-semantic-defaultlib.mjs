#!/usr/bin/env node
// Regression witness: node_modules declarations are dependencies, not the
// TypeScript default library. The 2020 semantic classifier must reserve the
// defaultLibrary modifier for symbols whose declaration is in lib.*.d.ts.

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-semantic-defaultlib-')));
const appFile = path.join(dir, 'app.ts');
const depDir = path.join(dir, 'node_modules', 'dependency');
const depFile = path.join(depDir, 'index.d.ts');
const configFile = path.join(dir, 'tsconfig.json');
const appText = "import { dependencyFunction } from 'dependency';\ndependencyFunction();\n";
const depText = 'export declare function dependencyFunction(): Promise<number>;\n';

fs.mkdirSync(depDir, { recursive: true });
fs.writeFileSync(appFile, appText);
fs.writeFileSync(depFile, depText);
fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'dependency', types: 'index.d.ts' }));
fs.writeFileSync(configFile, JSON.stringify({ compilerOptions: { module: 'commonjs', moduleResolution: 'node10', strict: true, noEmit: true }, include: ['app.ts'] }));

const options = {
	module: ts.ModuleKind.CommonJS,
	moduleResolution: ts.ModuleResolutionKind.Node10,
	strict: true,
	noEmit: true,
	configFilePath: configFile,
};
const host = {
	getScriptFileNames: () => [appFile],
	getScriptVersion: () => '1',
	getScriptSnapshot: fileName => fs.existsSync(fileName) ? ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8')) : undefined,
	getCurrentDirectory: () => dir,
	getCompilationSettings: () => options,
	getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
	directoryExists: ts.sys.directoryExists,
	getDirectories: ts.sys.getDirectories,
	useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
	getNewLine: () => '\n',
};

const languageService = ts.createLanguageService(host);
const program = languageService.getProgram();
const dependencySourceFile = program?.getSourceFile(depFile);
if (!program || !dependencySourceFile) {
	throw new Error(`dependency source file was not loaded into the program: ${JSON.stringify(program?.getSourceFileNames?.())}`);
}

const defaultLibFile = program.getSourceFile(ts.getDefaultLibFilePath(options));
if (!defaultLibFile || !program.isSourceFileDefaultLibrary(defaultLibFile)) {
	throw new Error('the bundled lib.d.ts was not recognized as a default library');
}
if (program.isSourceFileDefaultLibrary(dependencySourceFile)) {
	throw new Error('node_modules dependency was incorrectly recognized as a default library');
}

const spans = languageService.getEncodedSemanticClassifications(
	depFile,
	{ start: 0, length: depText.length },
	ts.SemanticClassificationFormat.TwentyTwenty,
).spans;
const modifierAt = text => {
	const start = depText.indexOf(text);
	for (let i = 0; i < spans.length; i += 3) {
		if (spans[i] === start && spans[i + 1] === text.length) return spans[i + 2] & 0xff;
	}
	throw new Error(`no semantic classification for ${text}`);
};

const declaration = 1 << 0;
const defaultLibrary = 1 << 4;
const functionModifiers = modifierAt('dependencyFunction');
const promiseModifiers = modifierAt('Promise');
if (functionModifiers !== declaration) {
	throw new Error(`dependency function modifiers were ${functionModifiers}, expected declaration (${declaration})`);
}
if (promiseModifiers !== defaultLibrary) {
	throw new Error(`default-lib Promise modifiers were ${promiseModifiers}, expected defaultLibrary (${defaultLibrary})`);
}

console.log('ok semantic defaultLibrary modifier is limited to lib.*.d.ts declarations');
