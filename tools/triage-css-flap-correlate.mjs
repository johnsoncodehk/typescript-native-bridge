#!/usr/bin/env node
/**
 * Fresh-session flap correlator: run N fresh TNB sessions; for each, diff
 * local and auto name multisets against the stock dump (/tmp/css-auto-stock.txt
 * must exist; local baseline computed from one stock run inline).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.split('\n').length;
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const sessions = Number(process.argv[2] ?? 5);

async function grab(tsserverPath, env) {
	const res = await withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env }, async ({ send }) => {
		await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
		return send('completionInfo', { file: testFile, offset, line, prefix: '' });
	});
	const entries = res?.body?.entries ?? [];
	return {
		local: entries.filter(e => !e.source && !e.data).map(e => e.name).sort(),
		auto: entries.filter(e => e.source).map(e => `${e.name}@${e.source}`).sort(),
	};
}

function multisetDiff(a, b) {
	const count = new Map();
	for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
	for (const x of b) count.set(x, (count.get(x) ?? 0) - 1);
	const onlyA = [], onlyB = [];
	for (const [k, v] of count) {
		if (v > 0) onlyA.push(`${k} x${v}`);
		if (v < 0) onlyB.push(`${k} x${-v}`);
	}
	return { onlyA, onlyB };
}

const stock = await grab(stockPath, process.env);
console.log(`stock local=${stock.local.length} auto=${stock.auto.length}`);
for (let i = 0; i < sessions; i++) {
	const tnb = await grab(tnbPath, tnbHarnessEnv());
	const localDiff = multisetDiff(stock.local, tnb.local);
	const autoDiff = multisetDiff(stock.auto, tnb.auto);
	const autoOnlyStock = autoDiff.onlyA.filter(s => !s.includes('featureWorkers'));
	const autoOnlyTnb = autoDiff.onlyB.filter(s => !s.includes('@../..'));
	console.log(`session=${i + 1} local=${tnb.local.length} auto=${tnb.auto.length} localMissing=${JSON.stringify(localDiff.onlyA)} localExtra=${JSON.stringify(localDiff.onlyB)} autoMissing=${JSON.stringify(autoOnlyStock)} autoExtra=${JSON.stringify(autoOnlyTnb)}`);
}
