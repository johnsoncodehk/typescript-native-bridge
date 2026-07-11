#!/usr/bin/env node
/**
 * Adversarial: quickinfo on a type-parameter-typed value in a PLAIN .ts file
 * (non-host-bound path for typeParameterToDeclaration). TNB vs stock.
 * Usage: node tools/triage-hover-typeparam-ts.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const fixture = path.join(testWorkspacePath, 'tsconfigProject/triage-hover-tp.ts');
const content = [
	'export interface Base { value: string }',
	'export function pick<T extends Base, U>(item: T, other: U) {',
	'\tconst held = item;',
	'\tconst spare = other;',
	'\treturn { held, spare };',
	'}',
	'',
].join('\n');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const CASES = [
	{ id: 'constrainedUse', needle: 'held = item', pick: 'held' },
	{ id: 'unconstrainedUse', needle: 'spare = other', pick: 'spare' },
	{ id: 'paramT', needle: 'item: T', pick: 'item' },
	{ id: 'typeParamDecl', needle: 'T extends Base, U', pick: 'T' },
];

function lineCol(text, offset) {
	let line = 1, col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, col };
}

async function runAll(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: fixture, fileContent: content, projectRootPath: testWorkspacePath }],
		});
		const out = {};
		for (const c of CASES) {
			const offset = content.indexOf(c.needle) + c.needle.indexOf(c.pick);
			const pos = lineCol(content, offset);
			const res = await send('quickinfo', { file: fixture, line: pos.line, offset: pos.col });
			out[c.id] = {
				success: res?.success,
				message: res?.message,
				displayString: res?.body?.displayString,
				start: res?.body?.start,
				end: res?.body?.end,
			};
		}
		return out;
	});
}

fs.writeFileSync(fixture, content);
try {
	const tnb = await runAll(tnbPath, tnbHarnessEnv());
	const stock = await runAll(stockPath, process.env);
	const matrix = CASES.map(c => ({
		case: c.id,
		tnbDisplay: tnb[c.id].displayString,
		stockDisplay: stock[c.id].displayString,
		match: JSON.stringify(tnb[c.id]) === JSON.stringify(stock[c.id]),
		...(JSON.stringify(tnb[c.id]) !== JSON.stringify(stock[c.id])
			? { tnbRaw: tnb[c.id], stockRaw: stock[c.id] }
			: {}),
	}));
	console.log(JSON.stringify(matrix, null, 2));
	console.log(`\n=== verdict: ${matrix.every(r => r.match) ? 'PARITY' : 'DIFF PRESENT'} ===`);
}
finally {
	fs.unlinkSync(fixture);
}
