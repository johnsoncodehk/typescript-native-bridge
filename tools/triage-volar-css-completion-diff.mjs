#!/usr/bin/env node
/**
 * P3-0: compare TNB vs stock completionInfo on volar css.ts (EOF + Vue plugin).
 *
 * Stock tsserver: set STOCK_TSSERVER_PATH or unpack typescript@6.0.3 to
 * /tmp/stock-ts-p3 via:
 *   curl -L -o /tmp/typescript-6.0.3.tgz https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz
 *   mkdir -p /tmp/stock-ts-p3 && tar -xzf /tmp/typescript-6.0.3.tgz -C /tmp/stock-ts-p3
 *
 * Usage:
 *   node tools/triage-volar-css-completion-diff.mjs
 *   node tools/triage-volar-css-completion-diff.mjs --tnb-only
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = new Set(process.argv.slice(2));
const volarRoot = resolveVolarRoot();

const defaultStock = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const stockPath = process.env.STOCK_TSSERVER_PATH ?? defaultStock;
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function completionRun(label, tsserverPath, env) {
	const logs = [];
	return withTsserver({
		tsserverPath,
		args: harnessArgs,
		env,
		onEvent: ev => {
			if (ev?.event === 'log') logs.push(ev.body?.message ?? '');
		},
	}, async ({ send }) => {
		const timedSend = async (command, arguments_, timeoutMs = 60_000) => {
			const t0 = Date.now();
			try {
				const res = await send(command, arguments_, timeoutMs);
				console.log(`${label} ${command}: ${Date.now() - t0}ms ok=${res.success}`);
				return res;
			} catch (e) {
				console.log(`${label} ${command}: ${Date.now() - t0}ms ${e.message}`);
				throw e;
			}
		};
		await timedSend('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await timedSend('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
		});
		const t0 = Date.now();
		const comp = await timedSend('completionInfo', {
			file: testFile,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		const entries = comp?.body?.entries ?? [];
		const auto = entries.filter(e => e.source);
		const local = entries.filter(e => !e.source);
		const collectLog = logs.find(l => /collectAutoImports: resolved/.test(l));
		return {
			label,
			tsserverPath,
			completionInfoMs: Date.now() - t0,
			total: entries.length,
			auto: auto.length,
			local: local.length,
			names: new Set(entries.map(e => e.name)),
			collectLog,
		};
	});
}

function diffRuns(tnb, stock) {
	const onlyStock = [...stock.names].filter(n => !tnb.names.has(n)).sort();
	const onlyTnb = [...tnb.names].filter(n => !stock.names.has(n)).sort();
	const nodeLike = onlyStock.filter(n =>
		/^(access|readFile|Buffer|console|process|path|ref|Array|Abort)/.test(n),
	);
	return { onlyStock: onlyStock.length, onlyTnb: onlyTnb.length, nodeLikeMissing: nodeLike.length, nodeLikeSample: nodeLike.slice(0, 12) };
}

console.log('css.ts:', testFile);
console.log('TNB:', fs.realpathSync(tnbPath));

const tnb = await completionRun('TNB', tnbPath, tnbHarnessEnv());
console.log(`TNB entries=${tnb.total} auto=${tnb.auto} local=${tnb.local}`);

if (!args.has('--tnb-only')) {
	if (!fs.existsSync(stockPath)) {
		console.error(`Stock tsserver missing: ${stockPath}`);
		console.error('Use curl tarball (see script header) or set STOCK_TSSERVER_PATH.');
		process.exit(1);
	}
	console.log('STOCK:', stockPath);
	const stock = await completionRun('STOCK', stockPath, process.env);
	console.log(`STOCK entries=${stock.total} auto=${stock.auto} local=${stock.local}`);
	const diff = diffRuns(tnb, stock);
	console.log('\n=== diff ===');
	console.log(JSON.stringify({
		tnb: { total: tnb.total, auto: tnb.auto, local: tnb.local },
		stock: { total: stock.total, auto: stock.auto, local: stock.local },
		onlyStock: diff.onlyStock,
		onlyTnb: diff.onlyTnb,
		nodeLikeMissing: diff.nodeLikeMissing,
		nodeLikeSample: diff.nodeLikeSample,
	}, null, 2));
}
