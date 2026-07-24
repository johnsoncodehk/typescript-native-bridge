#!/usr/bin/env node
/**
 * Witness for a language-plugin extension discovered only through module
 * resolution.
 *
 * The setup mirrors `runTsc` by adding `.vue` to
 * `supportedTSExtensionsFlat` before `createProgram`. The config contains only
 * `main.ts`; `Component.vue` must enter the program through the import and
 * produce no diagnostics.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-imported-extra-extension-'));
const configFile = path.join(fixture, 'tsconfig.json');
const mainFile = path.join(fixture, 'main.ts');
const componentFile = path.join(fixture, 'Component.vue');

fs.writeFileSync(mainFile, "import component from './Component.vue';\ncomponent.message;\n");
fs.writeFileSync(componentFile, "export default { message: 'hello' };\n");
fs.writeFileSync(configFile, JSON.stringify({
	compilerOptions: {
		allowArbitraryExtensions: true,
		module: 'esnext',
		moduleResolution: 'bundler',
		noEmit: true,
		strict: true,
	},
	files: ['main.ts'],
}));

if (!ts.supportedTSExtensionsFlat.includes('.vue')) {
	ts.supportedTSExtensionsFlat.push('.vue');
}

const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
if (!parsed) {
	console.error('FAIL: could not parse fixture tsconfig');
	process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const hasComponent = program.getSourceFiles().some(file => path.resolve(file.fileName) === componentFile);

if (diagnostics.length || !hasComponent) {
	console.error(`FAIL: imported .vue was not fully loaded (program member: ${hasComponent})`);
	for (const diagnostic of diagnostics) {
		console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
	}
	process.exit(1);
}

console.log('PASS: imported .vue joined the program without being a configured root');
