#!/usr/bin/env node
/**
 * Issue #77: one deep structural comparison must not poison later ones. The
 * pinned tsgo's relater keyed recursion identities on the outer type only, so
 * a 40-deep interface chain (A_i.next?: A_{i+1}[]) was never cut as deeply
 * nested; the comparison ran into the stack-depth limit, reported TS2321, and
 * cached its failed sub-relations — a later, unrelated assignment inside the
 * same chain then failed with TS2322. Stock 6.0.3 and tsgo main (after
 * typescript-go#4913, carried here as the tsgo-relater-recursion-identity
 * stopgap) report nothing. Both assignment orders run, since the cache
 * poisoning is order-dependent.
 *
 * The chain cases run through stock tsc and the fork's tsc; stock must exit
 * clean (the fixture is still the bug's shape) and the fork's diagnostic
 * headers must equal stock's. The GetByString conditional-type chain
 * (typescript-go#2917, the same recursion-identity path) exhausts stock's
 * heap, so its reference is tsgo main's conformance baseline — no
 * .errors.txt, i.e. clean — and only the fork runs.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkTsc = path.join(repoRoot, 'lib', 'tsc.js');
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const stockTsc = path.join(path.dirname(stockTsPath), 'tsc.js');
if (!fs.existsSync(stockTsc)) {
	console.error(`stock tsc not found at ${stockTsc} — set STOCK_TYPESCRIPT_PATH or STOCK_TSSERVER_PATH`);
	process.exit(1);
}

const DEPTH = 40;
const chain = prefix => Array.from({ length: DEPTH }, (_, i) =>
	`interface ${prefix}${i} {\n  name: string;\n  next?: ${prefix}${(i + 1) % DEPTH}[];\n}\n`).join('');
const CHAINS = chain('A') + chain('B');
const HEAD = 'declare const a: A0;\nconst assigned: B0 = a;\n';
const MID = 'declare const a20: A20;\nconst mid: B20 = a20;\n';

const GET_BY_STRING = `export type FlattenKeys<O> = {
	[K in keyof O & (string | number)]: O[K] extends Record<any, any>
		? K | \`\${K}.\${FlattenKeys<O[K]>}\`
		: K;
}[O extends readonly any[]
	? keyof O & \`\${number}\`
	: keyof O & (string | number)];
export type KeySeparator = '.' | '[' | ']';
export type GetByString<
	Data,
	Path extends string | number = FlattenKeys<Data>,
> = Path extends \`__proto__\${\`\${KeySeparator}\${string | number}\` | ''}\`
	? never
	: Path extends \`\${KeySeparator}\${infer Rest}\`
		? GetByString<Data, Rest>
		: Path extends \`\${infer Rest}\${KeySeparator}\`
			? GetByString<Data, Rest>
			: Path extends \`\${infer Key extends keyof Data & (string | number)}\${KeySeparator}\${infer Rest}\`
				? GetByString<Data[Key], Rest>
				: Path extends keyof Data & (string | number)
					? Data[Path]
					: undefined;
interface Duck {
	taxonomy: {
		genus: 'anas';
		species: 'platyrhynchos';
	};
}
export type DuckSpecies = GetByString<Duck, 'taxonomy.species'>;
export const species: DuckSpecies = 'platyrhynchos';
`;

const cases = [
	{ name: 'chain-head-then-mid', source: CHAINS + HEAD + MID + 'export {};\n', stock: true },
	{ name: 'chain-mid-then-head', source: CHAINS + MID + HEAD + 'export {};\n', stock: true },
	{ name: 'get-by-string', source: GET_BY_STRING, stock: false },
];

// Diagnostic headers only (tsgo renders shallower elaborations than stock by
// design); a clean run is exit 0 with no headers, so a crash never reads clean.
function run(tscJs, cwd) {
	const r = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd, encoding: 'utf8', env: { ...process.env, GODEBUG: 'asyncpreemptoff=1' } });
	if (r.error) throw r.error;
	const out = (r.stdout ?? '').replaceAll(cwd.replaceAll('\\', '/'), '.').replaceAll('\\', '/');
	const headers = out.split('\n').filter(l => l.trim() && !/^\s/.test(l)).join('\n');
	return r.status === 0 ? headers : `exit ${r.status ?? r.signal}\n${headers}\n${r.stderr.slice(-500)}`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-deep-relation-'));
let failed = 0;
for (const c of cases) {
	const dir = path.join(root, c.name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, 'src.ts'), c.source);
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', types: [] }, files: ['src.ts'] }));
	const stock = c.stock ? run(stockTsc, dir) : '';
	const fork = run(forkTsc, dir);
	if (stock) {
		console.error(`FAIL ${c.name}: stock is no longer clean — fixture is stale.\n${stock}`);
		failed++;
	} else if (fork) {
		console.error(`FAIL ${c.name}: fork is not clean (reference: ${c.stock ? 'stock' : 'tsgo main'}).\n${fork}`);
		failed++;
	} else {
		console.log(`ok ${c.name} (clean, reference: ${c.stock ? 'stock' : 'tsgo main'})`);
	}
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`FAIL: ${failed}/${cases.length} deep-relation cases diverged`);
	process.exit(1);
}
console.log(`PASS: all ${cases.length} deep-relation cases clean`);
