#!/usr/bin/env node
/**
 * Incremental composite emit: builder writeFile wrappers mutate the callback
 * `data` (data.skippedDtsWrite on the dts-unchanged skip path), so the bridge
 * emit proxy must always pass a data object — a missing one crashed every
 * edit-then-rebuild with "Cannot set properties of undefined (setting
 * 'skippedDtsWrite')". Builds a composite project, edits a file, rebuilds.
 *
 * Usage: node tools/triage-incremental-emit.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-inc-emit-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { composite: true, strict: true, declaration: true, outDir: 'dist', module: 'esnext', moduleResolution: 'bundler', types: [], skipLibCheck: true },
	include: ['src/**/*.ts'],
}));
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a: number = 1;\n');

const run = () => ts.executeCommandLine(ts.sys, ts.noop, ['-b', 'tsconfig.json']);
process.chdir(dir);
run(); // fresh build
// Comment-only edit: version changes (affected file) but the d.ts signature
// is unchanged, driving the builder down the skip-dts-write path where it
// mutates the writeFile callback's data object.
fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '// touch\n');
run();
run(); // steady state

if (!fs.existsSync(path.join(dir, 'dist', 'index.d.ts'))) {
	console.error('FAIL: no d.ts emitted');
	process.exit(1);
}
console.log('ok incremental composite rebuild (edit + dts-skip path)');
