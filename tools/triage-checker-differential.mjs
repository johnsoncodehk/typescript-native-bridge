#!/usr/bin/env node
/**
 * Checker-API stock differential gate.
 *
 * Checker-layer behavior parity with stock `typescript` is a hard constraint,
 * but divergences so far surfaced only via user reports (#18/#20/#22/#23/#26/
 * #27). This probe internalizes discovery: one self-contained corpus
 * (mkdtemp, no node_modules) is type-checked twice — stock 6.0.3 and the TNB
 * fork through the watch/builder program path (the typescript-estree flavor
 * where the bridge serves every checker call) — and every queried checker
 * result must canonicalize byte-equal.
 *
 * Coverage: getTypeAtLocation / typeToString, getSymbolAtLocation,
 * getImmediateAliasedSymbol / getAliasedSymbol chains, getPropertiesOfType /
 * getPropertyOfType / Type.getApparentProperties, Type.getCallSignatures /
 * getConstructSignatures (param+return typeToString, signatureToString),
 * getBaseConstraintOfType / Type.getConstraint, getExportsOfModule,
 * resolveExternalModuleName, getTypeOfSymbolAtLocation /
 * getDeclaredTypeOfSymbol.
 *
 * Corpus features: plain module, default export + named/default re-export
 * chains, `export =` (separate cjs config), ambient module declaration,
 * phantom declaration (`Comp.d.vue.ts` beats the literal `./Comp.vue` SFC,
 * the issue #26 pattern), union/literal/template-literal types,
 * generic/conditional types, interface/class inheritance, enum + const enum.
 *
 * Both sides run the identical driver (createWatchProgram + abstract builder)
 * on the identical tsconfig set. Every query is wrapped: a thrown error
 * canonicalizes to { $err } so "both sides throw the same" is parity.
 * Declarations canonicalize to [basename, kind] for lib files (bundled libs
 * differ from stock in doc comments only, which shifts node positions) and
 * [basename, kind, pos] inside the corpus (byte-identical by construction).
 *
 * Canon normalizations (compare semantics, not bookkeeping — each measured
 * from a real run, not speculated):
 *   N1  type.objectFlags &= 0x7FFF — stock lazily stamps analysis/cache bits
 *       (PrimitiveUnion, CouldContainTypeVariablesComputed, IdenticalBaseType*,
 *       IsGenericType*, …, all ≥ 1<<15) that tsgo never computes. Bits 0..14
 *       (Class/Interface/Reference/Tuple/Anonymous/Mapped/Instantiated/
 *       ObjectLiteral/EvolvingArray/JSLiteral/FreshLiteral/ArrayLiteral/…)
 *       are semantic and stay compared; the enum-remap gate covers the wiring.
 *   N2  symbol.flags &= ~SymbolFlags.Transient — stock marks merged member
 *       clones Transient (constructor parameter properties, some lib members);
 *       tsgo only sets it on some of those paths. Name/type/declarations of
 *       the member are unaffected.
 *   N3  well-known symbol names normalize `__@x@<n>` → `__@x@` — the suffix is
 *       a global symbol-creation counter (`__@iterator@104` vs `__@iterator@59`
 *       on identical programs); two checkers can never agree on it. The symbol
 *       kind stays compared.
 *
 * Known divergences live in KNOWN_DIVERGENCES keyed `method@label`, grouped by
 * attribution class:
 *   U1  union constituent order — tsgo normalizes union members by type id
 *       (upstream issue #20 behavior), stock keeps declaration order.
 *   U2  member-list ordering — tsgo returns symbols in its own table/sort
 *       order (CompareSymbols by symbol id), stock in resolution order; same
 *       upstream class as U1, for symbol lists. Includes the visible tail of
 *       typeToString truncation ("… N more …; lastMember") which follows
 *       member order.
 *   U3  import-require alias chains — tsgo's immediateTarget walks through the
 *       `export=` alias symbol (2 hops); stock's immediateTarget resolves
 *       export= in one hop. tsgo alias-model difference.
 *   L   bundled-lib delta — TNB's libs track the fork (post-6.0.3), stock is
 *       the 6.0.3 release: padStart/padEnd parameter names
 *       (targetLength/padString vs maxLength/fillString) in String member
 *       type strings. Content-identical otherwise (check-lib-sync scope).
 * A key whose sides converged FAILS as stale so the list cannot rot — when a
 * B-class entry gets fixed, the gate demands its removal.
 *
 * Usage: node tools/triage-checker-differential.mjs
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbTsPath = path.join(repoRoot, 'lib', 'typescript.js');
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';

// ── Known divergences (method@label → class reason; see header) ────────────
// Entries are added only after reproducing the divergence and attributing it
// (upstream tsgo behavior / lib delta, or a tracked TNB-side bug). A stale
// entry (sides converged) fails the gate so fixed bugs force list cleanup.
const REASON = {
	U1: 'U1: tsgo union constituent order (upstream issue #20), stock declaration order',
	U2: 'U2: tsgo member/symbol ordering (upstream, same class as #20)',
	U2T: 'U2: member-order-dependent typeToString truncation tail (upstream #20 class)',
	U3: 'U3: tsgo keeps export= as an alias hop; stock immediateTarget resolves it (upstream alias model)',
	LU2: 'L+U2: bundled-lib padStart/padEnd parameter rename + tsgo member order',
};
const KNOWN_DIVERGENCES = new Map((() => {
	const keys = [];
	const add = (reason, methods, points) => {
		for (const m of methods) for (const at of points) keys.push([`${m}@${at}`, reason]);
	};
	// U1 — union order in type strings
	add(REASON.U1,
		['getTypeAtLocation', 'typeToString', 'typeToString[NoTrunc]', 'getApparentType', 'getBaseConstraintOfType', 'Type.getConstraint', 'getDeclaredTypeOfSymbol'],
		['types.ts:Tpl-decl']);
	add(REASON.U1,
		['getTypeAtLocation', 'typeToString', 'typeToString[NoTrunc]', 'getApparentType', 'getBaseConstraintOfType', 'Type.getConstraint', 'getTypeOfSymbolAtLocation'],
		['types.ts:tplVal-decl']);
	add(REASON.U1,
		['getApparentType', 'getBaseConstraintOfType', 'Type.getConstraint'],
		['types.ts:Cond-decl']);
	// U2 — member-list ordering
	add(REASON.U2, ['getApparentProperties'], [
		'util.ts:add-decl', 'util.ts:fetchData-decl', 'types.ts:Lit-decl', 'types.ts:rex-decl', 'types.ts:Dog-ctor-use',
		'types.ts:identity-decl', 'types.ts:overloaded-decl', 'consumer.ts:add-import', 'consumer.ts:add-use',
		'consumer.ts:Def-import', 'consumer.ts:DefRe-import', 'consumer.ts:DefAlias-import', 'consumer.ts:plus-import',
		'consumer.ts:plus-use', 'consumer.ts:utilNs-import', 'consumer.ts:utilNs-use', 'consumer.ts:identity-use',
		'consumer.ts:overloaded-use', 'consumer.ts:Factory-use', 'cjs/use.ts:Equal-import', 'cjs/use.ts:EqualAlias-export',
	]);
	add(REASON.U2, ['getPropertiesOfType'], [
		'consumer.ts:utilNs-import', 'consumer.ts:utilNs-use', 'consumer.ts:Factory-use',
	]);
	add(REASON.U2T, ['getPropertiesOfType', 'getApparentProperties'], ['types.ts:lang-elemaccess']);
	// L+U2 — String-interface member lists: padStart/padEnd lib delta + iterator position
	add(REASON.LU2, ['getPropertiesOfType', 'getApparentProperties'], [
		'util.ts:key-param', 'types.ts:Tpl-decl', 'types.ts:Cond-decl', 'types.ts:litVal-decl',
		'types.ts:tplVal-decl', 'types.ts:condVal-decl', 'types.ts:Dir-decl', 'types.ts:first-x',
		// withDerived-P's constraint is a string-literal union → apparent String
		// members; was masked by the #30 any-result (B2), the fix surfaced LU2.
		'types.ts:withDerived-P',
	]);
	// U3 — import-require alias chain shape
	add(REASON.U3, ['getImmediateAliasedSymbol.chain'], ['cjs/use.ts:Equal-import', 'cjs/use.ts:EqualAlias-export']);
	// U2 — post-B1-fix residual: getExportsOfModule membership is byte-equal
	// (export* merged, export= resolved via the RPC fall-through); only tsgo's
	// symbol-table order differs.
	add(REASON.U2, ['getExportsOfModule'], ['consumer.ts:spec-reexport', 'reexport.ts:module']);
	return keys;
})());

// ── Corpus ─────────────────────────────────────────────────────────────────
const MAIN_TSCONFIG = {
	compilerOptions: {
		target: 'es2022', lib: ['es2022'], module: 'esnext', moduleResolution: 'bundler',
		strict: true, noEmit: true, skipLibCheck: true, types: [], allowArbitraryExtensions: true,
	},
	include: ['*.ts'],
};
const CJS_TSCONFIG = {
	compilerOptions: {
		target: 'es2022', lib: ['es2022'], module: 'commonjs', moduleResolution: 'node10',
		strict: true, noEmit: true, skipLibCheck: true, types: [],
	},
	files: ['cjs/equal.ts', 'cjs/use.ts'],
};
const CORPUS = {
	'util.ts': `export function add(a: number, b: number): number { return a + b; }
export interface Shape { id: string; n: number; }
export class Box<T extends object> {
  constructor(readonly value: T) {}
  map<U extends object>(fn: (v: T) => U): Box<U> { return new Box(fn(this.value)); }
}
export async function fetchData(key: string): Promise<string> { return key; }
export const boxed = new Box({ k: 1 });
`,
	'def.ts': `export default class Def {
  constructor(readonly label: string) {}
  describe(): string { return this.label; }
}
export const defVersion = 1;
`,
	'reexport.ts': `export { default } from './def.js';
export { default as DefAlias } from './def.js';
export * from './util.js';
export { add as plus } from './util.js';
`,
	'types.ts': `export type Lit = 'a' | 'b' | 42;
export type Tpl = \`pfx-\${Lit}\`;
export type Cond<T> = T extends string ? 'str' : T extends number ? 'num' : 'other';
export type Mapped<T> = { readonly [K in keyof T]: T[K] };
export interface Entity<K extends string = string> { id: K; tags: string[]; describe?(prefix: string): string }
export class Animal { constructor(public name: string) {} move(d: number): number { return d; } }
export class Dog extends Animal { bark(): string { return 'woof'; } }
export enum Color { Red = 1, Green = 2, Blue = 4 }
export const enum Dir { Up = 'U', Down = 'D' }
export function identity<T extends Entity>(x: T): T { return x; }
export function first<T extends string>(x: T): T { return x; }
export function overloaded(a: string): number;
export function overloaded(a: number): string;
export function overloaded(a: unknown): unknown { return a; }
export class Factory {
  private constructor(readonly x: number) {}
  static create(x: number): Factory { return new Factory(x); }
}
const OBJ = { a: ['x'], b: ['y', 'z'] } as const;
type Key = keyof typeof OBJ;
export function withDerived<P extends Key>(lang: [P, (typeof OBJ)[P][number]]): string { return String(lang[1]); }
export const unionVal: string | number | null = 's';
export const litVal = 'hello' as const;
export const numVal = 42 as const;
export const tplVal: Tpl = 'pfx-a';
export const condVal: Cond<'x'> = 'str';
export const mapped: Mapped<Entity<'m'>> = { id: 'm', tags: [] };
export const rex = new Dog('rex');
export const favorite: Color = Color.Green;
export const dir: Dir = Dir.Up;
`,
	'ambient.d.ts': `declare module 'ambient-pkg' {
  export function aFn(input: string): number;
  export interface AShape { a: string }
}
`,
	'Comp.vue': `declare const sfc: { sfc: true };
export default sfc;
`,
	'Comp.d.vue.ts': `export interface Comp { marker: 'd-vue' }
declare const sfc: { sfc: true };
export default sfc;
`,
	'consumer.ts': `import { add } from './util.js';
import Def from './def.js';
import DefRe, { DefAlias, plus } from './reexport.js';
import * as utilNs from './util.js';
import type { AShape } from 'ambient-pkg';
import type { Comp } from './Comp.vue';
import { identity, overloaded, Factory } from './types.js';

export const total = add(1, 2);
export const inst = new Def('d');
export const inst2 = new DefRe('d2');
export const inst3 = new DefAlias('d3');
export const sum = plus(3, 4);
export const nsSum = utilNs.add(5, 6);
export const ashape: AShape = { a: 'x' };
export const comp: Comp = { marker: 'd-vue' };
export const idOut = identity({ id: 'e', tags: [] });
export const ov = overloaded('s');
export const made = Factory.create(7);
`,
	'cjs/equal.ts': `class Equal {
  constructor(readonly v: number) {}
  method(): string { return \`v=\${this.v}\`; }
}
export = Equal;
`,
	'cjs/use.ts': `import Equal = require('./equal');
export const e = new Equal(1);
export const s = e.method();
export { Equal as EqualAlias };
`,
};

// ── Probe points ───────────────────────────────────────────────────────────
// needle: unique text whose START is the token to query (occ disambiguates).
// kind: optional SyntaxKind name filter. props: getPropertyOfType names.
// spec: true → module-specifier battery (resolveExternalModuleName chain).
const POINTS = [
	// plain module decls
	{ proj: 'main', file: 'util.ts', label: 'util.ts:add-decl', needle: 'add(a: number' },
	{ proj: 'main', file: 'util.ts', label: 'util.ts:Shape-decl', needle: 'Shape { id', props: ['id', 'n', 'nope'] },
	{ proj: 'main', file: 'util.ts', label: 'util.ts:Box-decl', needle: 'Box<T extends object>' },
	{ proj: 'main', file: 'util.ts', label: 'util.ts:boxed-decl', needle: 'boxed = new Box', props: ['value', 'map'] },
	{ proj: 'main', file: 'util.ts', label: 'util.ts:fetchData-decl', needle: 'fetchData(key' },
	{ proj: 'main', file: 'util.ts', label: 'util.ts:key-param', needle: 'key: string): Promise' },
	// union / literal / template-literal / conditional / mapped
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Lit-decl', needle: "Lit = 'a'" },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Tpl-decl', needle: 'Tpl = `pfx' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Cond-decl', needle: 'Cond<T> = T extends' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Mapped-decl', needle: 'Mapped<T> = { readonly' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Entity-decl', needle: 'Entity<K extends string', props: ['id', 'tags', 'describe'] },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:unionVal-decl', needle: "unionVal: string" },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:litVal-decl', needle: "litVal = 'hello'" },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:numVal-decl', needle: 'numVal = 42' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:tplVal-decl', needle: 'tplVal: Tpl' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:condVal-decl', needle: "condVal: Cond<'x'>" },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:mapped-decl', needle: "mapped: Mapped<Entity<'m'>>", props: ['id', 'tags'] },
	// interface / class / inheritance
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Animal-decl', needle: 'Animal { constructor' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:rex-decl', needle: "rex = new Dog", props: ['name', 'move', 'bark'] },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Dog-ctor-use', needle: "new Dog('rex')" },
	// enum / const enum
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Color-decl', needle: 'Color { Red' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Color-member-use', needle: 'Color.Green' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Dir-decl', needle: "Dir { Up" },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Dir-member-use', needle: 'Dir.Up' },
	// generic / conditional / type-parameter constraint paths
	{ proj: 'main', file: 'types.ts', label: 'types.ts:identity-decl', needle: 'identity<T extends Entity>' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:identity-x', needle: 'x: T): T { return x' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:first-x', needle: 'x: T): T { return x', occ: 1 },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:withDerived-P', needle: 'P, (typeof OBJ)[P][number]' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:lang-elemaccess', needle: 'lang[1])' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:overloaded-decl', needle: 'overloaded(a: string): number' },
	{ proj: 'main', file: 'types.ts', label: 'types.ts:Factory-decl', needle: 'Factory {\n  private constructor', props: ['create'] },
	// consumer: alias chains + usages
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:add-import', needle: "add } from './util.js'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:add-use', needle: 'add(1, 2)' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:Def-import', needle: "Def from './def.js'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:DefRe-import', needle: 'DefRe, {' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:DefRe-use', needle: "new DefRe('d2')" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:DefAlias-import', needle: 'DefAlias, plus' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:plus-import', needle: "plus } from './reexport.js'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:plus-use', needle: 'plus(3, 4)' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:utilNs-import', needle: 'utilNs from' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:utilNs-use', needle: 'utilNs.add(5, 6)' },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:AShape-import', needle: "AShape } from 'ambient-pkg'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:Comp-import', needle: "Comp } from './Comp.vue'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:comp-use', needle: "comp: Comp = { marker", props: ['marker'] },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:identity-use', needle: "identity({ id: 'e'" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:overloaded-use', needle: "overloaded('s')" },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:Factory-use', needle: 'Factory.create(7)', props: ['create'] },
	// module specifiers → resolveExternalModuleName + getExportsOfModule
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-util', needle: "'./util.js'", spec: true },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-util-ns', needle: "'./util.js'", occ: 1, spec: true },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-def', needle: "'./def.js'", spec: true },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-reexport', needle: "'./reexport.js'", spec: true },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-ambient', needle: "'ambient-pkg'", spec: true },
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:spec-vue', needle: "'./Comp.vue'", spec: true },
	// module symbols of whole files
	{ proj: 'main', file: 'consumer.ts', label: 'consumer.ts:module', module: true },
	{ proj: 'main', file: 'reexport.ts', label: 'reexport.ts:module', module: true },
	// export= project
	{ proj: 'cjs', file: 'cjs/equal.ts', label: 'cjs/equal.ts:Equal-decl', needle: 'Equal {\n  constructor' },
	{ proj: 'cjs', file: 'cjs/equal.ts', label: 'cjs/equal.ts:module', module: true },
	{ proj: 'cjs', file: 'cjs/use.ts', label: 'cjs/use.ts:Equal-import', needle: "Equal = require('./equal')" },
	{ proj: 'cjs', file: 'cjs/use.ts', label: 'cjs/use.ts:Equal-use', needle: 'new Equal(1)' },
	{ proj: 'cjs', file: 'cjs/use.ts', label: 'cjs/use.ts:method-use', needle: 'e.method()' },
	{ proj: 'cjs', file: 'cjs/use.ts', label: 'cjs/use.ts:EqualAlias-export', needle: 'Equal as EqualAlias' },
	{ proj: 'cjs', file: 'cjs/use.ts', label: 'cjs/use.ts:spec-equal', needle: "'./equal'", spec: true },
];

// ── Side driver (child mode) ───────────────────────────────────────────────
function runSide(side, dir) {
	const ts = require2(side === 'stock' ? stockTsPath : tnbTsPath);
	const NOOP = () => {};
	const buildProgram = (configRel) => {
		const host = ts.createWatchCompilerHost(path.join(dir, configRel), {}, ts.sys, ts.createAbstractBuilder, NOOP, NOOP);
		host.watchFile = () => ({ close: NOOP });
		host.watchDirectory = () => ({ close: NOOP });
		host.setTimeout = undefined;
		host.clearTimeout = undefined;
		let builder;
		host.afterProgramCreate = b => { builder = b; };
		const watch = ts.createWatchProgram(host);
		return { watch, program: (builder ?? watch.getProgram()).getProgram() };
	};

	const programs = { main: buildProgram('tsconfig.json'), cjs: buildProgram('tsconfig.cjs.json') };
	const entries = [];
	const rec = (m, at, v) => entries.push({ m, at, v });

	for (const proj of ['main', 'cjs']) {
		const { program } = programs[proj];
		const checker = program.getTypeChecker();
		const isCorpusFile = p => path.dirname(p) === dir || path.dirname(p) === path.join(dir, 'cjs');

		const tryQ = fn => { try { const v = fn(); return v === undefined ? null : v; } catch (e) { return { $err: String(e?.message ?? e).slice(0, 200) }; } };
		// N3: well-known symbol names carry a global creation counter; module
		// symbol names carry the absolute path.
		const canonName = name => {
			if (typeof name !== 'string') return name;
			if (name.startsWith('"')) return '"' + path.basename(name.slice(1, -1)) + '"';
			return name.replace(/__@(\w+)@\d+/, '__@$1@');
		};
		const canonDecl = d => {
			try {
				const f = d.getSourceFile().fileName;
				// Bundled libs differ from stock in doc comments only — positions
				// inside them are not byte-stable, corpus positions are.
				return isCorpusFile(f) ? [path.basename(f), d.kind, d.pos] : [path.basename(f), d.kind];
			} catch { return ['<nodecl>']; }
		};
		// N2: Transient (1<<25) is merge/instantiation bookkeeping (see header).
		const TRANSIENT = 33554432;
		const canonSym = s => {
			if (s == null) return null;
			if (s.$err) return s;
			return {
				name: canonName(s.name), flags: (s.flags & ~TRANSIENT) >>> 0,
				decls: tryQ(() => (s.declarations ?? []).map(canonDecl)),
			};
		};
		// N1: only structural objectFlags bits 0..14 are comparable (see header).
		const canonType = t => {
			if (t == null) return null;
			if (t.$err) return t;
			return { s: tryQ(() => checker.typeToString(t)), f: t.flags >>> 0, of: (t.objectFlags ?? 0) & 0x7fff };
		};
		const canonProp = (s, locNode) => {
			if (s == null || s.$err) return canonSym(s);
			return { ...canonSym(s), t: tryQ(() => checker.typeToString(checker.getTypeOfSymbolAtLocation(s, locNode))) };
		};
		const canonSig = sig => {
			if (sig == null) return null;
			if (sig.$err) return sig;
			const decl = sig.declaration ?? null;
			const params = tryQ(() => sig.getParameters());
			return {
				str: tryQ(() => checker.signatureToString(sig)),
				decl: decl ? canonDecl(decl) : null,
				params: params?.$err ? params : (params ?? []).map(p => ({
					...canonSym(p),
					t: tryQ(() => checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl ?? p.valueDeclaration ?? p.declarations?.[0]))),
				})),
				ret: tryQ(() => checker.typeToString(checker.getReturnTypeOfSignature(sig))),
				tps: tryQ(() => (sig.typeParameters ?? []).map(canonType)),
			};
		};

		const srcOf = new Map();
		const sfOf = rel => {
			if (!srcOf.has(rel)) {
				const sf = program.getSourceFile(path.join(dir, rel));
				if (!sf) throw new Error(`no SourceFile for ${rel} (${side})`);
				srcOf.set(rel, { sf, text: sf.text ?? fs.readFileSync(path.join(dir, rel), 'utf8') });
			}
			return srcOf.get(rel);
		};
		const locate = point => {
			const { sf, text } = sfOf(point.file);
			let pos = -1;
			for (let i = 0; i <= (point.occ ?? 0); i++) {
				pos = text.indexOf(point.needle, pos + 1);
				if (pos < 0) throw new Error(`needle not found (${point.label} occ ${i}): ${JSON.stringify(point.needle)}`);
			}
			let found;
			const visit = n => {
				if (n.getStart(sf) === pos) found = n; // deepest match wins (DFS order)
				ts.forEachChild(n, visit);
			};
			visit(sf);
			if (!found) throw new Error(`no node at ${point.file}:${pos} (${point.label})`);
			return found;
		};

		const typeBattery = (t, at, node, props) => {
			rec('typeToString', at, tryQ(() => checker.typeToString(t)));
			rec('typeToString[NoTrunc]', at, tryQ(() => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation)));
			rec('getApparentType', at, canonType(tryQ(() => checker.getApparentType(t))));
			rec('getPropertiesOfType', at, tryQ(() => checker.getPropertiesOfType(t).map(p => canonProp(p, node))));
			rec('getApparentProperties', at, tryQ(() => t.getApparentProperties().map(p => canonProp(p, node))));
			rec('getCallSignatures', at, tryQ(() => t.getCallSignatures().map(canonSig)));
			rec('getConstructSignatures', at, tryQ(() => t.getConstructSignatures().map(canonSig)));
			rec('getBaseConstraintOfType', at, canonType(tryQ(() => checker.getBaseConstraintOfType(t))));
			rec('Type.getConstraint', at, canonType(tryQ(() => t.getConstraint?.())));
			for (const pn of props ?? []) rec(`getPropertyOfType(${pn})`, at, canonProp(tryQ(() => checker.getPropertyOfType(t, pn)), node));
		};
		const aliasBattery = (sym, at) => {
			if (!(sym.flags & ts.SymbolFlags.Alias)) return;
			rec('getAliasedSymbol', at, canonSym(tryQ(() => checker.getAliasedSymbol(sym))));
			const chain = [];
			let cur = sym;
			for (let i = 0; i < 8; i++) {
				const imm = tryQ(() => checker.getImmediateAliasedSymbol(cur));
				if (imm == null || imm.$err) { if (imm?.$err) chain.push(imm); break; }
				chain.push(canonSym(imm));
				if (!(imm.flags & ts.SymbolFlags.Alias)) break;
				cur = imm;
			}
			rec('getImmediateAliasedSymbol.chain', at, chain);
		};

		for (const point of POINTS) {
			if (point.proj !== proj) continue;
			const at = point.label;
			if (point.module) {
				const { sf } = sfOf(point.file);
				const modSym = tryQ(() => checker.getSymbolAtLocation(sf));
				rec('getSymbolAtLocation[module]', at, canonSym(modSym));
				if (modSym && !modSym.$err) {
					rec('getExportsOfModule', at, tryQ(() => checker.getExportsOfModule(modSym).map(p => canonProp(p, sf))));
					rec('getTypeOfSymbolAtLocation[module]', at, canonType(tryQ(() => checker.getTypeOfSymbolAtLocation(modSym, sf))));
				}
				continue;
			}
			const node = locate(point);
			if (point.spec) {
				const resolved = tryQ(() => checker.resolveExternalModuleName(node));
				rec('resolveExternalModuleName', at, canonSym(resolved));
				rec('getSymbolAtLocation[specifier]', at, canonSym(tryQ(() => checker.getSymbolAtLocation(node))));
				if (resolved && !resolved.$err) {
					rec('getExportsOfModule', at, tryQ(() => checker.getExportsOfModule(resolved).map(p => canonProp(p, node))));
				}
				continue;
			}
			const t = tryQ(() => checker.getTypeAtLocation(node));
			rec('getTypeAtLocation', at, canonType(t));
			if (t && !t.$err) typeBattery(t, at, node, point.props);
			const sym = tryQ(() => checker.getSymbolAtLocation(node));
			rec('getSymbolAtLocation', at, canonSym(sym));
			if (sym && !sym.$err) {
				rec('getTypeOfSymbolAtLocation', at, canonType(tryQ(() => checker.getTypeOfSymbolAtLocation(sym, node))));
				rec('getDeclaredTypeOfSymbol', at, canonType(tryQ(() => checker.getDeclaredTypeOfSymbol(sym))));
				aliasBattery(sym, at);
			}
		}
	}

	for (const p of Object.values(programs)) p.watch.close?.();
	return { side, entries };
}

// ── Compare (parent mode) ──────────────────────────────────────────────────
const stable = v => JSON.stringify(v, (k, x) => {
	if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)));
	return x;
});

function writeCorpus(dir) {
	for (const [rel, content] of Object.entries(CORPUS)) {
		const f = path.join(dir, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, content);
	}
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(MAIN_TSCONFIG, null, 2));
	fs.writeFileSync(path.join(dir, 'tsconfig.cjs.json'), JSON.stringify(CJS_TSCONFIG, null, 2));
}

function runChild(side, dir) {
	const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir], {
		env: { ...process.env, TNB_DIFF_SIDE: side },
		encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
	});
	if (res.status !== 0) {
		console.error(`child ${side} FAILED (status ${res.status})\n${res.stderr?.slice(-2000) ?? ''}\n${res.stdout?.slice(-2000) ?? ''}`);
		process.exit(1);
	}
	try {
		return JSON.parse(res.stdout.trim().split('\n').at(-1));
	} catch (e) {
		console.error(`child ${side}: unparseable output: ${e.message}\n${res.stdout.slice(-2000)}`);
		process.exit(1);
	}
}

function parentMain() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-checker-diff-'));
	writeCorpus(dir);
	const stock = runChild('stock', dir);
	const tnb = runChild('tnb', dir);
	console.log(`fixture: ${dir}`);
	console.log(`entries: stock=${stock.entries.length} tnb=${tnb.entries.length}`);

	let fail = 0;
	if (stock.entries.length !== tnb.entries.length) {
		console.error(`FAIL entry count mismatch (harness bug): stock=${stock.entries.length} tnb=${tnb.entries.length}`);
		process.exit(1);
	}
	let ok = 0, known = 0;
	for (let i = 0; i < stock.entries.length; i++) {
		const a = stock.entries[i], b = tnb.entries[i];
		const key = `${a.m}@${a.at}`;
		if (a.m !== b.m || a.at !== b.at) {
			console.error(`FAIL entry misalignment at #${i} (harness bug): stock=${key} tnb=${b.m}@${b.at}`);
			fail++;
			continue;
		}
		const sa = stable(a.v), sb = stable(b.v);
		const why = KNOWN_DIVERGENCES.get(key);
		if (sa === sb) {
			if (why !== undefined) {
				console.log(`FAIL ${key}: STALE EXEMPTION — sides converged, remove the KNOWN_DIVERGENCES entry (${why})`);
				fail++;
			} else ok++;
			continue;
		}
		if (why !== undefined) {
			known++;
			console.log(`KNOWN ${key} — ${why}`);
			console.log(`  stock: ${sa.slice(0, 400)}`);
			console.log(`  tnb  : ${sb.slice(0, 400)}`);
			continue;
		}
		fail++;
		console.log(`DIFF ${key}`);
		console.log(`  stock: ${sa.slice(0, 600)}`);
		console.log(`  tnb  : ${sb.slice(0, 600)}`);
	}
	console.log(`\nVERDICT: ${fail === 0 ? 'PASS' : 'FAIL'} (${ok} ok, ${known} known, ${fail} diffs)`);
	process.exit(fail === 0 ? 0 : 1);
}

if (process.env.TNB_DIFF_SIDE) {
	const out = runSide(process.env.TNB_DIFF_SIDE, process.argv[2]);
	fs.writeSync(1, JSON.stringify(out) + '\n');
	process.exit(0);
} else {
	parentMain();
}
