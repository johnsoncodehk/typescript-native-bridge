#!/usr/bin/env node
/**
 * Adversarial 6b: generic createSignature — returnValueCorrect on a generic
 * function whose return type mismatches. Exercises checker.createSignature
 * with non-undefined declaration/typeParameters (which the Go
 * createSignatureFromParts intentionally ignores) to check the narrowing
 * does not change codefix output.
 *
 * Usage: node tools/triage-adv6b-generic-sig.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const fixtureDir = '/tmp/tnb-adv6b-generic-sig';

// Variable with generic function type annotation; initializer is a generic
// arrow whose body lacks a return. returnValueCorrect's isFunctionType path
// runs checker.createSignature(declaration, sig.typeParameters, ...) with a
// NON-undefined typeParameters list (the narrowing under test: Go's
// createSignatureFromParts ignores typeParameters).
const SRC = `// adv6b generic createSignature via returnValueCorrect
const identity: <T>(x: T) => T = <T,>(x: T) => {
  x;
};
`;

const TSCONFIG = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		lib: ['ES2020'],
	},
	include: ['*.ts'],
};

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
const file = path.join(fixtureDir, 'gen.ts');
fs.writeFileSync(file, SRC);

const anchor = 'identity';
const retOffset = SRC.indexOf(anchor);
const before = SRC.slice(0, retOffset);
const line = before.split('\n').length;
const col = retOffset - before.lastIndexOf('\n');

async function runOne(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env }, async ({ send }) => {
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file, fileContent: SRC, projectRootPath: fixtureDir }],
		});
		const semantic = await send('semanticDiagnosticsSync', { file });
		const diags = semantic?.body ?? [];
		const codes = diags.map(d => d.code);
		const cf = await send('getCodeFixes', {
			file,
			startLine: line,
			startOffset: col,
			endLine: line,
			endOffset: col + anchor.length,
			errorCodes: codes.length ? codes : [2322],
		});
		const fixes = (cf?.body ?? []).map(f => ({
			fixName: f.fixName,
			description: f.description,
			newTexts: (f.changes ?? []).flatMap(c => (c.textChanges ?? []).map(t => t.newText)),
		}));
		return { label, codes, fixes };
	});
}

const stock = await runOne('stock', stockPath, process.env);
const tnb = await runOne('tnb', tnbPath, tnbHarnessEnv());

const norm = r => JSON.stringify({ codes: [...r.codes].sort(), fixes: r.fixes });
const parity = norm(stock) === norm(tnb);
const stockWitness = stock.fixes.some(f => String(f.fixName).includes('returnValueCorrect') || String(f.fixName).includes('fixReturn'));

console.log('=== adv6b generic createSignature ===');
console.log('STOCK:', JSON.stringify(stock, null, 2));
console.log('TNB:  ', JSON.stringify(tnb, null, 2));
console.log(`stockWitness=${stockWitness}`);
console.log(`verdict=${parity ? 'PARITY' : 'DIFF'}`);
