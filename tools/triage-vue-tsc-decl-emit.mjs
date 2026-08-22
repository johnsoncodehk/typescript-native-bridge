#!/usr/bin/env node
/**
 * Witness for issue #63: declaration emit for `.vue` source files must produce
 * `Button.vue.d.ts`, not `Button.vue.d.vue.ts`.
 *
 * tsgo emits `{name}.d.{ext}.ts` for allowArbitraryExtensions source files
 * (e.g. Button.vue → Button.vue.d.vue.ts); the bridge must normalize this to
 * `{name}.d.ts` (Button.vue.d.ts) before handing the path to the host's
 * writeFile, matching stock TypeScript + Volar convention.
 *
 * The fixture mirrors the minimal reproduction from the issue: a .vue SFC
 * with plain-TS content (Volar's virtual TS injection role) and an index.ts
 * that re-exports it, compiled with declaration + emitDeclarationOnly.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-vue-tsc-decl-emit-'));
fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });

// .vue file with plain-TS content — mirrors what Volar injects as virtual TS
// for an SFC with a <script setup lang="ts"> block.
fs.writeFileSync(path.join(dir, 'src', 'components', 'Button.vue'), 'export default {};\n');
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export { default as Button } from "./components/Button.vue";\n');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: {
		module: 'ESNext',
		moduleResolution: 'Bundler',
		target: 'ESNext',
		strict: true,
		skipLibCheck: true,
		declaration: true,
		emitDeclarationOnly: true,
		rootDir: 'src',
		outDir: 'dist',
		types: [],
	},
	include: ['src/**/*.ts', 'src/**/*.vue'],
}));

// Register .vue as an extra script extension so collectExtraFileExtensions
// picks it up and tsgo treats the file as allowArbitraryExtensions, matching
// what vue-tsc / Volar do at program-creation time.
ts.supportedTSExtensionsFlat.push('.vue');

const configPath = path.join(dir, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
	...ts.sys,
	onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
if (!parsed) {
	console.error('FAIL: could not parse fixture tsconfig');
	process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);

// Capture all writeFile calls to inspect the emitted declaration paths.
const written = [];
program.emit(undefined, (fileName) => written.push(fileName));

const correct = written.filter(f => /Button\.vue\.d\.ts$/.test(f));
const broken  = written.filter(f => /Button\.vue\.d\.vue\.ts$/.test(f));
const indexDts = written.some(f => /index\.d\.ts$/.test(f));

console.log('Emitted files:');
for (const f of written) console.log(' ', path.relative(dir, f));

if (broken.length || !correct.length || !indexDts) {
	console.error('FAIL: wrong declaration emit for .vue source file (issue #63)');
	if (broken.length)   console.error('  spurious Button.vue.d.vue.ts output');
	if (!correct.length) console.error('  missing  Button.vue.d.ts output');
	if (!indexDts)       console.error('  missing  index.d.ts output');
	process.exit(1);
}
console.log('PASS: .vue declaration emitted as Button.vue.d.ts (not Button.vue.d.vue.ts)');
