#!/usr/bin/env node
/**
 * Type-payload exhaustiveness audit: every data field stock puts on a Type
 * must cross the bridge with an equal value, or carry an explicit exemption.
 *
 * The bridge serializes types field-by-field (proto.go newTypeResponse →
 * arena readType → vendored TypeObject), so a field stock has but the bridge
 * doesn't carry is invisible until a consumer trips over it — empty-string
 * literal value (#16), stale bool literal value bits (#19), missing
 * intrinsicName on `false` (#22), type-parameter constraint (#23) all shipped
 * that way. This probe turns that class from user-report-driven into
 * gate-driven: it walks a fixture covering every type class, takes each type
 * from stock 6.0.3 (plain createProgram) and from TNB (watch/builder path, so
 * types really cross the bridge — arena transport), then recursively diffs
 * the payload. Stock own-keys not in the audit table and not exempted FAIL —
 * a future stock field or bridge drop turns the gate red.
 *
 * Known reasonable differences are exempted inline with reasons
 * (STOCK_INTERNAL_KEYS / conditionalExemption / union multiset rule below).
 * Fields that cross lazily by design (typeArguments, constraint) are
 * cross-checked through the RPC path instead of being exempted blind.
 *
 * Out of scope: signature payloads (triage-adv6b-generic-sig) and
 * transport differential (triage-arena-parity). No reliable source-level
 * trigger for SubstitutionType was found (`T[number]` / `T[keyof T]` both
 * produce plain IndexedAccessType), so baseType/substConstraint are audited
 * on any visited type that carries them but have no dedicated site.
 *
 * Usage: node tools/triage-type-field-audit.mjs
 * Env:   STOCK_TSSERVER_PATH  override stock tsserver.js path (default /tmp/stock-ts-p3/...);
 *        stock typescript.js is resolved as its sibling.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const stockTsserver = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB
const tss = require2(path.join(path.dirname(stockTsserver), 'typescript.js')); // stock

// ── Fixture: one type class per site ─────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-type-audit-'));
const src = `declare const es: "";
declare const s: "text";
declare const n: 42;
declare const neg: -7;
declare const bi: 123n;
declare const f: false;
declare const t: true;
declare const tl: \`a-\${string}-b\`;
declare const u: "a" | 1 | false;
declare const inter: { a: 1 } & { b: "x" };
interface Box<T> { x: T; }
declare const box: Box<string>;
declare const arr: string[];
declare const tup: [string, number?];
declare const rtup: readonly [string, ...number[]];
declare const fn: <T extends string>(a: T, b?: number) => T;
enum E { A = 1, B = 2 }
enum SE { A = "a", B = "b" }
declare const e: E;
declare const ea: E.A;
declare const sea: SE.A;
declare const str: string;
declare const anyv: any;
declare const unkv: unknown;
declare const nev: never;
declare const und: undefined;
declare const nul: null;
declare const voidv: void;
declare const us: unique symbol;
const fresh = "hello";
type C<T> = T extends string ? 1 : 2;
declare function fc<T>(x: T): C<T>;
type M<T> = { [K in keyof T]?: T[K] };
declare function fm<T>(x: T): M<T>;
declare function fk<T>(x: T): keyof T;
declare function fu<T extends string>(x: T): Uppercase<T>;
declare function ftp<T extends string>(x: T): T;
declare function fia<T extends { a: string }>(x: T): T["a"];
interface ThisI { m(): this; }
`;
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
	include: ['a.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), src);

// Site specs: pick the same source node in each side's AST.
const SITES = [
	{ label: 'empty-string-literal', kind: 'decl', name: 'es' },
	{ label: 'string-literal', kind: 'decl', name: 's' },
	{ label: 'number-literal', kind: 'decl', name: 'n' },
	{ label: 'neg-number-literal', kind: 'decl', name: 'neg' },
	{ label: 'bigint-literal', kind: 'decl', name: 'bi' },
	{ label: 'false-literal', kind: 'decl', name: 'f' },
	{ label: 'true-literal', kind: 'decl', name: 't' },
	{ label: 'template-literal', kind: 'decl', name: 'tl' },
	{ label: 'union', kind: 'decl', name: 'u' },
	{ label: 'intersection', kind: 'decl', name: 'inter' },
	{ label: 'generic-object-ref', kind: 'decl', name: 'box' },
	{ label: 'array-ref', kind: 'decl', name: 'arr' },
	{ label: 'tuple', kind: 'decl', name: 'tup' },
	{ label: 'readonly-tuple', kind: 'decl', name: 'rtup' },
	{ label: 'function-type', kind: 'decl', name: 'fn' },
	{ label: 'enum', kind: 'decl', name: 'e' },
	{ label: 'enum-literal', kind: 'decl', name: 'ea' },
	{ label: 'string-enum-literal', kind: 'decl', name: 'sea' },
	{ label: 'intrinsic-string', kind: 'decl', name: 'str' },
	{ label: 'intrinsic-any', kind: 'decl', name: 'anyv' },
	{ label: 'intrinsic-unknown', kind: 'decl', name: 'unkv' },
	{ label: 'intrinsic-never', kind: 'decl', name: 'nev' },
	{ label: 'intrinsic-undefined', kind: 'decl', name: 'und' },
	{ label: 'intrinsic-null', kind: 'decl', name: 'nul' },
	{ label: 'intrinsic-void', kind: 'decl', name: 'voidv' },
	{ label: 'unique-symbol', kind: 'decl', name: 'us' },
	{ label: 'fresh-literal', kind: 'init', name: 'fresh' },
	{ label: 'conditional', kind: 'ret', name: 'fc' },
	{ label: 'mapped', kind: 'ret', name: 'fm' },
	{ label: 'index-keyof', kind: 'ret', name: 'fk' },
	{ label: 'string-mapping', kind: 'ret', name: 'fu' },
	{ label: 'type-parameter', kind: 'ret', name: 'ftp' },
	{ label: 'indexed-access', kind: 'ret', name: 'fia' },
	{ label: 'this-type', kind: 'thisRet' },
];

function makeStock() {
	const cfg = tss.readConfigFile(path.join(dir, 'tsconfig.json'), tss.sys.readFile);
	const parsed = tss.parseJsonConfigFileContent(cfg.config, tss.sys, dir);
	const program = tss.createProgram(parsed.fileNames, parsed.options);
	return { ts: tss, checker: program.getTypeChecker(), sf: program.getSourceFile(path.join(dir, 'a.ts')), close() {} };
}

function makeTnb() {
	const NOOP = () => {};
	const host = tsb.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, tsb.sys, tsb.createAbstractBuilder, NOOP, NOOP);
	host.watchFile = () => ({ close: NOOP });
	host.watchDirectory = () => ({ close: NOOP });
	host.setTimeout = undefined;
	host.clearTimeout = undefined;
	let builder;
	host.afterProgramCreate = b => { builder = b; };
	const watch = tsb.createWatchProgram(host);
	const program = (builder ?? watch.getProgram()).getProgram();
	return { ts: tsb, checker: program.getTypeChecker(), sf: program.getSourceFile(path.join(dir, 'a.ts')), close: () => watch.close?.() };
}

function findNode(ts, sf, spec) {
	if (spec.kind === 'decl' || spec.kind === 'init') {
		for (const st of sf.statements) {
			if (ts.isVariableStatement(st)) {
				for (const d of st.declarationList.declarations) {
					if (d.name.getText(sf) === spec.name) return spec.kind === 'decl' ? d.name : d.initializer;
				}
			}
		}
	}
	else if (spec.kind === 'ret') {
		for (const st of sf.statements) {
			if (ts.isFunctionDeclaration(st) && st.name?.getText(sf) === spec.name) return st.type;
		}
	}
	else if (spec.kind === 'thisRet') {
		let found;
		(function visit(n) { if (!found && n.kind === ts.SyntaxKind.ThisType) found = n; ts.forEachChild(n, visit); })(sf);
		if (found) return found;
	}
	throw new Error(`site node not found: ${JSON.stringify(spec)}`);
}

// ── Audit table ──────────────────────────────────────────────────────────
// Every stock own key must be in AUDITED_FIELDS or STOCK_INTERNAL_KEYS.
const AUDITED_FIELDS = new Set([
	'flags', 'objectFlags', 'value', 'intrinsicName', 'isThisType', 'readonly', 'fixedLength',
	'symbol', 'aliasSymbol',
	'target', 'freshType', 'regularType', 'objectType', 'indexType', 'checkType', 'extendsType', 'baseType', 'substConstraint',
	'type', // stock IndexType/StringMappingType field name — compared against the bridge's `target`
	'types', 'typeParameters', 'outerTypeParameters', 'localTypeParameters', 'aliasTypeArguments',
	'texts', 'elementFlags',
]);

// Stock own keys that are checker-internal or cross lazily by design. Each
// entry is the reason the bridge legitimately doesn't carry the field.
const STOCK_INTERNAL_KEYS = new Map(Object.entries({
	id: 'type identity is per-checker by construction',
	checker: 'back-reference to the checker, not payload',
	debugIntrinsicName: 'stock debug aid; intrinsicName (audited) carries the contract',
	origin: 'union/intersection reduction bookkeeping',
	mapper: 'instantiation bookkeeping; the instantiated shape is audited field-by-field',
	combinedMapper: 'instantiation bookkeeping; the instantiated shape is audited field-by-field',
	root: 'conditional-root back-reference; its payload (checkType/extendsType) is audited directly on the type',
	node: 'syntax back-reference; declarations cross on symbols, not types',
	declaration: 'mapped-type source internals',
	typeParameter: 'mapped-type source internals',
	members: 'structure cache; members cross via getPropertiesOfType/getSignaturesOfType RPC',
	properties: 'structure cache; members cross via getPropertiesOfType/getSignaturesOfType RPC',
	callSignatures: 'structure cache; members cross via getPropertiesOfType/getSignaturesOfType RPC',
	constructSignatures: 'structure cache; members cross via getPropertiesOfType/getSignaturesOfType RPC',
	indexInfos: 'structure cache; members cross via getPropertiesOfType/getSignaturesOfType RPC',
	declaredProperties: 'declared-member cache; crosses via the same RPCs as members',
	declaredCallSignatures: 'declared-member cache; crosses via the same RPCs as members',
	declaredConstructSignatures: 'declared-member cache; crosses via the same RPCs as members',
	declaredIndexInfos: 'declared-member cache; crosses via the same RPCs as members',
	instantiations: 'instantiation cache',
	resolvedTypeArguments: 'backing store of the typeArguments getter; type arguments cross via checker.getTypeArguments RPC (cross-checked per site)',
	propertyCache: 'property cache; property data crosses via RPC',
	propertyCacheWithoutObjectFunctionPropertyAugment: 'property cache; property data crosses via RPC',
	resolvedProperties: 'property cache; property data crosses via RPC',
	immediateBaseConstraint: 'base-constraint cache; constraint semantics cross via getConstraintOfType RPC',
	constraint: 'lazy TypeParameter field; crosses via getConstraint() RPC by design (issue #23) — cross-checked per site',
	default: 'lazy TypeParameter field; crosses via getDefault() RPC by design — same contract as constraint',
	accessFlags: 'internal indexed-access bitfield, not part of the public d.ts surface',
	indexFlags: 'internal index-type bitfield, not part of the public d.ts surface',
	resolvedIndexType: 'index-type resolution cache; the resolved form crosses via getConstraintOfType RPC',
	minLength: 'derivable from elementFlags (audited)',
	combinedFlags: 'derivable from elementFlags (audited)',
	hasRestElement: 'derivable from elementFlags (audited); deprecated upstream',
	labeledElementDeclarations: 'syntax back-references; declarations cross on symbols, not types',
	escapedName: 'internal name storage; symbol (audited) carries the name',
	thisType: "polymorphic-this mechanics on class/interface targets; no wire field by design — the this-type itself is audited via the 'this-type' site",
	pattern: 'destructuring internals',
}));

const TF = tss.TypeFlags;
const OF = tss.ObjectFlags;

const failures = [];
const notes = new Set();
let pairCount = 0;
const visited = new Set();
const stockIds = new WeakMap();
const tnbIds = new WeakMap();
let nextId = 1;
function idFor(map, o) {
	let id = map.get(o);
	if (id === undefined) { id = nextId++; map.set(o, id); }
	return id;
}

function symName(s) {
	if (s == null) return s;
	try {
		if (typeof s.name === 'string' && s.name !== '') return s.name;
		if (typeof s.getName === 'function') return s.getName();
	} catch { /* fall through */ }
	return undefined;
}

// PseudoBigInt (stock) and real bigint (bridge decodes the wire string) both
// normalize to a decimal string; everything else compares as-is.
function normValue(v) {
	if (typeof v === 'bigint') return `${v}n`;
	if (v && typeof v === 'object' && typeof v.base10Value === 'string') return `${(v.negative ? '-' : '') + v.base10Value}n`;
	return v;
}

function summarize(v, depth = 1) {
	if (v === null || v === undefined) return v;
	if (typeof v !== 'object') return JSON.stringify(normValue(v));
	if (Array.isArray(v)) return `[${v.map(x => summarize(x, depth)).join(',')}]`;
	if (typeof v.base10Value === 'string') return summarize(normValue(v));
	if (typeof v.flags === 'number' && typeof v.id === 'number') {
		const parts = [`flags=${v.flags}`];
		if (typeof v.objectFlags === 'number' && v.objectFlags !== 0) parts.push(`objectFlags=${v.objectFlags}`);
		if (v.intrinsicName !== undefined) parts.push(`intrinsicName=${JSON.stringify(v.intrinsicName)}`);
		if (v.value !== undefined) parts.push(`value=${summarize(v.value, 0)}`);
		const name = symName(v.symbol);
		if (name !== undefined) parts.push(`symbol=${JSON.stringify(name)}`);
		if (depth > 0 && v.types) { try { parts.push(`types=[${v.types.map(t => summarize(t, 0)).join(',')}]`); } catch { /* lazy RPC */ } }
		return `{${parts.join(',')}}`;
	}
	if (typeof v.flags === 'number') return `{symbol ${JSON.stringify(symName(v))},flags=${v.flags}}`;
	return String(v);
}

// Reason the bridge may legitimately lack a field stock carries on this
// specific type, or null (no exemption → mismatch fails).
function conditionalExemption(field, stockVal, s) {
	if (field === 'target' && (s.objectFlags & OF.Mapped) && !(s.objectFlags & OF.Reference)) {
		return 'stock links a mapped instantiation to its anonymous source via target+mapper mechanics; tsgo has no Reference-style target handle for mapped types (getTargetOfType covers Reference/Index/StringMapping)';
	}
	if ((field === 'regularType' || field === 'freshType') && stockVal === s && (s.flags & (TF.Enum | TF.EnumLiteral)) && (s.flags & TF.UnionOrIntersection)) {
		return 'stock attaches a self-referential regular/freshType to the enum union; tsgo models the enum union without a fresh/regular pair, so a consumer reading t.regularType gets an equivalent type either way';
	}
	if ((field === 'typeParameters' || field === 'outerTypeParameters' || field === 'localTypeParameters') && (s.flags & TF.Object) && (s.objectFlags & OF.Tuple)) {
		return 'stock wires synthetic per-element type parameters into a tuple target\'s GenericType instantiation machinery (they are the target\'s identity typeArguments, typeToString \'?\'); tsgo models tuple targets non-generically — element types cross via getTypeArguments on the reference (cross-checked per site)';
	}
	return null;
}

// Rule-aligned one-level comparison used by the lazy-field cross-checks:
// mirrors the scalar + symbol rules of auditPair without recursing.
function sameShallowType(a, b) {
	if (a === undefined || b === undefined) return a === b;
	if (a.flags !== b.flags) return false;
	if ((a.flags & TF.Object) !== 0 && (a.objectFlags ?? 0) !== (b.objectFlags ?? 0)) return false;
	if (JSON.stringify(normValue(a.value)) !== JSON.stringify(normValue(b.value))) return false;
	if ((a.intrinsicName ?? undefined) !== (b.intrinsicName ?? undefined)) return false;
	return true;
}

function auditPair(s, b, pathLabel) {
	if (typeof s !== 'object' || s === null || typeof b !== 'object' || b === null) {
		failures.push(`${pathLabel}: expected type objects, got stock=${summarize(s)} tnb=${summarize(b)}`);
		return;
	}
	const key = `${idFor(stockIds, s)}:${idFor(tnbIds, b)}`;
	if (visited.has(key)) return;
	visited.add(key);
	pairCount++;

	// Tripwire: every stock own key must be audited or exempt — this is what
	// turns a future stock field (or an overlooked one) into a red gate.
	for (const k of Object.keys(s)) {
		if (!AUDITED_FIELDS.has(k) && !STOCK_INTERNAL_KEYS.has(k)) {
			failures.push(`${pathLabel}: unaudited stock own key '${k}' (value ${summarize(s[k], 0)}) — add it to AUDITED_FIELDS or exempt it in STOCK_INTERNAL_KEYS with a reason`);
		}
	}

	// Scalars.
	if (s.flags !== b.flags) failures.push(`${pathLabel}.flags: stock=${s.flags} tnb=${b.flags}`);
	// objectFlags is only comparable on Object-flagged types: stock also uses
	// objectFlags bits ≥1<<15 as internal caches (IsGeneric*/CouldContainTypeVariables/
	// union-origin markers) on unions, intersections and intrinsics, which tsgo
	// keeps in checker side-tables rather than on the payload. On Object types
	// the remapped bits match exactly.
	if ((s.flags & TF.Object) !== 0 && (s.objectFlags ?? 0) !== (b.objectFlags ?? 0)) {
		failures.push(`${pathLabel}.objectFlags: stock=${s.objectFlags} tnb=${b.objectFlags}`);
	}
	const sv = normValue(s.value);
	const bv = normValue(b.value);
	if (s.value !== undefined) {
		if (b.value === undefined || JSON.stringify(sv) !== JSON.stringify(bv)) {
			failures.push(`${pathLabel}.value: stock=${summarize(s.value, 0)} tnb=${summarize(b.value, 0)}`);
		}
	}
	else if (b.value !== undefined) {
		notes.add(`${pathLabel}: TNB extra value=${summarize(b.value, 0)} (stock has none)`);
	}
	if ((s.intrinsicName ?? undefined) !== (b.intrinsicName ?? undefined)) {
		failures.push(`${pathLabel}.intrinsicName: stock=${JSON.stringify(s.intrinsicName)} tnb=${JSON.stringify(b.intrinsicName)}`);
	}
	// #19/#22: stock models boolean literals as IntrinsicType with no value;
	// the bridge carries tsgo's LiteralType value alongside. With no stock
	// value to diff, guard consistency between the two bridge fields instead.
	if ((s.flags & TF.BooleanLiteral) !== 0 && b.value !== undefined && b.value !== (s.intrinsicName === 'true')) {
		failures.push(`${pathLabel}.value: bool literal value ${JSON.stringify(b.value)} inconsistent with intrinsicName ${JSON.stringify(s.intrinsicName)} (issue #19 stale-bit class)`);
	}
	if ((s.isThisType ?? false) !== (b.isThisType ?? false)) {
		failures.push(`${pathLabel}.isThisType: stock=${s.isThisType} tnb=${b.isThisType}`);
	}
	// readonly/fixedLength are stock-driven: the bridge deliberately mirrors a
	// tuple target's tuple data onto the reference (proto.go "Mirror
	// checker.isTupleType"), where stock keeps them only on the target — so a
	// present-but-absent-on-stock value is a noted extra, and the field stays
	// gated through the target recursion.
	if (s.readonly !== undefined && (s.readonly ?? false) !== (b.readonly ?? false)) {
		failures.push(`${pathLabel}.readonly: stock=${s.readonly} tnb=${b.readonly}`);
	}
	else if (s.readonly === undefined && b.readonly !== undefined) {
		notes.add(`${pathLabel}: TNB extra readonly=${b.readonly} (stock keeps tuple data on the target only)`);
	}
	if (s.fixedLength !== undefined && s.fixedLength !== b.fixedLength) {
		failures.push(`${pathLabel}.fixedLength: stock=${s.fixedLength} tnb=${b.fixedLength}`);
	}
	else if (s.fixedLength === undefined && b.fixedLength !== undefined) {
		notes.add(`${pathLabel}: TNB extra fixedLength=${b.fixedLength} (stock keeps tuple data on the target only)`);
	}

	// Symbols: presence + flags + name.
	for (const f of ['symbol', 'aliasSymbol']) {
		const ss = s[f];
		const bs = b[f];
		if (ss == null) continue;
		if (bs == null) { failures.push(`${pathLabel}.${f}: stock=${summarize(ss, 0)} tnb=${bs}`); continue; }
		if (ss.flags !== bs.flags) failures.push(`${pathLabel}.${f}.flags: stock=${ss.flags} tnb=${bs.flags}`);
		const sn = symName(ss);
		const bn = symName(bs);
		if (sn !== undefined && bn !== undefined && sn !== bn) {
			failures.push(`${pathLabel}.${f}.name: stock=${JSON.stringify(sn)} tnb=${JSON.stringify(bn)}`);
		}
	}

	// Single referenced types. Stock's `type` (IndexType/StringMappingType)
	// is the same slot the bridge names `target` (proto.go Target).
	const SINGLE = [
		['target', 'target'], ['freshType', 'freshType'], ['regularType', 'regularType'],
		['objectType', 'objectType'], ['indexType', 'indexType'], ['checkType', 'checkType'],
		['extendsType', 'extendsType'], ['baseType', 'baseType'], ['substConstraint', 'substConstraint'],
		['type', 'target'],
	];
	for (const [sf, bf] of SINGLE) {
		const st = s[sf];
		if (st === undefined) continue;
		if (st === s) {
			// Self-reference (freshable freshType/regularType, generic target):
			// nothing to recurse into — the bridge must at least carry the field.
			if (b[bf] === undefined) {
				const reason = conditionalExemption(sf, st, s);
				if (reason) notes.add(`${pathLabel}.${sf}: exempt — ${reason}`);
				else failures.push(`${pathLabel}.${sf}: stock self-references, tnb=${b[bf]}`);
			}
			continue;
		}
		const bt = b[bf];
		if (bt === undefined) {
			const reason = conditionalExemption(sf, st, s);
			if (reason) notes.add(`${pathLabel}.${sf}: exempt — ${reason}`);
			else failures.push(`${pathLabel}.${sf}: stock=${summarize(st, 0)} tnb=${bt}`);
			continue;
		}
		auditPair(st, bt, `${pathLabel}.${sf}`);
	}

	// Referenced type arrays. Empty ≡ absent (the bridge always materializes
	// the slots; stock leaves them undefined). Order is positional...
	for (const f of ['typeParameters', 'outerTypeParameters', 'localTypeParameters', 'aliasTypeArguments']) {
		const sa = s[f];
		if (sa === undefined || sa.length === 0) continue;
		const ba = b[f] ?? [];
		if (sa.length !== ba.length) {
			const reason = ba.length === 0 ? conditionalExemption(f, sa, s) : null;
			if (reason) notes.add(`${pathLabel}.${f}: exempt — ${reason}`);
			else failures.push(`${pathLabel}.${f}: stock ${sa.length} items, tnb ${ba.length}`);
			continue;
		}
		for (let i = 0; i < sa.length; i++) auditPair(sa[i], ba[i], `${pathLabel}.${f}[${i}]`);
	}
	// ...except union/intersection/template/enum members: tsgo sorts union
	// constituents by internal type id where stock keeps creation order, so
	// membership compares as a sorted multiset (a known tsgo divergence —
	// the typeToString order diff is reported as informational per site).
	{
		const sa = s.types;
		if (sa !== undefined && sa.length !== 0) {
			const ba = b.types; // lazy getter → getTypesOfType RPC on the bridge side
			if (ba === undefined) failures.push(`${pathLabel}.types: stock ${sa.length} items, tnb=${ba}`);
			else {
				if (sa.length !== ba.length) failures.push(`${pathLabel}.types: stock ${sa.length} items, tnb ${ba.length}`);
				const sortKey = t => `${t.flags}|${t.intrinsicName ?? ''}|${JSON.stringify(normValue(t.value))}|${symName(t.symbol) ?? ''}`;
				const sSorted = [...sa].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
				const bSorted = [...ba].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
				for (let i = 0; i < Math.min(sSorted.length, bSorted.length); i++) {
					auditPair(sSorted[i], bSorted[i], `${pathLabel}.types[${i}]`);
				}
			}
		}
	}

	// Scalar arrays: exact, ordered (texts keeps empty segments — #16 class).
	for (const f of ['texts', 'elementFlags']) {
		const sa = s[f];
		if (sa === undefined) {
			if (b[f] !== undefined) notes.add(`${pathLabel}: TNB extra ${f}=${JSON.stringify(b[f])} (stock has none)`);
			continue;
		}
		const ba = b[f];
		if (ba === undefined || JSON.stringify([...sa]) !== JSON.stringify([...ba])) {
			failures.push(`${pathLabel}.${f}: stock=${JSON.stringify(sa)} tnb=${JSON.stringify(ba)}`);
		}
	}
}

// ── Run ──────────────────────────────────────────────────────────────────
const stock = makeStock();
const tnb = makeTnb();

for (const spec of SITES) {
	let sNode, bNode, sT, bT;
	try {
		sNode = findNode(stock.ts, stock.sf, spec);
		sT = stock.checker.getTypeAtLocation(sNode);
	} catch (e) {
		failures.push(`${spec.label}: stock getTypeAtLocation threw: ${e.message}`);
		continue;
	}
	try {
		bNode = findNode(tnb.ts, tnb.sf, spec);
		bT = tnb.checker.getTypeAtLocation(bNode);
	} catch (e) {
		failures.push(`${spec.label}: tnb getTypeAtLocation threw: ${e.message}`);
		continue;
	}
	auditPair(sT, bT, spec.label);

	// Cross-check the fields that cross lazily by design instead of exempting
	// them blind: constraint via getConstraint() (#23), type arguments via
	// checker.getTypeArguments.
	if ((sT.flags & TF.TypeParameter) !== 0) {
		const sc = sT.getConstraint?.();
		const bc = bT.getConstraint?.();
		if (!sameShallowType(sc, bc)) {
			failures.push(`${spec.label}.getConstraint(): stock=${summarize(sc, 0)} tnb=${summarize(bc, 0)}`);
		}
	}
	if ((sT.objectFlags & OF.Reference) !== 0) {
		try {
			const sa = stock.checker.getTypeArguments(sT);
			const ba = tnb.checker.getTypeArguments(bT);
			if (sa.length !== ba.length || sa.some((t, i) => !sameShallowType(t, ba[i]))) {
				failures.push(`${spec.label}.getTypeArguments(): stock=[${sa.map(t => summarize(t, 0))}] tnb=[${ba.map(t => summarize(t, 0))}]`);
			}
		} catch (e) {
			failures.push(`${spec.label}.getTypeArguments() threw: ${e.message}`);
		}
	}
	// Informational: display parity. Union-constituent order is a known tsgo
	// divergence, so typeToString diffs are reported, not gated.
	const ss = stock.checker.typeToString(sT);
	const bs = tnb.checker.typeToString(bT);
	if (ss !== bs) notes.add(`${spec.label}: typeToString stock=${JSON.stringify(ss)} tnb=${JSON.stringify(bs)}`);
}

tnb.close();
stock.close();

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error(`  ${f}`);
	if (notes.size) {
		console.error('  notes:');
		for (const n of [...notes].sort()) console.error(`    ${n}`);
	}
	process.exit(1);
}
console.log(`ok type payload parity: ${SITES.length} sites, ${pairCount} type pairs audited (stock ${tss.version} vs fork ${tsb.version}); ${STOCK_INTERNAL_KEYS.size} stock-internal fields exempted with reasons`);
if (notes.size) {
	console.log('  notes (informational, not gated):');
	for (const n of [...notes].sort()) console.log(`    ${n}`);
}
