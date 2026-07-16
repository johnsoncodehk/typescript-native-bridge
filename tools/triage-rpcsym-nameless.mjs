#!/usr/bin/env node
/**
 * Audit the resolveRpcSymbol / tsgoSymbolForHostDeclaration reverse-mapping
 * class of bugs: host symbols whose declarations have NO name node
 * (ExportAssignment was one instance — fixed). Hover each witness site in
 * TNB and stock and diff the quickinfo display.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const dir = '/tmp/tnb-nameless-fixture';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);

write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'esnext' } }, null, 2));
write('anonclass.ts', `export default class {\n\tm(): number { return 1; }\n}\n`);
write('anonfunc.ts', `export default function () {\n\treturn { tag: "anonfunc" };\n}\n`);
write('ctor.ts', `export class Widget {\n\tconstructor(size: number) {}\n}\nnew Widget(1);\n`);
write('computed.ts', `const key = "kk" as const;\nexport const obj = { [key]: 123 };\nobj.kk;\n`);
write('objlit.ts', `const box = { width: 1, height: 2 };\nbox.width;\n`);
write('callsig.ts', `interface Callable {\n\t(x: string): number;\n\tnew (y: number): Date;\n\t[idx: string]: unknown;\n}\ndeclare const c: Callable;\nc("a");\n`);
write('importer.ts', `import AnonClass from "./anonclass";\nimport anonFunc from "./anonfunc";\nnew AnonClass().m();\nanonFunc();\n`);

// line/offset are 1-based tsserver coordinates.
const SITES = [
	{ file: 'anonclass.ts', line: 1, offset: 8, label: 'default-kw of `export default class {}`' },
	{ file: 'anonclass.ts', line: 1, offset: 16, label: 'class-kw of anonymous default class' },
	{ file: 'anonfunc.ts', line: 1, offset: 8, label: 'default-kw of `export default function () {}`' },
	{ file: 'anonfunc.ts', line: 1, offset: 16, label: 'function-kw of anonymous default function' },
	{ file: 'ctor.ts', line: 2, offset: 2, label: 'constructor keyword' },
	{ file: 'ctor.ts', line: 4, offset: 5, label: 'new Widget(1) call site' },
	{ file: 'computed.ts', line: 2, offset: 21, label: 'computed member name [key]' },
	{ file: 'computed.ts', line: 3, offset: 5, label: 'obj.kk access' },
	{ file: 'objlit.ts', line: 2, offset: 5, label: 'box.width access' },
	{ file: 'callsig.ts', line: 6, offset: 1, label: 'call of call-signature interface' },
	{ file: 'importer.ts', line: 1, offset: 8, label: 'import AnonClass (default import of anon class)' },
	{ file: 'importer.ts', line: 2, offset: 8, label: 'import anonFunc (default import of anon func)' },
	{ file: 'importer.ts', line: 3, offset: 5, label: 'new AnonClass() usage' },
	{ file: 'importer.ts', line: 4, offset: 1, label: 'anonFunc() usage' },
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

const filter = process.env.SITE_FILTER;
if (filter) {
	const keep = SITES.filter(s => s.label.includes(filter) || s.file.includes(filter));
	SITES.length = 0;
	SITES.push(...keep);
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = !process.env.SKIP_STOCK && fs.existsSync(stockPath) ? await run('STOCK', stockPath, process.env) : new Map();

let diffs = 0;
for (const site of SITES) {
	const a = tnb.get(site.label) ?? '<none>';
	const b = stock.get(site.label) ?? '<no-stock>';
	const same = a === b;
	if (!same) diffs++;
	console.log(`${same ? 'MATCH' : 'DIFF '} ${site.label}`);
	if (!same) {
		console.log(`   tnb  : ${a.slice(0, 140)}`);
		console.log(`   stock: ${b.slice(0, 140)}`);
	}
}
console.log(`\nsites=${SITES.length} diffs=${diffs}`);
