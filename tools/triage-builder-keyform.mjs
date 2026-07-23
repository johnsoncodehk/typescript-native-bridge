#!/usr/bin/env node
/**
 * BuilderState key-form invariant: for every non-lib program source file, the
 * thin program's SourceFile.resolvedPath must be a key of the program's
 * tnbBuilderFileMetas map (the map BuilderState.create turns into fileInfos).
 *
 * updateShapeSignature (win32 tsc --noEmit --incremental crash) reads
 * fileInfos.get(sourceFile.resolvedPath).signature — any form drift between
 * the Go-derived meta keys and the host-side resolvedPath (slash direction,
 * case) makes that lookup miss. On failure this prints BOTH forms so the
 * mismatch is diagnosable from CI logs without a local Windows machine.
 *
 * Usage: node tools/triage-builder-keyform.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require2(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-keyform-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { incremental: true, tsBuildInfoFile: './.tsbuildinfo', strict: true, noEmit: true },
	include: ['src/**/*.ts'],
}));
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x: number = 1;\n');
fs.writeFileSync(path.join(dir, 'src', 'dep.ts'), 'import { x } from "./index";\nexport const y: number = x;\n');

const host = {
	getScriptFileNames: () => [path.join(dir, 'src', 'index.ts'), path.join(dir, 'src', 'dep.ts')],
	getScriptVersion: () => '1',
	getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
	getCurrentDirectory: () => dir,
	getCompilationSettings: () => ({ incremental: true, tsBuildInfoFile: './.tsbuildinfo', strict: true, noEmit: true, configFilePath: path.join(dir, 'tsconfig.json') }),
	getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
	directoryExists: ts.sys.directoryExists,
	getDirectories: ts.sys.getDirectories,
	useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
	getNewLine: () => '\n',
};
const ls = ts.createLanguageService(host);
const program = ls.getProgram();
const metas = program.tnbBuilderFileMetas?.();
const failures = [];
if (!metas) {
	failures.push('tnbBuilderFileMetas missing (expected for incremental mode)');
} else {
	for (const f of program.getSourceFiles()) {
		if (f.fileName.includes('/lib.')) continue;
		if (!metas.has(f.resolvedPath)) {
			failures.push(
				`resolvedPath not in fileInfos:\n    resolvedPath=${JSON.stringify(f.resolvedPath)}\n`
				+ `    nearest keys=${JSON.stringify([...metas.keys()].filter(k => k.includes(f.fileName.split('/').pop().replace(/\W/g, '')) || k.endsWith(f.fileName.split('/').pop())).slice(0, 3))}`,
			);
		}
	}
}
if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok every program file resolvedPath is a tnbBuilderFileMetas key (updateShapeSignature invariant)');
