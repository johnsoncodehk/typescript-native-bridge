#!/usr/bin/env node
/**
 * Witness for issue #40: Program.emit must throw loudly when handed a custom
 * transformer (tsgo can't execute JS transformer functions — silently
 * dropping one would diverge the emit from stock, e.g. nest-cli's metadata
 * plugin path). Empty shells ({ before: [] }) transform nothing either way
 * and must pass through to a normal emit.
 *
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-custom-transformers-'));
const configFile = path.join(fixture, 'tsconfig.json');
const mainFile = path.join(fixture, 'main.ts');
fs.writeFileSync(mainFile, 'export const x: number = 1;\n');
fs.writeFileSync(configFile, JSON.stringify({
	compilerOptions: { strict: true, module: 'commonjs', target: 'es2022', outDir: 'out' },
	files: ['main.ts'],
}));

const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
if (!parsed) {
	console.error('FAIL: could not parse fixture tsconfig');
	process.exit(1);
}
const program = ts.createProgram(parsed.fileNames, parsed.options);

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? 'ok' : 'FAIL'} ${label}`);
	if (!ok) failed++;
};

const expectThrow = (label, customTransformers) => {
	try {
		program.emit(undefined, undefined, undefined, false, customTransformers);
		check(`${label}: threw`, false);
	} catch (e) {
		check(`${label}: throws customTransformers error`, /customTransformers/.test(String(e?.message ?? e)));
	}
};
const identity = () => sf => sf;
expectThrow('before:[fn]', { before: [identity] });
expectThrow('afterDeclarations:[fn]', { afterDeclarations: [identity] });

// Empty shells: no transformation happens either way — normal emit proceeds.
const written = [];
const res = program.emit(undefined, (fileName, text) => written.push(fileName), undefined, false, { before: [], after: [], afterDeclarations: [] });
check('empty shells: emit proceeds', !res.emitSkipped && written.some(f => f.endsWith('.js')));

process.exit(failed ? 1 : 0);
