#!/usr/bin/env node
/**
 * `tsc --emitDeclarationOnly` must suppress JS outputs (issue #33). The
 * effective options ride updateSnapshot to Go (CLI flags never appear in the
 * on-disk tsconfig), and handleEmit narrows the default EmitOnly to
 * declarations from the wire options — before that, plain tsc emitted .js
 * files next to the sources.
 *
 * Usage: node tools/triage-emit-declaration-only.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-emit-decl-only-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
// Mirrors the issue #33 tsconfig: declaration + declarationDir, CLI-only flag.
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { declaration: true, declarationDir: 'dist', module: 'preserve', moduleResolution: 'bundler', rootDir: 'src', strict: true, types: [], skipLibCheck: true },
	include: ['src/**/*.ts'],
}));
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a: number = 1;\n');

process.chdir(dir);
ts.executeCommandLine(ts.sys, ts.noop, ['-p', 'tsconfig.json', '--emitDeclarationOnly']);

const js = fs.existsSync(path.join(dir, 'src', 'index.js')) || fs.existsSync(path.join(dir, 'dist', 'index.js'));
const dts = fs.existsSync(path.join(dir, 'dist', 'index.d.ts'));
if (js || !dts) {
	console.error(`FAIL: emitDeclarationOnly produced js=${js}, dts=${dts}`);
	process.exit(1);
}
console.log('ok --emitDeclarationOnly emits d.ts only');
