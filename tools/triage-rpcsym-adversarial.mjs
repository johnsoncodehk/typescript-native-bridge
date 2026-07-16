#!/usr/bin/env node
/**
 * Planner adversarial probe for the SignatureFlags remap (4ff2c52):
 * a REAL abstract construct signature must still print `abstract new`
 * after the remap that removes the spurious one, and rest-parameter
 * display must survive the bit relayout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const dir = '/tmp/tnb-adversarial-fixture';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);

write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'esnext' } }, null, 2));
write('abs.ts', `export default abstract class {\n\tabstract m(): void;\n}\n`);
write('rest.ts', `export function spread(...xs: number[]): number { return xs.length; }\nspread(1, 2);\n`);
write('main.ts', `import Abs from "./abs";\nimport { spread } from "./rest";\nnew Abs();\nspread(3);\nconst ctor: abstract new () => object = class {};\n`);

const SITES = [
	{ file: 'main.ts', line: 3, offset: 5, label: 'new Abs() — REAL abstract must keep `abstract new`' },
	{ file: 'main.ts', line: 1, offset: 8, label: 'import Abs hover' },
	{ file: 'main.ts', line: 4, offset: 1, label: 'spread(3) rest-param signature' },
	{ file: 'main.ts', line: 5, offset: 7, label: 'abstract construct type var' },
];

const harnessArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];

async function run(label, serverPath, env) {
	const out = new Map();
	await withTsserver({ tsserverPath: serverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		for (const site of SITES) {
			const file = path.join(dir, site.file);
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: dir }] });
			let disp = '<fail>';
			try {
				const r = await send('quickinfo', { file, line: site.line, offset: site.offset }, 30_000);
				disp = r?.success ? String(r.body?.displayString ?? '').replace(/\s+/g, ' ') : `<unsuccessful:${r?.message ?? ''}>`;
			} catch (e) {
				disp = `<throw:${String(e?.message ?? e).slice(0, 60)}>`;
			}
			out.set(site.label, disp);
			await send('updateOpen', { changedFiles: [], closedFiles: [file], openFiles: [] });
		}
	});
	return out;
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = fs.existsSync(stockPath) ? await run('STOCK', stockPath, process.env) : new Map();

let diffs = 0;
for (const site of SITES) {
	const a = tnb.get(site.label) ?? '<none>';
	const b = stock.get(site.label) ?? '<no-stock>';
	const same = a === b;
	if (!same) diffs++;
	console.log(`${same ? 'MATCH' : 'DIFF '} ${site.label}`);
	console.log(`   tnb  : ${a.slice(0, 140)}`);
	if (!same) console.log(`   stock: ${b.slice(0, 140)}`);
}
console.log(`\nsites=${SITES.length} diffs=${diffs}`);
