#!/usr/bin/env node
/**
 * Triage: goto definition vs references for v-for index/row/rows (#4577 main.vue).
 * Usage: node tools/triage-goto-def-index.mjs [--dump /tmp/out.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = process.argv.slice(2);
const dumpIdx = args.indexOf('--dump');
const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;

const volarRoot = resolveVolarRoot();
const defaultStock = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const stockPath = process.env.STOCK_TSSERVER_PATH ?? defaultStock;
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const fileContent = fs.readFileSync(mainVue, 'utf8');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

/** @typedef {{ id: string; label: string; offset: number }} Case */
/** @type {Case[]} */
const CASES = [
	{ id: 'index', label: '{{ index }}', offset: fileContent.indexOf('{{ index }}') + '{{ '.length },
	{ id: 'row', label: ':row="row"', offset: fileContent.lastIndexOf('row" />') - 3 },
	{ id: 'rows', label: 'in rows', offset: fileContent.indexOf('in rows') + 'in '.length },
];

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, offset: col };
}

function normalizeDefs(body) {
	const defs = body?.definitions ?? body ?? [];
	if (!Array.isArray(defs)) return [];
	return defs.map(d => ({
		file: d.file ?? d.fileName,
		start: d.textSpan?.start ?? d.start,
		length: d.textSpan?.length ?? d.length,
		kind: d.kind,
		name: d.name,
		containerName: d.containerName,
	}));
}

function normalizeRefs(body) {
	const refs = body?.refs ?? [];
	return refs.map(r => ({
		file: r.file ?? r.fileName,
		start: r.textSpan?.start ?? r.start,
		length: r.textSpan?.length ?? r.length,
		isDefinition: r.isDefinition,
	}));
}

function normalizeBoundSpan(body) {
	if (!body) return undefined;
	const span = body.textSpan ?? body.boundSpan;
	return span ? { start: span.start, length: span.length } : undefined;
}

function defKey(defs) {
	return JSON.stringify(defs.map(d => ({ file: d.file, start: d.start, length: d.length })).sort((a, b) =>
		(a.file ?? '').localeCompare(b.file ?? '') || a.start - b.start));
}

function refKey(refs) {
	return JSON.stringify(refs.map(r => ({ file: r.file, start: r.start, length: r.length, isDefinition: r.isDefinition }))
		.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.start - b.start));
}

async function runCase(label, tsserverPath, env, caseSpec) {
	return withTsserver({
		tsserverPath,
		args: harnessArgs,
		env,
	}, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: mainVue, fileContent, projectRootPath: testWorkspacePath }],
		});

		const pos = offsetToLineCol(fileContent, caseSpec.offset);
		const defBound = await send('definitionAndBoundSpan', {
			file: mainVue,
			line: pos.line,
			offset: pos.offset,
		});
		const defOnly = await send('definition', {
			file: mainVue,
			line: pos.line,
			offset: pos.offset,
		});
		const refs = await send('references', {
			file: mainVue,
			position: caseSpec.offset,
			includeDeclaration: true,
		});

		return {
			label,
			caseId: caseSpec.id,
			caseLabel: caseSpec.label,
			position: { offset: caseSpec.offset, line: pos.line, col: pos.offset },
			definitionAndBoundSpan: {
				success: defBound?.success,
				message: defBound?.message,
				body: defBound?.body,
				defs: normalizeDefs(defBound?.body),
				boundSpan: normalizeBoundSpan(defBound?.body),
			},
			definition: {
				success: defOnly?.success,
				message: defOnly?.message,
				body: defOnly?.body,
				defs: normalizeDefs(defOnly?.body),
			},
			references: {
				success: refs?.success,
				message: refs?.message,
				body: refs?.body,
				refs: normalizeRefs(refs?.body),
			},
		};
	});
}

console.log('fixture:', mainVue);
console.log('TNB:', fs.realpathSync(tnbPath));
console.log('STOCK:', stockPath);

if (!fs.existsSync(stockPath)) {
	console.error(`Stock tsserver missing: ${stockPath}`);
	process.exit(1);
}

/** @type {Record<string, { tnb: any; stock: any }>} */
const results = {};

for (const caseSpec of CASES) {
	const pos = offsetToLineCol(fileContent, caseSpec.offset);
	console.log(`\n=== case ${caseSpec.id} (${caseSpec.label}) offset=${caseSpec.offset} line=${pos.line} col=${pos.offset} ===`);
	const tnb = await runCase('TNB', tnbPath, tnbHarnessEnv(), caseSpec);
	const stock = await runCase('STOCK', stockPath, process.env, caseSpec);
	results[caseSpec.id] = { tnb, stock };

	const defDiff = defKey(tnb.definition.defs) === defKey(stock.definition.defs) ? 'MATCH' : 'DIFF';
	const refDiff = refKey(tnb.references.refs) === refKey(stock.references.refs) ? 'MATCH' : 'DIFF';

	console.log(`TNB  definition: count=${tnb.definition.defs.length} success=${tnb.definition.success}`);
	console.log(`STOCK definition: count=${stock.definition.defs.length} success=${stock.definition.success}`);
	console.log(`definition diff: ${defDiff}`);
	console.log(`TNB  references: count=${tnb.references.refs.length}`);
	console.log(`STOCK references: count=${stock.references.refs.length}`);
	console.log(`references diff: ${refDiff}`);

	if (defDiff === 'DIFF') {
		console.log('\n--- definition JSON diff ---');
		console.log(JSON.stringify({
			tnb: tnb.definition.defs,
			stock: stock.definition.defs,
		}, null, 2));
	}
}

console.log('\n=== matrix ===');
const matrix = CASES.map(c => {
	const { tnb, stock } = results[c.id];
	return {
		case: c.id,
		tnbDefinition: tnb.definition.defs.length,
		stockDefinition: stock.definition.defs.length,
		defMatch: defKey(tnb.definition.defs) === defKey(stock.definition.defs),
		tnbRefs: tnb.references.refs.length,
		stockRefs: stock.references.refs.length,
		refMatch: refKey(tnb.references.refs) === refKey(stock.references.refs),
		tnbDefFile: tnb.definition.defs[0]?.file,
		stockDefFile: stock.definition.defs[0]?.file,
		tnbDefStart: tnb.definition.defs[0]?.start,
		stockDefStart: stock.definition.defs[0]?.start,
	};
});
console.log(JSON.stringify(matrix, null, 2));

const indexMatch = matrix.find(r => r.case === 'index')?.defMatch;
const layer = indexMatch === false && matrix.find(r => r.case === 'index')?.tnbDefinition === 0
	? 'TNB tsserver layer — definition empty, references may work'
	: indexMatch === false
		? 'TNB tsserver layer — definition mismatch'
		: 'tsserver parity';
console.log('\n=== layer verdict ===');
console.log(layer);

if (dumpPath) {
	fs.writeFileSync(dumpPath, JSON.stringify({ results, matrix, layer }, null, 2));
	console.log(`\nWrote ${dumpPath}`);
}
