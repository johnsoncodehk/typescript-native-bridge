#!/usr/bin/env node
/**
 * T4 witness f2qi-names: quickinfo name-form + optionality cluster, dual-side.
 *  - lit-hyphen   #2629/main.vue:2:7     STOCK 'data-test-id' quoted, TNB bare
 *  - lit-valid    #4649/main.vue:13:16   STOCK 'foo' quoted (as-written), TNB bare
 *  - colon-name   #3379/main.vue:7:10    STOCK "onUpdate:modelValue" quoted, TNB bare
 *  - optionality  #3672/child.vue:2:6    STOCK type?: "input", TNB type: 'input'
 *  - computed-sym adversarial { [sym]: 1 } — does the __computed gate fire?
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

// Adversarial computed/literal fixtures: plain .ts (no volar mapping noise).
const compFile = path.join(tw, 'tsc/f2qi-computed-probe.ts');
fs.writeFileSync(compFile, `declare const sym: unique symbol;\nconst o = { [sym]: 1 };\no[sym];\n`);
const litFile = path.join(tw, 'tsc/f2qi-lit-probe.ts');
fs.writeFileSync(litFile, `const p = { ["a b"]: 1 };\np["a b"];\n`);

const CASES = [
	['lit-hyphen', 'tsc/#2629/main.vue', 2, 7],
	['lit-valid', 'tsc/#4649/main.vue', 13, 16],
	['colon-name', 'tsc/#3379/main.vue', 7, 10],
	['optionality', 'tsc/#3672/child.vue', 2, 6],
	['computed-sym-use', compFile, 3, 3],
	['lit-ab-use', litFile, 2, 3],
];

async function run(label, tsserverPath, env, absFile, line, offset) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		const openFiles = [{ file: absFile, fileContent: fs.readFileSync(absFile, 'utf8'), projectRootPath: tw }];
		for (const extra of [compFile, litFile]) {
			if (absFile !== extra && fs.existsSync(extra)) openFiles.push({ file: extra, fileContent: fs.readFileSync(extra, 'utf8'), projectRootPath: tw });
		}
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('quickinfo', { file: absFile, line, offset });
		const body = resp?.body;
		return { label, success: !!resp?.success, displayString: body?.displayString ?? '', kind: body?.kind ?? '' };
	});
}

for (const [tag, rel, line, offset] of CASES) {
	const abs = path.isAbsolute(rel) ? rel : path.join(tw, rel);
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), abs, line, offset);
	const stock = await run('STOCK', stockPath, process.env, abs, line, offset);
	const verdict = tnb.success === stock.success && tnb.displayString === stock.displayString && tnb.kind === stock.kind ? 'MATCH' : 'DIFF';
	console.log(`=== ${tag} ${rel.replace(/.*test-workspace\//, '')}:${line}:${offset} ===`);
	console.log(`verdict=${verdict}`);
	console.log(`TNB  : ${JSON.stringify(tnb.displayString)} kind=${tnb.kind}`);
	console.log(`STOCK: ${JSON.stringify(stock.displayString)} kind=${stock.kind}`);
}

fs.unlinkSync(compFile);
fs.unlinkSync(litFile);
