#!/usr/bin/env node
/**
 * Adversarial 6a: JSX attribute spelling witness for
 * getSuggestedSymbolForNonexistentJSXAttribute.
 * Local JSX namespace (no react dependency) + misspelled attribute;
 * stock should emit a "Did you mean" diagnostic + spelling fix.
 *
 * Usage: node tools/triage-adv6a-jsx-spelling.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const fixtureDir = '/tmp/tnb-adv6a-jsx-spelling';

const SRC = `// adv6a JSX attribute spelling
export const el = <div clasName="x" />;
`;

const GLOBAL_DTS = `declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    div: { className?: string; id?: string };
  }
}
`;

const TSCONFIG = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		jsx: 'preserve',
		strict: true,
		noEmit: true,
		lib: ['ES2020', 'DOM'],
	},
	include: ['*.tsx', '*.d.ts'],
};

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
fs.writeFileSync(path.join(fixtureDir, 'jsx.d.ts'), GLOBAL_DTS);
const file = path.join(fixtureDir, 'app.tsx');
fs.writeFileSync(file, SRC);

const typoOffset = SRC.indexOf('clasName');
const before = SRC.slice(0, typoOffset);
const line = before.split('\n').length;
const col = typoOffset - before.lastIndexOf('\n');

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
		const messages = diags.map(d => typeof d.text === 'string' ? d.text : JSON.stringify(d.text));
		const cf = await send('getCodeFixes', {
			file,
			startLine: line,
			startOffset: col,
			endLine: line,
			endOffset: col + 'clasName'.length,
			errorCodes: codes.length ? codes : [2551],
		});
		const fixes = (cf?.body ?? []).map(f => ({
			fixName: f.fixName,
			description: f.description,
			newTexts: (f.changes ?? []).flatMap(c => (c.textChanges ?? []).map(t => t.newText)),
		}));
		return { label, codes, messages, fixes };
	});
}

const stock = await runOne('stock', stockPath, process.env);
const tnb = await runOne('tnb', tnbPath, tnbHarnessEnv());

const norm = r => JSON.stringify({ codes: [...r.codes].sort(), fixes: r.fixes });
const parity = norm(stock) === norm(tnb);
const stockWitness = stock.messages.some(m => m.includes('className')) || stock.fixes.some(f => /spelling/i.test(String(f.fixName)));

console.log('=== adv6a JSX attribute spelling ===');
console.log('STOCK:', JSON.stringify(stock, null, 2));
console.log('TNB:  ', JSON.stringify(tnb, null, 2));
console.log(`stockWitness=${stockWitness}`);
console.log(`verdict=${parity ? 'PARITY' : 'DIFF'}`);
