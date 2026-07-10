#!/usr/bin/env node
/** Inspect process module batch entry shape (file vs ambient). */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const ts = require(path.join(volarRoot, 'node_modules/typescript'));
const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: () => { throw new Error('x'); },
});
const program = ts.createProgram({
	rootNames: [...new Set([...parsed.fileNames, cssTs])],
	options: parsed.options,
	host: { ...ts.createCompilerHost(parsed.options, true), getCurrentDirectory: () => volarRoot },
});
const batch = program.getModuleExportMap?.(cssTs);
for (const name of ['process', 'node:process']) {
	const mod = batch?.modules?.find(m => m.moduleName === name || m.moduleName === `"${name}"`);
	console.log(name, {
		moduleFileName: mod?.moduleFileName,
		moduleName: mod?.moduleName,
		named: mod?.namedExports?.length,
		hasCwd: mod?.namedExports?.some(e => e.key === 'cwd'),
	});
}
