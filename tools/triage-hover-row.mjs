#!/usr/bin/env node
/**
 * Triage: quickinfo (hover) for v-for row/index positions (#4577 main.vue).
 * Compares TNB vs stock tsserver through @vue/typescript-plugin.
 * Usage: node tools/triage-hover-row.mjs [--dump /tmp/out.json]
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

const vForOffset = fileContent.indexOf('v-for="(row, index)');
const slotOffset = fileContent.indexOf('<slot :row="row"');
/** @type {{ id: string; label: string; offset: number }[]} */
const CASES = [
	{ id: 'vforRow', label: 'v-for "(row, ..."', offset: vForOffset + 'v-for="('.length },
	{ id: 'vforIndex', label: 'v-for "..., index)"', offset: vForOffset + 'v-for="(row, '.length },
	{ id: 'interpIndex', label: '{{ index }}', offset: fileContent.indexOf('{{ index }}') + '{{ '.length },
	{ id: 'slotAttrRow', label: ':row attr name', offset: slotOffset + '<slot :'.length },
	{ id: 'slotExprRow', label: ':row="row" expr', offset: slotOffset + '<slot :row="'.length },
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

async function runAll(label, tsserverPath, env) {
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
		const out = {};
		for (const c of CASES) {
			const pos = offsetToLineCol(fileContent, c.offset);
			const res = await send('quickinfo', { file: mainVue, line: pos.line, offset: pos.offset });
			out[c.id] = {
				success: res?.success,
				message: res?.message,
				kind: res?.body?.kind,
				displayString: res?.body?.displayString,
				start: res?.body?.start,
				end: res?.body?.end,
			};
		}
		return out;
	});
}

console.log('fixture:', mainVue);
if (!fs.existsSync(stockPath)) {
	console.error(`Stock tsserver missing: ${stockPath}`);
	process.exit(1);
}

const tnb = await runAll('TNB', tnbPath, tnbHarnessEnv());
const stock = await runAll('STOCK', stockPath, process.env);

const matrix = CASES.map(c => ({
	case: c.id,
	label: c.label,
	tnbSuccess: tnb[c.id].success,
	stockSuccess: stock[c.id].success,
	tnbDisplay: tnb[c.id].displayString,
	stockDisplay: stock[c.id].displayString,
	match: JSON.stringify(tnb[c.id]) === JSON.stringify(stock[c.id]),
}));
console.log(JSON.stringify(matrix, null, 2));

const allMatch = matrix.every(r => r.match);
console.log(`\n=== verdict: ${allMatch ? 'PARITY' : 'DIFF PRESENT'} ===`);

if (dumpPath) {
	fs.writeFileSync(dumpPath, JSON.stringify({ tnb, stock, matrix }, null, 2));
	console.log(`Wrote ${dumpPath}`);
}
