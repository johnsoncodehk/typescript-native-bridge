/**
 * Shared quickinfo dual-diff helper for family-1 witnesses.
 * Always uses withTsserver; never spawn ad-hoc tsserver.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

export const volarRoot = resolveVolarRoot();
export const tw = path.join(volarRoot, 'test-workspace');
export const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
export const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
export const pluginProbe = path.join(volarRoot, 'packages/language-server');

export const harnessArgsVue = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins',
	'@vue/typescript-plugin',
	'--pluginProbeLocations',
	pluginProbe,
	'--suppressDiagnosticEvents',
];

export const harnessArgsPlain = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

export function twFile(rel) {
	return path.join(tw, rel);
}

export function summarizeQi(qi) {
	const body = qi?.body;
	return {
		success: !!qi?.success,
		message: String(qi?.message ?? '').slice(0, 400),
		displayString: body?.displayString ?? null,
		kind: body?.kind ?? null,
		documentation: body?.documentation ?? null,
		tags: body?.tags ?? null,
	};
}

/**
 * @param {{ file: string, line: number, offset: number, projectRoot?: string, content?: string, vue?: boolean, label?: string }} pos
 */
export async function quickinfoBoth(pos) {
	const file = pos.file;
	const content = pos.content ?? fs.readFileSync(file, 'utf8');
	const projectRoot = pos.projectRoot ?? tw;
	const args = pos.vue === false ? harnessArgsPlain : harnessArgsVue;
	const run = async (label, tsserverPath, env) =>
		withTsserver({ tsserverPath, args, env, deadlineMs: 120_000 }, async ({ send }) => {
			await send('configure', { preferences: {} });
			await send('updateOpen', {
				changedFiles: [],
				closedFiles: [],
				openFiles: [{ file, fileContent: content, projectRootPath: projectRoot }],
			});
			let qi;
			try {
				qi = await send('quickinfo', { file, line: pos.line, offset: pos.offset }, 60_000);
			} catch (e) {
				qi = { success: false, message: String(e?.message ?? e) };
			}
			return { label, ...summarizeQi(qi) };
		});
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
	const stock = await run('STOCK', stockPath, process.env);
	return { pos, tnb, stock };
}

export function printQiDiff(title, { pos, tnb, stock }) {
	const match =
		tnb.success === stock.success &&
		tnb.displayString === stock.displayString &&
		tnb.kind === stock.kind &&
		(tnb.documentation ?? '') === (stock.documentation ?? '');
	console.log(`\n=== ${title} ===`);
	console.log(`file=${pos.file}`);
	console.log(`pos=${pos.line}:${pos.offset} verdict=${match ? 'MATCH' : 'DIFF'}`);
	console.log(`--- TNB success=${tnb.success} kind=${JSON.stringify(tnb.kind)} ---`);
	console.log(tnb.displayString ?? '(null)');
	if (tnb.documentation) console.log(`docs=${JSON.stringify(tnb.documentation)}`);
	if (!tnb.success && tnb.message) console.log(`msg=${tnb.message}`);
	console.log(`--- STOCK success=${stock.success} kind=${JSON.stringify(stock.kind)} ---`);
	console.log(stock.displayString ?? '(null)');
	if (stock.documentation) console.log(`docs=${JSON.stringify(stock.documentation)}`);
	if (!stock.success && stock.message) console.log(`msg=${stock.message}`);
	return match;
}
