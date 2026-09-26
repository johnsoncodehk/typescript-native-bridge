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
 * getDeclaredTypeOfSymbol; relations — isTypeAssignableTo over every ordered
 * pair of relations.ts's declared alias types, plus isArrayType /
 * isTupleType / isArrayLikeType / isEmptyAnonymousObjectType / isNullableType
 * per alias (stock's whole relation surface).
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
 *   U1  union constituent order — tsgo orders union members by its total type
 *       ordering (upstream tsgo #200 "Total ordering of types"), stock keeps
 *       declaration order.
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
 * Ordering-class exemptions (U1/U2/U2T/LU2) are shape-validated before being
 * green-lit: the claim is "same content, different order", so the two sides
 * must be permutations of each other (sorted stable element keys byte-equal).
 * U2 member lists compare full elements; U2T compares members modulo their
 * (truncation-dependent) type strings; LU2 compares full elements after
 * normalizing the documented padStart/padEnd parameter rename; U1 compares the
 * type string's top-level `|` constituents as a multiset (and canonType
 * flags/objectFlags must match). A divergence at a known key that is not a
 * permutation — a wrong member name, wrong union constituent, drifted flags —
 * is a genuine bug riding on the exemption and FAILs as KNOWN-SHAPE-VIOLATION.
 * U3 (alias-chain shape) is a structural difference, not an ordering one, and
 * is not shape-checked.
 *
 * --full-walk (wired as triage-checker-fullwalk.mjs) turns the probe from a
 * hand-picked point list into an exhaustive walk. Every node of every corpus
 * file (never lib files) runs the same batteries — labels are
 * `${relFile}:${pos}:${SyntaxKind[kind]}` (byte-identical corpus ⇒ identical
 * on both sides) — plus three additions:
 *   F1  the 14-field NESTED lazy-accessor closure (target/thisType/freshType/
 *       regularType/objectType/indexType/checkType/extendsType/baseType/
 *       substConstraint + the four typeParameters arrays, parsed from
 *       tsgoChecker.ts so the prop list has no second home): every type
 *       returned by getTypeAtLocation / getTypeOfSymbolAtLocation /
 *       getDeclaredTypeOfSymbol reads all 14 fields. A wire-present field
 *       fires the registry RPC, which is what flushes the Go-side As*()
 *       nil-cast class (#69/#70/#71) out into the open — a panic is
 *       process-fatal in the bridge, a JS throw canonicalizes to { $err }.
 *       One level only: field-read results are canonType'd, never re-closed.
 *   F2  order-insensitive canon — the curated U1/U2/LU2 exemptions could not
 *       survive an exhaustive walk (they'd fire on every union/member list),
 *       so the normalizations move into canon: type strings (canonType.s,
 *       canonSig strings, both typeToString variants) are LU2-renamed,
 *       truncation-tail-stripped and sorted into the union multiset at every
 *       depth; member/symbol lists (getPropertiesOfType /
 *       getApparentProperties / getExportsOfModule) are sorted by stable()
 *       key. Ordered stays ordered where the order is semantic: signature
 *       params, overload lists, alias chains. Curated canon is untouched.
 *   F3  crash isolation — the tnb side runs ONE CHILD PER CORPUS FILE
 *       (TNB_DIFF_FILE=<rel>), so a Go panic in one file cannot hide the
 *       rest: the parent collects every crash in one run (CRASH <file> +
 *       stderr tail), the walk continues, and the final VERDICT is FAIL.
 *       The stock side stays one child (stock field reads are plain JS).
 * Full-walk also gates RPC-method coverage mechanically: every method the
 * JS side can call (ARENA_METHODS in tsgoTransport.ts + the JSON-path
 * literals in tsgoChecker.ts, cross-checked against the Go surface in proto.go) must
 * have a COVERAGE entry (battery / field:<prop> / symbol-battery /
 * spec-battery / module-battery / exempt: <reason>) — a new RPC method
 * shipping unwalked turns the gate red.
 * Full-walk also runs the shape census: every canonType'd type records its
 * TypeFlags/ObjectFlags set bits per child, and the parent gates the union
 * against the fork bundle's enums — every structural bit must be produced
 * on both sides or carry a CENSUS_EXEMPT reason (stale-fail if observed).
 * Cast outcomes are shape-pure, so census + F1 prove every (method × shape)
 * pair is exercised per run.
 *
 * Usage: node tools/triage-checker-differential.mjs
 *        node tools/triage-checker-differential.mjs --self-test
 *        node tools/triage-checker-differential.mjs --full-walk
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 */
import { spawn, spawnSync } from 'node:child_process';
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
	U1: 'U1: tsgo union constituent order (upstream tsgo #200 total ordering of types), stock declaration order',
	U2: 'U2: tsgo member/symbol ordering (upstream, same class as #200)',
	U2T: 'U2T: member-order-dependent typeToString truncation tail (upstream #200 class)',
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

// ── Full-walk known divergences (method@label → class reason) ─────────────
// Curated keys don't transfer: full-walk labels are generated (file:pos:kind),
// and the ordering classes are baked into canon (F2 above). What remains
// keyed is the shape-class residuals that canon cannot express — same
// stale-fail semantics as KNOWN_DIVERGENCES, consulted only in --full-walk.
// Each class is attributed to its mechanism; the FW/J* classes are value
// shapes (unchecked, like U3). The JS classes were surfaced by the walk's
// new js/ corpus (checkJs path) — engine-model differences, attribution to
// be confirmed against pristine tsgo before treating any as a bridge bug.
const FW_KEYOF_TARGET = 'FW: target-slot name — stock names the Index/StringMapping slot `type` (IndexType/StringMappingType), the bridge names the same slot `target` (proto.go Target); the walk reads the wire name, so stock reads undefined while the bridge carries the operand (triage-type-field-audit field-name mapping type↔target)';
const FW_MAPPED_TARGET = 'FW: mapped-type target — stock links a mapped type (alias reference or instantiation) to its source via target, tsgo has no Reference-style target handle for mapped types (triage-type-field-audit conditionalExemption)';
const FW_SUBST_CONSTRAINT = 'FW: substitution-constraint slot — stock\'s SubstitutionType exposes the NoInfer constraint as `constraint`, the bridge as the wire field `substConstraint` (with the stock name aliased onto it); the walk reads the wire name, so stock reads undefined while the bridge carries the constraint (AGENTS.md accepted tradeoff: SubstitutionType.constraint alias is code-path parity only — first reliable source-level trigger)';
const FW_TUPLE_ELISION = 'FW: instantiated-tuple display — stock renders tuple references as [...] inside signature instantiations, tsgo renders the element types (stock tuple-reference display model)';
const FW_TRUNC_BUDGET = 'FW: truncation-budget placement — at the 160-char typeToString budget stock shortens the first union it meets (`value: string | ... 1 more ... | undefined`), tsgo a later one; same total length. Engine printer (pristine tsgo @ 2bd066d8 prints TNB\'s string for [string, number?]#find)';
const ERR_ABS = 'ERR: errored declaration resolution — stock resolves the abstract-instantiation error to the error type (rendered any), tsgo keeps the declared class type (engine error-type model on erroneous programs)';
const JS_MODEL = 'JS: CJS module model — tsgo shapes module/exports symbols and require-destructured types differently from stock (exports = Property|ModuleExports vs ValueModule; module type = export object vs typeof import; literal widening through destructuring); engine checkJs model, pristine-tsgo attribution pending';
const JS_ALIAS = 'JS: require-destructured binding model — stock models the binding as an alias symbol over the module export member, tsgo binds the member directly (alias model, checkJs path; pristine-tsgo attribution pending)';
const FULLWALK_KNOWN = new Map((() => {
	const keys = [];
	const add = (reason, methods, points) => {
		for (const m of methods) for (const at of points) keys.push([`${m}@${at}`, reason]);
	};
	add(REASON.U3,
		["getImmediateAliasedSymbol.chain"],
		["cjs/use.ts:6:Identifier", "cjs/use.ts:55:Identifier", "cjs/use.ts:103:Identifier", "cjs/use.ts:112:Identifier"]);
	add(ERR_ABS,
		["getTypeAtLocation", "typeToString", "typeToString[NoTrunc]", "getApparentType", "getPropertiesOfType", "getApparentProperties"],
		["errors.ts:265:VariableDeclaration", "errors.ts:265:Identifier", "errors.ts:271:NewExpression"]);
	add(ERR_ABS,
		["field:target", "field:thisType"],
		["errors.ts:265:VariableDeclaration[t]", "errors.ts:265:Identifier[t]", "errors.ts:265:Identifier[t1]", "errors.ts:271:NewExpression[t]"]);
	add(ERR_ABS,
		["getTypeOfSymbolAtLocation"],
		["errors.ts:265:Identifier"]);
	add(FW_MAPPED_TARGET,
		["field:target"],
		["types.ts:1417:VariableDeclaration[t]", "types.ts:1417:Identifier[t]", "types.ts:1417:Identifier[t1]", "types.ts:1425:TypeReference[t]"]);
	add(FW_KEYOF_TARGET,
		["field:target"],
		["types.ts:191:TypeOperator[t]"]);
	// census.ts — the shape-census corpus: the same field-model classes at the
	// new labels the constructs produce (target-slot on keyof/StringMapping,
	// mapped-type target on M1/M2 references, substitution-constraint slot on
	// NoInfer<T>). The reverse-mapped instantiation itself converges.
	add(FW_KEYOF_TARGET,
		["field:target"],
		["census.ts:742:TypeOperator[t]", "census.ts:781:TypeOperator[t]", "census.ts:410:VariableDeclaration[t]", "census.ts:410:Identifier[t]", "census.ts:410:Identifier[t1]", "census.ts:414:TypeReference[t]"]);
	add(FW_SUBST_CONSTRAINT,
		["field:substConstraint"],
		["census.ts:620:Parameter[t]", "census.ts:620:Identifier[t]", "census.ts:620:Identifier[t1]", "census.ts:622:TypeReference[t]"]);
	add(FW_MAPPED_TARGET,
		["field:target"],
		["census.ts:825:Parameter[t]", "census.ts:825:Identifier[t]", "census.ts:825:Identifier[t1]", "census.ts:827:TypeReference[t]", "census.ts:846:Identifier[t]", "census.ts:846:Identifier[t1]", "census.ts:880:VariableDeclaration[t]", "census.ts:880:Identifier[t]", "census.ts:880:Identifier[t1]", "census.ts:887:TypeReference[t]", "census.ts:949:Identifier[t]", "census.ts:949:Identifier[t1]"]);
	// relations.ts — the relation-battery aliases walked node by node: the
	// same slot classes (Uppercase<string>; Record/Readonly/Partial mapped
	// instantiations) plus one truncation-budget placement.
	add(FW_KEYOF_TARGET,
		["field:target"],
		["relations.ts:770:TypeAliasDeclaration[t]", "relations.ts:782:Identifier[t]", "relations.ts:782:Identifier[t2]", "relations.ts:792:TypeReference[t]"]);
	add(FW_MAPPED_TARGET,
		["field:target"],
		["relations.ts:1327:TypeAliasDeclaration[t]", "relations.ts:1339:Identifier[t]", "relations.ts:1339:Identifier[t2]", "relations.ts:1350:TypeReference[t]",
			"relations.ts:3151:TypeAliasDeclaration[t]", "relations.ts:3163:Identifier[t]", "relations.ts:3163:Identifier[t2]", "relations.ts:3175:TypeReference[t]",
			"relations.ts:3192:TypeAliasDeclaration[t]", "relations.ts:3204:Identifier[t]", "relations.ts:3204:Identifier[t2]", "relations.ts:3221:TypeReference[t]"]);
	add(FW_TRUNC_BUDGET,
		["getPropertiesOfType", "getApparentProperties"],
		["relations.ts:1751:TypeAliasDeclaration", "relations.ts:1763:Identifier", "relations.ts:1774:TupleType"]);
	add(FW_TUPLE_ELISION,
		["getPropertiesOfType", "getApparentProperties"],
		["types.ts:1128:Parameter", "types.ts:1128:Identifier", "types.ts:1133:TupleType", "types.ts:1188:Identifier"]);
	add(JS_MODEL,
		["getSymbolAtLocation[module]", "getExportsOfModule", "getTypeOfSymbolAtLocation[module]"],
		["js/consumer.js:0:SourceFile", "js/plain.js:0:SourceFile"]);
	add(JS_MODEL,
		["getSymbolAtLocation", "getTypeOfSymbolAtLocation"],
		["js/consumer.js:126:Identifier", "js/consumer.js:126:PropertyAccessExpression", "js/consumer.js:134:Identifier", "js/plain.js:282:Identifier", "js/plain.js:282:PropertyAccessExpression", "js/plain.js:290:Identifier"]);
	add(JS_MODEL,
		["getTypeAtLocation", "typeToString", "typeToString[NoTrunc]", "getApparentType", "getPropertiesOfType", "getApparentProperties"],
		["js/consumer.js:126:BinaryExpression", "js/consumer.js:126:Identifier", "js/consumer.js:126:PropertyAccessExpression", "js/consumer.js:134:Identifier", "js/plain.js:282:BinaryExpression", "js/plain.js:282:Identifier", "js/plain.js:282:PropertyAccessExpression", "js/plain.js:290:Identifier", "js/consumer.js:5:ObjectBindingPattern", "js/consumer.js:39:CallExpression"]);
	add(JS_MODEL,
		["getTypeAtLocation", "typeToString", "typeToString[NoTrunc]"],
		["js/consumer.js:26:BindingElement", "js/consumer.js:26:Identifier"]);
	add(JS_MODEL,
		["getTypeOfSymbolAtLocation"],
		["js/consumer.js:26:Identifier"]);
	add(JS_MODEL,
		["getExportsOfModule"],
		["js/consumer.js:48:StringLiteral"]);
	add(JS_ALIAS,
		["getAliasedSymbol", "getImmediateAliasedSymbol.chain"],
		["js/consumer.js:7:Identifier", "js/consumer.js:18:Identifier", "js/consumer.js:26:Identifier", "js/consumer.js:31:Identifier", "js/consumer.js:71:Identifier", "js/consumer.js:98:Identifier", "js/consumer.js:119:Identifier"]);
	return keys;
})());

// ── Shape census (--full-walk) ─────────────────────────────────────────────
// The #69/#70/#71 panic class: Go As*() casts succeed/fail purely by the
// type's data shape, stamped at construction and observed on the wire as
// flags/objectFlags. If every structural bit appears in the corpus on both
// sides, every (battery × shape) pair is exercised per run. Children record
// the set bits of every canonType'd type (the only canon path that carries
// shape data — canonProp/canonSig compare type strings only); the parent
// unions per side and gates the union against the fork bundle's enums (the
// enum-remap gate already guarantees the wire delivers these layouts, so the
// bundle is the same source of truth, not a second one).
//
// Derivation: single-bit positive entries only — power of two, objectFlags
// ≤ 1<<14 (the N1 structural mask; ≥ 1<<15 are stock lazy bookkeeping).
// Combined aliases (UnionOrIntersection, Literal, AnyOrUnknown, …) fall out
// mechanically. The Includes* TypeFlags are single-bit re-aliases of existing
// positions (stock declares IncludesMissingType === TypeParameter, …) —
// dedup by value, first declaration wins: the wire cannot distinguish them
// and one observation proves the position.
const CENSUS_FLAG_MAX = 1 << 30; // flags bits 0..30 (bit 31 = Reserved3, negative in the enum)
const CENSUS_OF_MAX = 1 << 14; // N1 structural mask
// For a value v, the individual set bits as powers of two (0b101 → [1, 4]).
function decomposeBits(v, max) {
	const out = [];
	for (let b = 1; b <= max; b *= 2) if (v & b) out.push(b);
	return out;
}
function censusBitNames(enumObj, max) {
	const names = new Map(); // bit value → name
	for (const [name, v] of Object.entries(enumObj)) {
		if (typeof v !== 'number' || v <= 0 || (v & (v - 1)) !== 0 || v > max) continue;
		if (!names.has(v)) names.set(v, name);
	}
	return names;
}
// Bits genuinely not producible as a node's type in this harness. A bit
// observed despite its exemption FAILs as stale (same anti-rot pattern as
// KNOWN_DIVERGENCES / asguard).
const CENSUS_TF_EXEMPT = new Map([
	['Reserved1', 'reserved TypeFlags bit 29 — never stamped by either engine'],
	['Reserved2', 'reserved TypeFlags bit 30 — never stamped by either engine'],
]);
const CENSUS_OF_EXEMPT = new Map([
	// Evolving-array types are transient checker state (evolvingArrayTypes):
	// by the time a program settles, getTypeAtLocation/getTypeOfSymbolAtLocation/
	// getDeclaredTypeOfSymbol return the evolved or any[] array, never the
	// EvolvingArray-flagged auto type (verified against stock with the
	// const a = []; a.push(1) pattern — the flag never surfaces).
	['EvolvingArray', 'transient checker state — replaced before the walk\'s queries run; not observable through the walk\'s three primaries'],
	// JSX-only flag: the corpus has no JSX files — the COVERAGE gate exempts
	// the JSX paths, and JSX parity rides the framework-checks witness.
	['JsxAttributes', 'JSX-only flag — the corpus has no JSX (JSX paths are exempt in COVERAGE; parity rides framework-checks)'],
]);

function censusGate(tfNames, ofNames, tfExempt, ofExempt, stock, tnb) {
	const errors = [];
	const gates = [];
	const runEnum = (kind, names, exempt, sArr, tArr) => {
		const nameOf = new Map([...names].map(([v, n]) => [n, v]));
		const s = new Set(sArr), t = new Set(tArr);
		// Observed bit with no single-bit enum entry: the enums no longer
		// describe the wire (bridge/enum-remap bug or a missing exemption).
		for (const [side, set] of [['stock', s], ['tnb', t]]) {
			const unknown = [...set].filter(b => !names.has(b));
			if (unknown.length) errors.push(`CENSUS-FAIL ${kind} bit(s) ${unknown.join(', ')} observed on ${side} with no single-bit enum entry`);
		}
		// Exemptions must stay true: observed means the reason rotted.
		const exemptBits = new Set();
		for (const [name, reason] of exempt) {
			const v = nameOf.get(name);
			if (v === undefined) { errors.push(`CENSUS-FAIL ${kind} exemption ${name} names no derived bit (typo or the enum dropped it)`); continue; }
			exemptBits.add(v);
			if (s.has(v) || t.has(v)) errors.push(`CENSUS-FAIL stale ${kind} exemption ${name} — ${reason} (observed on ${s.has(v) ? (t.has(v) ? 'both sides' : 'stock') : 'tnb'})`);
		}
		const expected = [...names.keys()].filter(b => !exemptBits.has(b));
		for (const [side, set] of [['stock', s], ['tnb', t]]) {
			const miss = expected.filter(b => !set.has(b));
			if (miss.length) errors.push(`CENSUS-FAIL ${kind} missing from ${side}: ${miss.map(b => names.get(b)).join(', ')}`);
		}
		const both = expected.filter(b => s.has(b) && t.has(b));
		gates.push({ both: both.length, total: expected.length });
	};
	runEnum('type-flag', tfNames, tfExempt, stock.f, tnb.f);
	runEnum('object-flag', ofNames, ofExempt, stock.of, tnb.of);
	const [tf, of] = gates;
	const summary = `census: ${tf.both}/${tf.total} type-flag bits, ${of.both}/${of.total} object-flag bits, both sides`;
	return { errors, summary };
}

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
const JS_TSCONFIG = {
	compilerOptions: {
		target: 'es2022', lib: ['es2022'], module: 'commonjs',
		strict: true, noEmit: true, skipLibCheck: true, types: [],
		allowJs: true, checkJs: true,
	},
	include: ['js/**/*'],
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
	// error-type shapes through every API: unresolved ref, circular heritage,
	// duplicate declarations, wrong-type assignment, abstract instantiation
	'errors.ts': `const missing: Missing = undefined;
class A extends B {}
class B extends A {}
function dupFn(x: string): number;
function dupFn(x: string): number { return 1; }
const dup = 1;
const dup = 2;
const n: number = 'oops';
abstract class Abs { abstract m(): void; }
const abs = new Abs();
`,
	// ambient declarations: class/function/namespace/enum, overloads, merging
	'shapes.d.ts': `declare class K {
  static s: string;
  m(): number;
}
declare function f(a: string): number;
declare function f(a: number): string;
declare namespace NS { const v: number; }
declare enum E { A, B }
interface I { x: string }
interface I { y: number }
export default K;
export { f, NS, E, I };
`,
	// global interface augmentation — symmetrically extends String member
	// lists on both sides; curated LU2 entries stay order/rename-divergent
	'globalaug.ts': `export {};
declare global {
  interface String { tnbProbe(): number; }
}
const s = 'x';
export const probe: number = s.tnbProbe();
`,
	// Shape-census coverage — each construct produces a TypeFlags/ObjectFlags
	// structural bit the walk must observe on both sides (see the census gate)
	'census.ts': `export const flag: boolean = true; // Boolean + BooleanLiteral
export const big: bigint = 10n; // BigInt + BigIntLiteral
export const symTyped: symbol = Symbol(); // ESSymbol
export const uniq = Symbol(); // UniqueESSymbol
export function fail(): never { throw new Error('x'); } // Never
export type Both = { a: string } & { b: number }; // Intersection
export const both: Both = { a: 'x', b: 1 };
export const up: Uppercase<string> = 'X'; // StringMapping
export function prefix<T extends string>(x: \`pfx-\${T}\`): \`pfx-\${T}\` { return x; } // TemplateLiteral
export const pre = prefix('a');
export function noInferArg<T>(x: NoInfer<T>): T { return x; } // Substitution (NoInfer)
interface E { id: string; tags: string[]; }
type M1<T> = { [K in keyof T]: T[K] };
type M2<T> = { [K in keyof T]: T[K] };
export function unmap<T>(m: M2<T>): T { return m as unknown as T; }
export const m1val: M1<E> = { id: 'x', tags: [] };
export const unmapped = unmap(m1val); // ReverseMapped: M1 != M2 dodges the target identity fast path
`,
	// Relation battery: every R_* alias's declared type is related to every
	// other one (isTypeAssignableTo, ordered pairs) plus the type predicates.
	// Each group pins a relation rule the matrix exercises in both directions.
	'relations.ts': `import { Animal, Dog, Color } from './types.js';
import { Box, Shape } from './util.js';
class PrivA { private p = 1; }
class PrivB { private p = 1; }
// top / bottom / unit
export type R_any = any;
export type R_unknown = unknown;
export type R_never = never;
export type R_void = void;
export type R_undefined = undefined;
export type R_null = null;
// primitives, literals, widening, templates
export type R_string = string;
export type R_a = 'a';
export type R_ab = 'a' | 'b';
export type R_number = number;
export type R_42 = 42;
export type R_boolean = boolean;
export type R_true = true;
export type R_bigint = bigint;
export type R_symbol = symbol;
export type R_strOrUndef = string | undefined;
export type R_tpl = \`pfx-\${string}\`;
export type R_tplA = 'pfx-a';
export type R_upper = Uppercase<string>;
// object tops
export type R_object = object;
export type R_empty = {};
export type R_Object = Object;
// properties: optional / readonly / excess / weak / index signatures
export type R_req = { a: string };
export type R_opt = { a?: string };
export type R_ro = { readonly a: string };
export type R_extra = { a: string; b: number };
export type R_aNum = { a: number };
export type R_weak = { x?: number; y?: number };
export type R_strIdx = { [k: string]: string };
export type R_numIdx = { [k: number]: string };
export type R_record = Record<string, unknown>;
export type R_inter = { a: string } & { b: number };
export type R_disc = { k: 'x'; v: string } | { k: 'y'; v: number };
export type R_discX = { k: 'x'; v: string };
// arrays / tuples
export type R_arr = string[];
export type R_roArr = readonly string[];
export type R_numArr = number[];
export type R_tup = [string, number];
export type R_roTup = readonly [string, number];
export type R_tupOpt = [string, number?];
export type R_tupRest = [string, ...number[]];
export type R_emptyTup = [];
// functions: return covariance, strict parameter contravariance, method
// bivariance, arity, generics, construct signatures
export type R_fnRet = () => string;
export type R_fnRetU = () => string | number;
export type R_fnP = (x: string) => void;
export type R_fnPU = (x: string | number) => void;
export type R_fn2 = (x: string, y: number) => void;
export type R_fnGen = <T>(x: T) => T;
export type R_meth = { m(x: string): void };
export type R_methU = { m(x: string | number): void };
export type R_propFn = { m: (x: string) => void };
export type R_propFnU = { m: (x: string | number) => void };
export type R_ctor = new () => object;
// nominal-ish: class hierarchy, private brands, enums
export type R_Animal = Animal;
export type R_Dog = Dog;
export type R_PrivA = PrivA;
export type R_PrivB = PrivB;
export type R_structP = { p: number };
export type R_Color = Color;
export type R_ColorRed = Color.Red;
// generics / lib references / type operators
export type R_Shape = Shape;
export type R_BoxShape = Box<Shape>;
export type R_BoxObj = Box<object>;
export type R_promise = Promise<string>;
export type R_promiseLike = PromiseLike<string>;
export type R_keyofShape = keyof Shape;
export type R_shapeId = Shape['id'];
export type R_mapped = { [K in 'a' | 'b']: string };
export type R_roShape = Readonly<Shape>;
export type R_partialShape = Partial<Shape>;
`,
	// JS project (checkJs): JSDoc-typed exports, object literals (JSLiteral
	// objectFlags), module.exports — exercised through the js/ config only
	'js/plain.js': `/**
 * @typedef {{ id: string, tags: string[] }} Entity
 */
/**
 * @param {string} key
 * @returns {Promise<string>}
 */
async function fetchData(key) { return key; }
/** @type {Entity} */
const entity = { id: 'a', tags: ['x'] };
const lit = 'hello';
const obj = { a: 1, b: 'two' };
module.exports = { fetchData, entity, lit, obj };
// computed-key destructure: the binding-pattern type carries
// ObjectLiteralPatternWithComputedProperties (512) when the key type is not
// a usable property name — checkJs builds it error-free (implicit-any is a
// TS error, not a JS one)
/** @type {string} */
const dynKey = 'a';
function computedPat({ [dynKey]: v }) { return v; }
computedPat({ a: 1 });
`,
	'js/consumer.js': `const { fetchData, entity, lit, obj } = require('./plain');
const out = fetchData('k');
const id = entity.id;
const a = obj.a;
module.exports = { out, id, a, lit };
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

const RELATION_PREDICATES = ['isArrayType', 'isTupleType', 'isArrayLikeType', 'isEmptyAnonymousObjectType', 'isNullableType'];

// ── Full-walk machinery ─────────────────────────────────────────────────────
// TNB_DIFF_FULLWALK=1 marks a child; TNB_DIFF_FILE=<rel> scopes a tnb child
// to one corpus file (crash isolation: a Go panic is process-fatal, so one
// file per child lets the parent collect every crash in a single run).
const FULLWALK = process.argv.includes('--full-walk') || process.env.TNB_DIFF_FULLWALK === '1';
const FULLWALK_FILE = process.env.TNB_DIFF_FILE;
const projOfFile = rel => (rel.startsWith('cjs/') ? 'cjs' : rel.startsWith('js/') ? 'js' : 'main');
// Fixed concatenation order for both sides: project order, then sorted rel.
// The parent re-concatenates per-file children in exactly this order.
const FULLWALK_FILES = ['main', 'cjs', 'js'].flatMap(proj =>
	Object.keys(CORPUS).filter(rel => projOfFile(rel) === proj).sort());
// Comp.vue is the issue-#26 shadow: it exists on disk only so the resolution
// can prefer the phantom declaration Comp.d.vue.ts — no program ever owns
// it, so the walk (which enumerates program files) must skip it. The child
// asserts both halves of that split so a corpus drift stays loud.
const FULLWALK_NO_PROGRAM = new Set(['Comp.vue']);
// Stock's getSymbolAtLocation switch (checker.ts, 6.0.3) — the kinds its
// contract actually resolves. On every other kind stock returns undefined
// while tsgo's handler returns the node's symbol (engine permissiveness:
// ExportAssignment/Parameter/TemplateSpan/… — not a bridge bug, and no
// consumer queries those kinds), so probing them compares stock's null
// against a tsgo extension. The symbol battery runs on the contract kinds
// only; the type battery runs everywhere stock's getTypeOfNode computes a
// real type (everything but ImportClause/ExportAssignment, where stock
// returns errorType — or throws, state-dependently — while tsgo computes
// the real type).
const SYMBOL_CONTRACT_KINDS = new Set([
	'Identifier', 'PrivateIdentifier', 'PropertyAccessExpression', 'QualifiedName',
	'ThisKeyword', 'ThisType', 'SuperKeyword', 'ConstructorKeyword',
	'StringLiteral', 'NoSubstitutionTemplateLiteral', 'NumericLiteral',
	'DefaultKeyword', 'FunctionKeyword', 'EqualsGreaterThanToken', 'ClassKeyword',
	'ImportType', 'ExportKeyword', 'ImportKeyword', 'NewKeyword', 'InstanceOfKeyword',
	'MetaProperty', 'JsxNamespacedName',
]);
const TYPE_SKIP_KINDS = new Set(['ImportClause', 'ExportAssignment']);

// The NESTED field tables are the single source of truth for the field
// closure (F1) — parse them off tsgoChecker.ts so the 14 prop names have no
// second home; the parent's COVERAGE gate cross-checks the same parse.
function parseNestedTables() {
	const src = fs.readFileSync(path.join(repoRoot, 'patches', 'typescript', 'overlay', 'src', 'compiler', 'tsgoChecker.ts'), 'utf8');
	const rows = [];
	for (const table of ['NESTED_TYPE_SINGLE', 'NESTED_TYPE_ARRAY']) {
		const start = src.indexOf(`const ${table}`);
		if (start < 0) throw new Error(`no ${table} table in tsgoChecker.ts`);
		const end = src.indexOf('];', start);
		const block = src.slice(start, end);
		for (const m of block.matchAll(/\[\s*"([A-Za-z0-9]+)"\s*,\s*"([A-Za-z0-9]+)"\s*\]/g)) rows.push([m[1], m[2]]);
	}
	if (rows.length === 0) throw new Error('parsed no NESTED rows from tsgoChecker.ts');
	return rows;
}
const FULLWALK_NESTED = FULLWALK ? parseNestedTables() : null;

// F2 canon helpers (full-walk only): union-constituent multiset + member-list
// order. Inert outside full-walk — curated canon is untouched. The
// unresolved-error marker is stock-only rendering (stock typeToString of an
// unresolved error type is "/*unresolved*/ any"; tsgo renders "any" — engine
// error-type model), normalized like the LU2 rename.
// Truncation tails are the U2T residual: a typeToString with 100+ members
// keeps the visible head/tail in member order (stock resolution order vs
// tsgo table order — upstream #200 class), so the same member set prints
// different visible members. The marker survives, the order-dependent
// members around it do not; the full member set still compares through the
// member-list recs, so a dropped member cannot hide here.
function stripTruncatedMembers(s) {
	for (;;) {
		const m = s.match(/\.\.\. \d+ more \.\.\./);
		if (!m) return s;
		const i = m.index;
		let open = -1;
		for (let j = i - 1, depth = 0, str = null, tpl = false; j >= 0; j--) {
			const c = s[j];
			if (str) { if (c === str && s[j - 1] !== '\\') str = null; continue; }
			if (tpl) { if (c === '`') tpl = false; continue; }
			if (c === "'" || c === '"') { str = c; continue; }
			if (c === '`') { tpl = true; continue; }
			if (c === '}') depth++;
			else if (c === '{') { depth--; if (depth < 0) { open = j; break; } }
		}
		if (open < 0) return s;
		let close = -1;
		for (let j = open + 1, depth = 1, str = null, tpl = false; j < s.length; j++) {
			const c = s[j];
			if (str) { if (c === str && s[j - 1] !== '\\') str = null; continue; }
			if (tpl) { if (c === '`') tpl = false; continue; }
			if (c === "'" || c === '"') { str = c; continue; }
			if (c === '`') { tpl = true; continue; }
			if (c === '{') depth++;
			else if (c === '}') { depth--; if (depth === 0) { close = j; break; } }
		}
		if (close < 0) return s;
		s = s.slice(0, open + 1) + ' … ' + s.slice(close);
	}
}
// Depth-aware union multiset canon (full-walk only): U1 order divergences
// appear inside signatures and member annotations too ("readonly string[] |
// ArrayLike<string>"), where the top-level splitUnion cannot see them. This
// recurses into bracket groups — brace regions are member lists (their
// ';'-separated members recurse individually, member order stays compared),
// paren/bracket/angle regions recurse as one expression — and sorts the '|'
// constituents at every depth. A constituent that carries a leading context
// prefix (`name: `, `name?: `, `S extends `, `T = `) keeps the prefix on the
// sorted union. Known limitation (accepted, splitUnion-class): a conditional
// `T extends U ? X : Y | Z` normalizes as `T extends U ? X : (Y | Z)` — a
// false pass on that ambiguous rendering, never a false failure.
function consumeBalanced(s, openIdx) {
	const open = s[openIdx];
	const close = open === '(' ? ')' : open === '[' ? ']' : open === '<' ? '>' : '}';
	let depth = 1;
	for (let i = openIdx + 1; i < s.length; i++) {
		const c = s[i];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			i++;
			while (i < s.length && !(s[i] === q && s[i - 1] !== '\\')) i++;
			continue;
		}
		if (c === open) depth++;
		else if (c === close && (open !== '<' || s[i - 1] !== '=')) { depth--; if (depth === 0) return [s.slice(openIdx + 1, i), i]; }
	}
	return [s.slice(openIdx + 1), s.length - 1];
}
function lastPrefixColon(first) {
	let last = -1;
	let depth = 0;
	for (let i = 0; i < first.length - 1; i++) {
		const c = first[i];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			i++;
			while (i < first.length - 1 && !(first[i] === q && first[i - 1] !== '\\')) i++;
			continue;
		}
		if (c === '(' || c === '[' || c === '<' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '>' || c === '}') depth = Math.max(0, depth - 1);
		if (depth > 0) continue;
		if ((c === ':' || c === '=') && first[i + 1] === ' ') last = i + 2;
		else if (c === 's' && first.slice(i - 6, i + 1) === 'extends') last = i + 2;
	}
	return last;
}
function canonUnionSort(s) {
	let hadUnion = false;
	let cur = '';
	const parts = [];
	const flush = () => { parts.push(cur); cur = ''; };
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			cur += c;
			i++;
			while (i < s.length) {
				cur += s[i];
				if (s[i] === q && s[i - 1] !== '\\') break;
				i++;
			}
			continue;
		}
		if (c === '(' || c === '[' || c === '<' || c === '{') {
			const [content, end] = consumeBalanced(s, i);
			cur += c + (c === '{' ? canonBraceMembers(content) : canonUnionSort(content)) + (c === '(' ? ')' : c === '[' ? ']' : c === '<' ? '>' : '}');
			i = end;
			continue;
		}
		if (c === '|') { hadUnion = true; flush(); continue; }
		cur += c;
	}
	flush();
	if (!hadUnion) return parts[0];
	const first = parts[0];
	const cut = lastPrefixColon(first);
	const prefix = cut >= 0 ? first.slice(0, cut) : '';
	const rest = cut >= 0 ? first.slice(cut) : first;
	const trail = /\s*$/.exec(parts[parts.length - 1])[0];
	return prefix + [rest.trim(), ...parts.slice(1).map(p => p.trim())].sort().join(' | ') + trail;
}
function canonBraceMembers(content) {
	let cur = '';
	const members = [];
	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			cur += c;
			i++;
			while (i < content.length) {
				cur += content[i];
				if (content[i] === q && content[i - 1] !== '\\') break;
				i++;
			}
			continue;
		}
		if (c === '(' || c === '[' || c === '<' || c === '{') {
			const [inner, end] = consumeBalanced(content, i);
			cur += c + (c === '{' ? canonBraceMembers(inner) : canonUnionSort(inner)) + (c === '(' ? ')' : c === '[' ? ']' : c === '<' ? '>' : '}');
			i = end;
			continue;
		}
		if (c === ';') { members.push(cur); cur = ''; continue; }
		cur += c;
	}
	members.push(cur);
	return members.map(canonUnionSort).join(';');
}
const fullWalkCanonTypeStr = s => (typeof s === 'string'
	? canonUnionSort(stripTruncatedMembers(LU2_RENAME(s.replace(/\/\*unresolved\*\/ /g, ''))))
	: s);
const fullWalkListCanon = v => (FULLWALK && Array.isArray(v) ? [...v].sort((x, y) => (stable(x) < stable(y) ? -1 : 1)) : v);

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

	const tBuildStart = Date.now();
	const programs = FULLWALK
		? { main: buildProgram('tsconfig.json'), cjs: buildProgram('tsconfig.cjs.json'), js: buildProgram('tsconfig.js.json') }
		: { main: buildProgram('tsconfig.json'), cjs: buildProgram('tsconfig.cjs.json') };
	const tBuildEnd = Date.now();
	const entries = [];
	const rec = (m, at, v) => entries.push({ m, at, v });
	// Shape census (full-walk only): canonType is the only canon path that
	// records flags/objectFlags, so the set bits it collects are exactly the
	// shapes the differential compares.
	const census = FULLWALK ? { f: new Set(), of: new Set() } : null;

	for (const proj of FULLWALK ? ['main', 'cjs', 'js'] : ['main', 'cjs']) {
		const { program } = programs[proj];
		const checker = program.getTypeChecker();
		const isCorpusFile = p => path.dirname(p) === dir || path.dirname(p) === path.join(dir, 'cjs') || path.dirname(p) === path.join(dir, 'js');

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
		// Full-walk: type strings ride the F2 multiset canon.
		const canonTypeStr = s => (FULLWALK ? fullWalkCanonTypeStr(s) : s);
		const canonType = t => {
			if (t == null) return null;
			if (t.$err) return t;
			const f = t.flags >>> 0, of = (t.objectFlags ?? 0) & 0x7fff;
			if (census) {
				for (const b of decomposeBits(f, CENSUS_FLAG_MAX)) census.f.add(b);
				for (const b of decomposeBits(of, CENSUS_OF_MAX)) census.of.add(b);
			}
			return { s: tryQ(() => canonTypeStr(checker.typeToString(t))), f, of };
		};
		const canonProp = (s, locNode) => {
			if (s == null || s.$err) return canonSym(s);
			return { ...canonSym(s), t: tryQ(() => canonTypeStr(checker.typeToString(checker.getTypeOfSymbolAtLocation(s, locNode)))) };
		};
		const canonSig = sig => {
			if (sig == null) return null;
			if (sig.$err) return sig;
			const decl = sig.declaration ?? null;
			const params = tryQ(() => sig.getParameters());
			return {
				str: tryQ(() => canonTypeStr(checker.signatureToString(sig))),
				decl: decl ? canonDecl(decl) : null,
				params: params?.$err ? params : (params ?? []).map(p => ({
					...canonSym(p),
					t: tryQ(() => canonTypeStr(checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl ?? p.valueDeclaration ?? p.declarations?.[0])))),
				})),
				ret: tryQ(() => canonTypeStr(checker.typeToString(checker.getReturnTypeOfSignature(sig)))),
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
			rec('typeToString', at, tryQ(() => canonTypeStr(checker.typeToString(t))));
			rec('typeToString[NoTrunc]', at, tryQ(() => canonTypeStr(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation))));
			rec('getApparentType', at, canonType(tryQ(() => checker.getApparentType(t))));
			rec('getPropertiesOfType', at, tryQ(() => fullWalkListCanon(checker.getPropertiesOfType(t).map(p => canonProp(p, node)))));
			rec('getApparentProperties', at, tryQ(() => fullWalkListCanon(t.getApparentProperties().map(p => canonProp(p, node)))));
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
		// F1: the NESTED lazy-accessor closure. Absent reads on the stock side
		// are plain undefined (canon null); on the bridge a wire-present field
		// fires the registry RPC — exactly the Go-side As*() cast path. The
		// bridge documents empty array ≡ absent, so empty arrays canon to null.
		const canonFieldValue = (v, primary, prop) => {
			if (v == null) return null;
			if (Array.isArray(v)) return v.length === 0 ? null : v.map(canonType);
			const c = canonType(v);
			// Stock and tsgo disagree on the enum fresh/regular self-pairing
			// direction (triage-type-field-audit conditionalExemption): stock
			// attaches it to enum unions, tsgo to enum literals — the value
			// string-equals the enclosing type on both. The pairing is never
			// consumed on those types, so normalize it to absent.
			return c && primary && (prop === 'freshType' || prop === 'regularType') && c.s === primary.s ? null : c;
		};
		// StringLiteral whose parent makes it a module specifier: import/
		// export declarations, import-equals (ExternalModuleReference), and
		// require()/import() calls.
		const isModuleSpecifier = node => {
			if (node.kind !== ts.SyntaxKind.StringLiteral) return false;
			const p = node.parent;
			if (!p) return false;
			switch (p.kind) {
				case ts.SyntaxKind.ImportDeclaration:
				case ts.SyntaxKind.ExternalModuleReference:
					return true;
				case ts.SyntaxKind.ExportDeclaration:
					return p.moduleSpecifier === node;
				case ts.SyntaxKind.CallExpression:
					return p.arguments[0] === node && (
						(p.expression.kind === ts.SyntaxKind.Identifier && p.expression.text === 'require')
						|| p.expression.kind === ts.SyntaxKind.ImportKeyword);
				default:
					return false;
			}
		};
		// Every corpus node (never lib files) runs the POINTS batteries with
		// the curated props list dropped, plus the field closure on each of
		// the three primary types. SourceFile nodes get the module battery
		// only and module-specifier StringLiterals the resolve battery only —
		// the same shape the curated module/spec points use.
		//
		// Every rec fires unconditionally, with null when the primary is
		// absent. The structure must be a function of the node only: the
		// walk's own first run found null-ness divergences (stock's
		// getSymbolAtLocation has no ExportAssignment case, so it returns
		// undefined where tsgo returns the export= symbol), and a battery
		// that runs conditionally on a divergent primary desynchronizes the
		// lockstep comparison. Unconditional recs turn "stock null vs bridge
		// value" into an ordinary DIFF instead of a harness-bug FAIL.
		const fullWalkNodeRec = (node, at) => {
			if (node.kind === ts.SyntaxKind.SourceFile) {
				const modSym = tryQ(() => checker.getSymbolAtLocation(node));
				rec('getSymbolAtLocation[module]', at, canonSym(modSym));
				rec('getExportsOfModule', at, modSym && !modSym.$err ? tryQ(() => fullWalkListCanon(checker.getExportsOfModule(modSym).map(p => canonProp(p, node)))) : null);
				rec('getTypeOfSymbolAtLocation[module]', at, modSym && !modSym.$err ? canonType(tryQ(() => checker.getTypeOfSymbolAtLocation(modSym, node))) : null);
				return;
			}
			if (isModuleSpecifier(node)) {
				const resolved = tryQ(() => checker.resolveExternalModuleName(node));
				rec('resolveExternalModuleName', at, canonSym(resolved));
				rec('getSymbolAtLocation[specifier]', at, canonSym(tryQ(() => checker.getSymbolAtLocation(node))));
				rec('getExportsOfModule', at, resolved && !resolved.$err ? tryQ(() => fullWalkListCanon(checker.getExportsOfModule(resolved).map(p => canonProp(p, node)))) : null);
				return;
			}
			if (TYPE_SKIP_KINDS.has(ts.SyntaxKind[node.kind])) return; // stock-contract gap, see above
			const t = tryQ(() => checker.getTypeAtLocation(node));
			const tb = t && !t.$err ? t : null;
			const tCanon = canonType(tb);
			rec('getTypeAtLocation', at, tCanon);
			rec('typeToString', at, tb ? tryQ(() => canonTypeStr(checker.typeToString(tb))) : null);
			rec('typeToString[NoTrunc]', at, tb ? tryQ(() => canonTypeStr(checker.typeToString(tb, undefined, ts.TypeFormatFlags.NoTruncation))) : null);
			rec('getApparentType', at, tb ? canonType(tryQ(() => checker.getApparentType(tb))) : null);
			rec('getPropertiesOfType', at, tb ? tryQ(() => fullWalkListCanon(checker.getPropertiesOfType(tb).map(p => canonProp(p, node)))) : null);
			rec('getApparentProperties', at, tb ? tryQ(() => fullWalkListCanon(tb.getApparentProperties().map(p => canonProp(p, node)))) : null);
			rec('getCallSignatures', at, tb ? tryQ(() => tb.getCallSignatures().map(canonSig)) : null);
			rec('getConstructSignatures', at, tb ? tryQ(() => tb.getConstructSignatures().map(canonSig)) : null);
			rec('getBaseConstraintOfType', at, tb ? canonType(tryQ(() => checker.getBaseConstraintOfType(tb))) : null);
			rec('Type.getConstraint', at, tb ? canonType(tryQ(() => tb.getConstraint?.())) : null);
			// The three closures share the node label; suffix the field recs
			// with their source ([t]/[t1]/[t2]) so a closure that converges
			// (e.g. the declared-type closure on the Abs error node) doesn't
			// stale-fail an exemption keyed on a diverging sibling closure.
			for (const [prop] of FULLWALK_NESTED) rec(`field:${prop}`, `${at}[t]`, tb ? canonFieldValue(tryQ(() => tb[prop]), tCanon, prop) : null);
			if (!SYMBOL_CONTRACT_KINDS.has(ts.SyntaxKind[node.kind])) return;
			const sym = tryQ(() => checker.getSymbolAtLocation(node));
			const sb = sym && !sym.$err ? sym : null;
			rec('getSymbolAtLocation', at, canonSym(sb));
			const t1 = sb ? tryQ(() => checker.getTypeOfSymbolAtLocation(sb, node)) : null;
			const t1Canon = canonType(t1);
			rec('getTypeOfSymbolAtLocation', at, t1Canon);
			for (const [prop] of FULLWALK_NESTED) rec(`field:${prop}`, `${at}[t1]`, t1 && !t1.$err ? canonFieldValue(tryQ(() => t1[prop]), t1Canon, prop) : null);
			const t2 = sb ? tryQ(() => checker.getDeclaredTypeOfSymbol(sb)) : null;
			const t2Canon = canonType(t2);
			rec('getDeclaredTypeOfSymbol', at, t2Canon);
			for (const [prop] of FULLWALK_NESTED) rec(`field:${prop}`, `${at}[t2]`, t2 && !t2.$err ? canonFieldValue(tryQ(() => t2[prop]), t2Canon, prop) : null);
			const alias = sb && (sb.flags & ts.SymbolFlags.Alias) ? sb : null;
			rec('getAliasedSymbol', at, alias ? canonSym(tryQ(() => checker.getAliasedSymbol(alias))) : null);
			const chain = [];
			let cur = alias;
			while (cur) {
				const imm = tryQ(() => checker.getImmediateAliasedSymbol(cur));
				if (imm == null || imm.$err) { if (imm?.$err) chain.push(imm); break; }
				chain.push(canonSym(imm));
				if (!(imm.flags & ts.SymbolFlags.Alias) || chain.length >= 8) break;
				cur = imm;
			}
			rec('getImmediateAliasedSymbol.chain', at, alias ? chain : null);
		};

		// Stock exposes one relation (isTypeAssignableTo) plus type predicates;
		// the ordered-pair matrix over relations.ts's declared alias types is
		// what makes relation parity checkable without the big nets.
		const relationBattery = () => {
			const { text } = sfOf('relations.ts');
			const types = [];
			for (const [, name] of text.matchAll(/^export type (R_\w+) =/gm)) {
				const sym = tryQ(() => checker.getSymbolAtLocation(locate({ file: 'relations.ts', label: name, needle: `${name} =` })));
				const t = sym && !sym.$err ? tryQ(() => checker.getDeclaredTypeOfSymbol(sym)) : sym;
				rec('relation:type', name, canonType(t));
				if (t && !t.$err) types.push([name, t]);
			}
			if (types.length < 60) throw new Error(`relations.ts yielded ${types.length} alias types (${side})`);
			for (const [name, t] of types) {
				for (const pred of RELATION_PREDICATES) rec(pred, name, tryQ(() => checker[pred](t)));
			}
			for (const [sn, s] of types) {
				for (const [tn, t] of types) rec('isTypeAssignableTo', `${sn}->${tn}`, tryQ(() => checker.isTypeAssignableTo(s, t)));
			}
		};

		if (FULLWALK) {
			for (const rel of FULLWALK_FILES) {
				if (projOfFile(rel) !== proj) continue;
				if (FULLWALK_FILE !== undefined && FULLWALK_FILE !== rel) continue;
				const sf = program.getSourceFile(path.join(dir, rel));
				if (FULLWALK_NO_PROGRAM.has(rel)) {
					if (sf) throw new Error(`${rel} unexpectedly in the ${proj} program (${side}) — update FULLWALK_NO_PROGRAM`);
					continue;
				}
				if (!sf) throw new Error(`no SourceFile for ${rel} (${side})`);
				const visit = node => {
					const at = `${rel}:${node.pos}:${ts.SyntaxKind[node.kind]}`;
					fullWalkNodeRec(node, at);
					ts.forEachChild(node, visit);
				};
				visit(sf);
			}
			continue;
		}

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
		if (proj === 'main') relationBattery();
	}

	for (const p of Object.values(programs)) p.watch.close?.();
	if (!FULLWALK) return { side, entries };
	return {
		side, file: FULLWALK_FILE ?? 'all', entries,
		timing: { buildMs: tBuildEnd - tBuildStart, walkMs: Date.now() - tBuildEnd },
		census: census ? { f: [...census.f].sort((a, b) => a - b), of: [...census.of].sort((a, b) => a - b) } : null,
	};
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
	fs.writeFileSync(path.join(dir, 'tsconfig.js.json'), JSON.stringify(JS_TSCONFIG, null, 2));
}

function runChild(side, dir, extraEnv, maxBuffer) {
	const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir], {
		env: { ...process.env, TNB_DIFF_SIDE: side, ...extraEnv },
		encoding: 'utf8', timeout: 300_000, maxBuffer: maxBuffer ?? 64 * 1024 * 1024,
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

// ── Known-exemption shape validation ────────────────────────────────────────
// Ordering-class exemptions (U1/U2/U2T/LU2) claim "same content, different
// order". Before green-lighting a known key, re-verify that claim on the raw
// values: a divergence at an exempted coordinate that is not a permutation
// (wrong member name, wrong union constituent, drifted flags) is a genuine bug
// riding on the exemption and must FAIL as KNOWN-SHAPE-VIOLATION.
const ORDERING_CLASSES = new Set(['U1', 'U2', 'U2T', 'LU2']);
// REASON tokens are class prefixes; the compound 'L+U2' (lib delta + member
// order) is the LU2 ordering class.
const classOf = reason => (reason.startsWith('L+U2') ? 'LU2' : reason.split(':')[0]);
const multisetEq = (a, b) => {
	if (a.length !== b.length) return false;
	const sa = [...a].sort(), sb = [...b].sort();
	return sa.every((x, i) => x === sb[i]);
};
// LU2's documented lib delta is the padStart/padEnd parameter rename (the U2
// part is member order). Normalize the rename so full-element multiset
// equality holds iff the only content difference is exactly that rename.
const LU2_RENAME = t => (typeof t === 'string' ? t.replace(/\bmaxLength\b/g, 'targetLength').replace(/\bfillString\b/g, 'padString') : t);
const arrayShapeOk = (a, b, keyOf) => {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	return multisetEq(a.map(keyOf), b.map(keyOf));
};
// Split a type string at top-level `|`s only: quoted strings, tuples, object
// types, generics and template literals keep their inner `|`s.
// Known limitation: a function type with a union return (`() => A | B`) is
// split at the `|` after its parameter list — that `|` sits at depth 0 — so
// it is indistinguishable from a genuine top-level union `() => A | B` and
// can compare equal to it on the U1 multiset path (a false pass, never a
// false failure).
function splitUnion(s) {
	const parts = [];
	let cur = '';
	const stack = [];
	let str = null;
	const flush = () => { parts.push(cur.trim()); cur = ''; };
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (str) {
			cur += c;
			if (c === '\\') cur += s[++i] ?? '';
			else if (c === str) str = null;
			continue;
		}
		if (stack[stack.length - 1] === '`') {
			cur += c;
			if (c === '\\') cur += s[++i] ?? '';
			else if (c === '`') stack.pop();
			else if (c === '$' && s[i + 1] === '{') { stack.push('${'); cur += '{'; i++; }
			continue;
		}
		if (c === "'" || c === '"') { str = c; cur += c; continue; }
		if (c === '`') { stack.push('`'); cur += c; continue; }
		if (c === '(') { stack.push('('); cur += c; continue; }
		if (c === ')') { if (stack[stack.length - 1] === '(') stack.pop(); cur += c; continue; }
		if (c === '[') { stack.push('['); cur += c; continue; }
		if (c === ']') { if (stack[stack.length - 1] === '[') stack.pop(); cur += c; continue; }
		if (c === '{') { stack.push('{'); cur += c; continue; }
		if (c === '}') { if (stack[stack.length - 1] === '{' || stack[stack.length - 1] === '${') stack.pop(); cur += c; continue; }
		if (c === '<') { stack.push('<'); cur += c; continue; }
		if (c === '>') { if (stack[stack.length - 1] === '<') stack.pop(); cur += c; continue; }
		if (c === '|' && stack.length === 0) { flush(); continue; }
		cur += c;
	}
	flush();
	return parts;
}
const isCanonType = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.s === 'string' && typeof v.f === 'number' && typeof v.of === 'number';
const u1ShapeOk = (a, b) => {
	if (typeof a === 'string' && typeof b === 'string') return multisetEq(splitUnion(a), splitUnion(b));
	if (isCanonType(a) && isCanonType(b)) {
		return a.f === b.f && a.of === b.of && multisetEq(splitUnion(a.s), splitUnion(b.s));
	}
	return false;
};
function checkKnownShape(cls, a, b) {
	switch (cls) {
		case 'U1': return u1ShapeOk(a, b);
		case 'U2': return arrayShapeOk(a, b, e => stable(e));
		case 'U2T': return arrayShapeOk(a, b, e => stable({ ...e, t: undefined }));
		case 'LU2': return arrayShapeOk(a, b, e => stable({ ...e, t: LU2_RENAME(e.t) }));
		default: return true; // non-ordering classes (U3) are unchecked
	}
}

function compareEntries(aList, bList) {
	let fail = 0, ok = 0, known = 0;
	for (let i = 0; i < aList.length; i++) {
		const a = aList[i], b = bList[i];
		const key = `${a.m}@${a.at}`;
		if (a.m !== b.m || a.at !== b.at) {
			console.error(`FAIL entry misalignment at #${i} (harness bug): stock=${key} tnb=${b.m}@${b.at}`);
			fail++;
			continue;
		}
		const sa = stable(a.v), sb = stable(b.v);
		const why = (FULLWALK ? FULLWALK_KNOWN : KNOWN_DIVERGENCES).get(key);
		if (sa === sb) {
			if (why !== undefined) {
				console.log(`FAIL ${key}: STALE EXEMPTION — sides converged, remove the ${FULLWALK ? 'FULLWALK_KNOWN' : 'KNOWN_DIVERGENCES'} entry (${why})`);
				fail++;
			} else ok++;
			continue;
		}
		if (why !== undefined) {
			const cls = classOf(why);
			if (ORDERING_CLASSES.has(cls) && !checkKnownShape(cls, a.v, b.v)) {
				fail++;
				console.log(`KNOWN-SHAPE-VIOLATION ${key} — ${why}`);
				console.log(`  stock: ${sa.slice(0, 600)}`);
				console.log(`  tnb  : ${sb.slice(0, 600)}`);
				continue;
			}
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
	return { ok, known, fail };
}

function parentMain() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-checker-diff-'));
	writeCorpus(dir);
	const stock = runChild('stock', dir);
	const tnb = runChild('tnb', dir);
	console.log(`fixture: ${dir}`);
	console.log(`entries: stock=${stock.entries.length} tnb=${tnb.entries.length}`);
	if (stock.entries.length !== tnb.entries.length) {
		console.error(`FAIL entry count mismatch (harness bug): stock=${stock.entries.length} tnb=${tnb.entries.length}`);
		process.exit(1);
	}
	const { ok, known, fail } = compareEntries(stock.entries, tnb.entries);
	console.log(`\nVERDICT: ${fail === 0 ? 'PASS' : 'FAIL'} (${ok} ok, ${known} known, ${fail} diffs)`);
	process.exit(fail === 0 ? 0 : 1);
}

// ── RPC-method coverage gate (--full-walk) ─────────────────────────────────
// A new RPC method must not ship unwalked: every method the JS side can call
// needs a COVERAGE entry naming the battery that exercises it (or an exempt
// reason). The two parse sources are the Go method set (proto.go constants)
// and the JS-callable surface (ARENA_METHODS keys in tsgoTransport.ts + the
// JSON-path literals in tsgoChecker.ts). Session lifecycle and IDE paths are exempt
// by the documented tradeoffs (AGENTS.md) — the gate's job is the decision
// being explicit, not the walk covering the whole surface.
const COVERAGE = new Map([
	// battery = the typeBattery run on every node's getTypeAtLocation result
	['getTypeAtLocation', 'battery'],
	['getApparentType', 'battery'],
	['getPropertiesOfType', 'battery'],
	['getAugmentedPropertiesOfType', 'battery'], // Type.getApparentProperties
	['getSignaturesOfType', 'battery'], // Type.getCallSignatures/getConstructSignatures
	['getBaseConstraintOfType', 'battery'], // + Type.getConstraint
	['typeToString', 'battery'],
	['getReturnTypeOfSignature', 'battery'], // canonSig
	['getParametersOfSignature', 'battery'], // canonSig
	['getTypeParametersOfSignature', 'battery'], // canonSig
	['getSymbolsDeclarations', 'battery'], // canonSym declarations
	// symbol-battery = getSymbolAtLocation + its symbol chain per node
	['getSymbolAtLocation', 'symbol-battery'],
	['getTypeOfSymbolAtLocation', 'symbol-battery'],
	['getDeclaredTypeOfSymbol', 'symbol-battery'],
	['getAliasedSymbol', 'symbol-battery'],
	['getImmediateAliasedSymbol', 'symbol-battery'],
	// spec-battery = resolveExternalModuleName on module-specifier literals
	['resolveExternalModuleName', 'spec-battery'],
	// module-battery = getSymbolAtLocation(SourceFile) + exports per file
	['getExportsOfModule', 'module-battery'],
	// field:<prop> = the 14-field NESTED lazy-accessor closure (F1)
	['getTargetOfType', 'field:target'],
	['getThisTypeOfType', 'field:thisType'],
	['getFreshTypeOfType', 'field:freshType'],
	['getRegularTypeOfType', 'field:regularType'],
	['getObjectTypeOfType', 'field:objectType'],
	['getIndexedAccessIndexType', 'field:indexType'],
	['getCheckTypeOfType', 'field:checkType'],
	['getExtendsTypeOfType', 'field:extendsType'],
	['getBaseTypeOfType', 'field:baseType'],
	['getConstraintOfType', 'field:substConstraint'],
	['getTypeParametersOfType', 'field:typeParameters'],
	['getOuterTypeParametersOfType', 'field:outerTypeParameters'],
	['getLocalTypeParametersOfType', 'field:localTypeParameters'],
	['getAliasTypeArgumentsOfType', 'field:aliasTypeArguments'],
	// exempt — not reachable from the walk; the reason names where parity
	// rests instead (services paths ride sim-nav/volar; IDE paths ride the
	// IDE-sim and arena-parity witnesses). relation-battery = the curated-mode
	// relations.ts matrix (triage-checker-differential, not the full walk).
	['getResolvedSignature', 'exempt: signature-from-node lookup — IDE sims/volar path'],
	['getContextualType', 'exempt: contextual typing — sim-nav/volar path'],
	['getContextualTypeForArgumentAtIndex', 'exempt: contextual typing — sim-nav/volar path'],
	['getBaseTypeOfLiteralType', 'exempt: services helper — sim-nav/volar path'],
	['getNonNullableType', 'exempt: services helper — sim-nav/volar path'],
	['getTypeArguments', 'exempt: services helper — sim-nav/volar path'],
	['getBaseTypes', 'exempt: services helper — sim-nav/volar path'],
	['getSymbolOfType', 'exempt: Type.symbol backfill — sim-nav/volar path'],
	['getTypesOfType', 'exempt: services helper — sim-nav/volar path'],
	['isArrayType', 'relation-battery'],
	['getTypeOfSymbol', 'exempt: host-fast services path'],
	['getSymbolAtPosition', 'exempt: position API — IDE sims'],
	['quickinfo', 'exempt: IDE hover path — arena-parity + IDE sims'],
	['references', 'exempt: IDE path'],
	['definitionAndBoundSpan', 'exempt: IDE path'],
	['getRootSymbols', 'exempt: services helper'],
	['getExportsAndPropertiesOfModule', 'exempt: services helper (tsserver export maps)'],
	['getExportsOfSymbol', 'exempt: services helper'],
	['getMembersOfSymbol', 'exempt: services helper'],
	['getParentOfSymbol', 'exempt: Symbol.parent — services path'],
	['getExportSymbolOfSymbol', 'exempt: services helper (tsserver)'],
	['getGlobalExportsOfSymbol', 'exempt: triage-symbol-global-exports'],
	['getDocumentationComment', 'exempt: quickinfo/docs path'],
	['resolveExternalModuleSymbol', 'exempt: host-side module resolution internals'],
	['symbolIsValue', 'exempt: services helper'],
	['getLocalTypeParametersOfClassOrInterfaceOrTypeAlias', 'exempt: services helper'],
	['getJsDocTags', 'exempt: docs path'],
	['collectVisitedTypeParameters', 'exempt: services helper'],
	['createArrayType', 'exempt: type factory'],
	['createPromiseType', 'exempt: type factory'],
	['getAwaitedType', 'exempt: services helper'],
	['getConstraintOfTypeParameter', 'exempt: Type.getConstraint routes to getBaseConstraintOfType in the adapter'],
	['getDefaultFromTypeParameter', 'exempt: Type.getDefault — services path'],
	['getElementTypeOfArrayType', 'exempt: services helper'],
	['getExactOptionalProperties', 'exempt: services helper'],
	['getPromisedTypeOfPromise', 'exempt: services helper'],
	['getWidenedLiteralType', 'exempt: services helper'],
	['isEmptyAnonymousObjectType', 'relation-battery'],
	['isLibType', 'exempt: services helper'],
	['isNullableType', 'relation-battery'],
	['isTupleType', 'relation-battery'],
	['typeHasCallOrConstructSignatures', 'exempt: services helper'],
	['getFalseTypeOfConditionalType', 'exempt: services helper'],
	['getTrueTypeOfConditionalType', 'exempt: services helper'],
	['getAliasSymbolOfType', 'exempt: services helper'],
	['getAnyType', 'exempt: intrinsic singleton (factory)'],
	['getBigIntType', 'exempt: intrinsic singleton (factory)'],
	['getBooleanType', 'exempt: intrinsic singleton (factory)'],
	['getESSymbolType', 'exempt: intrinsic singleton (factory)'],
	['getErrorType', 'exempt: intrinsic singleton (factory)'],
	['getNeverType', 'exempt: intrinsic singleton (factory)'],
	['getNonPrimitiveType', 'exempt: intrinsic singleton (factory)'],
	['getNullType', 'exempt: intrinsic singleton (factory)'],
	['getNumberType', 'exempt: intrinsic singleton (factory)'],
	['getOptionalType', 'exempt: intrinsic singleton (factory)'],
	['getPromiseLikeType', 'exempt: intrinsic singleton (factory)'],
	['getPromiseType', 'exempt: intrinsic singleton (factory)'],
	['getStringType', 'exempt: intrinsic singleton (factory)'],
	['getUndefinedType', 'exempt: intrinsic singleton (factory)'],
	['getUnknownType', 'exempt: intrinsic singleton (factory)'],
	['getVoidType', 'exempt: intrinsic singleton (factory)'],
	['getAnyAsyncIterableType', 'exempt: intrinsic singleton (factory)'],
	['containsArgumentsReference', 'exempt: emit helper'],
	['getContextualTypeForJsxAttribute', 'exempt: JSX path — framework-checks'],
	['getTypeArgumentConstraint', 'exempt: services helper'],
	['getTypeOfAssignmentPattern', 'exempt: services helper'],
	['isDeclarationVisible', 'exempt: services helper'],
	['isImplementationOfOverload', 'exempt: services helper'],
	['isOptionalParameter', 'exempt: services helper'],
	['requiresAddingImplicitUndefined', 'exempt: services helper'],
	['getJsxFragmentFactory', 'exempt: JSX path'],
	['getJsxIntrinsicTagNamesAt', 'exempt: JSX path'],
	['getPropertySymbolOfDestructuringAssignment', 'exempt: services helper'],
	['getSignatureFromDeclaration', 'exempt: services helper'],
	['getExportSpecifierLocalTargetSymbol', 'exempt: services helper'],
	['getRestTypeOfSignature', 'exempt: services helper'],
	['getTypeArgumentsForResolvedSignature', 'exempt: services helper'],
	['getTargetOfSignature', 'exempt: Signature.target — services path'],
	['getThisParameterOfSignature', 'exempt: services helper'],
	['hasEffectiveRestParameter', 'exempt: services helper'],
	['getExpandedParameters', 'exempt: completions path'],
	['getPropertyOfType', 'exempt: curated-POINTS props only — the full-walk drops the curated props list; property-lookup parity rests on sim-nav/volar'],
	['getTypeOfPropertyOfType', 'exempt: services helper'],
	['getTypeOfPropertyOfContextualType', 'exempt: services helper'],
	['getStringLiteralType', 'exempt: type factory'],
	['getBigIntLiteralType', 'exempt: type factory'],
	['getNumberLiteralType', 'exempt: type factory'],
	['getTypeAtPosition', 'exempt: position API'],
	['getModuleSymbolForSourceFile', 'exempt: position/file API — the walk uses getSymbolAtLocation(SourceFile)'],
	['getAccessibleSymbolChain', 'exempt: completions path'],
	['getCandidateSignaturesForStringLiteralCompletions', 'exempt: completions path'],
	['tryGetThisTypeAt', 'exempt: services helper'],
	['getParentsOfSymbols', 'exempt: services helper'],
	['getAmbientModules', 'exempt: services helper'],
	['getCompletionsAtPosition', 'exempt: IDE completions path'],
	['signatureHelp', 'exempt: IDE path'],
	['getRenameInfo', 'exempt: IDE path'],
	['getEditsForRename', 'exempt: IDE path'],
	['initialize', 'exempt: session lifecycle'],
	['updateSnapshot', 'exempt: session lifecycle'],
	['resolveCompletionItem', 'exempt: IDE completions path'],
]);

function coverageGate() {
	const goPath = path.join(repoRoot, 'typescript-go', 'internal', 'api', 'proto.go');
	const goMethods = new Set();
	const notes = [];
	if (fs.existsSync(goPath)) {
		const goSrc = fs.readFileSync(goPath, 'utf8');
		for (const m of goSrc.matchAll(/Method[A-Za-z0-9]+[ \t]+Method = "([A-Za-z0-9]+)"/g)) goMethods.add(m[1]);
	} else {
		// The isolated tools copy (ci.yml witness job) symlinks lib/native/
		// vendor/patches/bin but not the typescript-go submodule — the Go
		// surface cross-check cannot run there. Said, not silent: every hard
		// FAIL below parses tsgoChecker.ts, which is present in both layouts.
		notes.push('go-surface cross-check skipped: typescript-go/internal/api/proto.go not present (isolated tools copy)');
	}

	const compilerDir = path.join(repoRoot, 'patches', 'typescript', 'overlay', 'src', 'compiler');
	const tsSrc = fs.readFileSync(path.join(compilerDir, 'tsgoChecker.ts'), 'utf8');
	const transportSrc = fs.readFileSync(path.join(compilerDir, 'tsgoTransport.ts'), 'utf8');
	const arenaStart = transportSrc.indexOf('const ARENA_METHODS');
	if (arenaStart < 0) throw new Error('no ARENA_METHODS table in tsgoTransport.ts');
	const arenaBlock = transportSrc.slice(arenaStart, transportSrc.indexOf(']);', arenaStart));
	const arenaMethods = new Set();
	for (const m of arenaBlock.matchAll(/\[\s*"([A-Za-z0-9]+)"\s*,\s*\[/g)) arenaMethods.add(m[1]);
	// JSON-path literals in tsgoChecker.ts (the non-arena surface it calls by
	// name): apiRequest("…") and tsgoLsApiRequest(…, "…") call sites.
	const jsonMethods = new Set();
	for (const m of tsSrc.matchAll(/apiRequest\(\s*"([A-Za-z0-9]+)"/g)) jsonMethods.add(m[1]);
	for (const m of tsSrc.matchAll(/tsgoLsApiRequest\([^,]+,\s*"([A-Za-z0-9]+)"/g)) jsonMethods.add(m[1]);

	const nested = parseNestedTables();
	const nestedProps = new Set(nested.map(([prop]) => prop));
	const nestedFetch = new Map(nested.map(([prop, method]) => [method, prop]));

	const errors = [];
	const surface = new Set([...arenaMethods, ...jsonMethods]);
	if (goMethods.size > 0) {
		for (const m of surface) {
			if (!goMethods.has(m)) errors.push(`${m}: JS-callable but missing from the Go method set (proto.go) — the bridge could not dispatch it`);
		}
	}
	for (const m of surface) {
		if (!COVERAGE.has(m)) errors.push(`${m}: JS-callable method with no COVERAGE entry — walk it or exempt it`);
	}
	for (const m of COVERAGE.keys()) {
		if (!surface.has(m)) errors.push(`${m}: stale COVERAGE entry — method no longer JS-callable`);
	}
	for (const [method, prop] of nestedFetch) {
		if (!surface.has(method)) errors.push(`field:${prop}: NESTED fetch method ${method} is not JS-callable`);
		if (COVERAGE.get(method) !== `field:${prop}`) errors.push(`field:${prop}: COVERAGE must map ${method} → field:${prop} (NESTED tables are the single source of truth)`);
	}
	for (const p of nestedProps) {
		if (![...COVERAGE.values()].includes(`field:${p}`)) errors.push(`field:${p}: NESTED prop has no field: coverage entry — the closure must read every NESTED prop`);
	}
	for (const [m, v] of COVERAGE) {
		if (!/^(battery|symbol-battery|spec-battery|module-battery|relation-battery|field:[A-Za-z0-9]+|exempt: .+)$/.test(v)) errors.push(`${m}: bad COVERAGE value ${JSON.stringify(v)}`);
	}
	let exempt = 0;
	for (const v of COVERAGE.values()) if (v.startsWith('exempt:')) exempt++;
	const summary = `coverage: ${surface.size} JS-callable methods (${arenaMethods.size} arena + ${jsonMethods.size} json-path; ${goMethods.size} in the Go surface), ${COVERAGE.size} coverage entries (${exempt} exempt)${notes.length ? ` — ${notes[0]}` : ''}`;
	return { errors, summary };
}

// ── Full-walk parent ────────────────────────────────────────────────────────
// One stock child walks every corpus file; the tnb side runs one child per
// corpus file so a Go panic (process-fatal in the bridge) only kills its own
// file's walk — the parent collects every crash in one run. Children run in
// a small parallel pool (independent processes, read-only fixture); the
// parent re-concatenates entries in the fixed FULLWALK_FILES order.
function spawnChild(side, dir, extraEnv) {
	return new Promise(resolve => {
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir], {
			env: { ...process.env, TNB_DIFF_SIDE: side, ...extraEnv },
		});
		let out = '', err = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', d => { out += d; });
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', d => { err += d; });
		const killTimer = setTimeout(() => child.kill('SIGKILL'), 300_000);
		child.on('close', status => {
			clearTimeout(killTimer);
			resolve({ status, out, err });
		});
	});
}

const FULLWALK_JOBS = 4; // parallel tnb children — panics are isolated either way

const finalVerdict = ({ crashes, fail }) => (crashes > 0 || fail > 0 ? 'FAIL' : 'PASS');

async function parentMainFullWalk() {
	const { errors, summary } = coverageGate();
	if (errors.length) {
		for (const e of errors) console.error(`COVERAGE-FAIL ${e}`);
		process.exit(1);
	}
	console.log(summary);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-checker-fullwalk-'));
	writeCorpus(dir);
	const t0 = Date.now();
	const stock = runChild('stock', dir, { TNB_DIFF_FULLWALK: '1' }, 512 * 1024 * 1024);
	const t1 = Date.now();
	const tnb = await runTnbPool(dir);
	const t2 = Date.now();
	console.log(`fixture: ${dir}`);
	const crashes = tnb.filter(r => r.crash);
	for (const c of crashes) console.error(`CRASH ${c.file}\n${c.stderr.slice(-2000)}`);
	const okFiles = tnb.filter(r => !r.crash);
	// per-file misalignment = harness bug: a child must emit only its own file's labels
	for (const r of okFiles) {
		if (r.result.file !== r.file) {
			console.error(`FAIL per-file misalignment (harness bug): child asked for ${r.file} reported ${r.result.file}`);
			process.exit(1);
		}
		const bad = r.result.entries.find(e => !e.at.startsWith(`${r.file}:`));
		if (bad) {
			console.error(`FAIL per-file misalignment (harness bug): child for ${r.file} emitted ${bad.m}@${bad.at}`);
			process.exit(1);
		}
	}
	// The stock stream is file-contiguous in FULLWALK_FILES order: slice it
	// into per-file segments so a crashed tnb file only punches a hole in its
	// own segment — every crash is reported above, the surviving files still
	// compare, and the final verdict is FAIL.
	const stockSegments = new Map();
	let idx = 0;
	for (const rel of FULLWALK_FILES) {
		const seg = [];
		while (idx < stock.entries.length && stock.entries[idx].at.startsWith(`${rel}:`)) seg.push(stock.entries[idx++]);
		stockSegments.set(rel, seg);
	}
	if (idx !== stock.entries.length) {
		console.error(`FAIL stock entry misalignment (harness bug): ${stock.entries[idx].m}@${stock.entries[idx].at} belongs to no walk file`);
		process.exit(1);
	}
	let ok = 0, known = 0, fail = 0, compared = 0;
	for (const rel of FULLWALK_FILES) {
		const r = okFiles.find(x => x.file === rel);
		const seg = stockSegments.get(rel);
		if (r && seg.length !== r.result.entries.length) {
			console.error(`FAIL entry count mismatch for ${rel} (harness bug): stock=${seg.length} tnb=${r.result.entries.length}`);
			process.exit(1);
		}
		if (r) {
			const c = compareEntries(seg, r.result.entries);
			ok += c.ok; known += c.known; fail += c.fail;
			compared++;
		}
	}
	const tnbTotal = okFiles.reduce((a, r) => a + r.result.entries.length, 0);
	console.log(`entries: stock=${stock.entries.length} tnb=${tnbTotal} (${compared}/${FULLWALK_FILES.length} files compared${crashes.length ? `, ${crashes.length} crashed` : ''})`);
	const st = stock.timing;
	const tt = okFiles.reduce((a, r) => ({ build: a.build + r.result.timing.buildMs, walk: a.walk + r.result.timing.walkMs }), { build: 0, walk: 0 });
	console.log(`timing: stock build ${(st.buildMs / 1000).toFixed(1)}s + walk ${(st.walkMs / 1000).toFixed(1)}s; tnb ${okFiles.length} children: build ${(tt.build / 1000).toFixed(1)}s + walk ${(tt.walk / 1000).toFixed(1)}s (sum) over ${((t2 - t1) / 1000).toFixed(1)}s wall; total ${((t2 - t0) / 1000).toFixed(1)}s`);
	// Shape census: union per side (a crashed child just contributes nothing —
	// the crash already FAILs the run), then gate the union against the fork
	// bundle's enums.
	const tnbCensus = { f: new Set(), of: new Set() };
	for (const r of okFiles) {
		for (const b of r.result.census.f) tnbCensus.f.add(b);
		for (const b of r.result.census.of) tnbCensus.of.add(b);
	}
	const ts = require2(tnbTsPath);
	const census = censusGate(
		censusBitNames(ts.TypeFlags, CENSUS_FLAG_MAX),
		censusBitNames(ts.ObjectFlags, CENSUS_OF_MAX),
		CENSUS_TF_EXEMPT, CENSUS_OF_EXEMPT,
		{ f: stock.census.f, of: stock.census.of },
		{ f: [...tnbCensus.f], of: [...tnbCensus.of] },
	);
	for (const e of census.errors) console.error(e);
	console.log(census.summary);
	const verdict = finalVerdict({ crashes: crashes.length, fail: fail + census.errors.length });
	console.log(`\nVERDICT: ${verdict} (${ok} ok, ${known} known, ${fail} diffs${crashes.length ? `, ${crashes.length} crashes` : ''}${census.errors.length ? `, ${census.errors.length} census fails` : ''})`);
	process.exit(verdict === 'PASS' ? 0 : 1);
}

async function runTnbPool(dir) {
	const results = new Array(FULLWALK_FILES.length);
	let next = 0;
	const worker = async () => {
		while (next < FULLWALK_FILES.length) {
			const i = next++;
			const rel = FULLWALK_FILES[i];
			const res = await spawnChild('tnb', dir, { TNB_DIFF_FULLWALK: '1', TNB_DIFF_FILE: rel });
			if (res.status !== 0) {
				results[i] = { file: rel, crash: true, status: res.status, stderr: res.err };
				continue;
			}
			try {
				results[i] = { file: rel, crash: false, result: JSON.parse(res.out.trim().split('\n').at(-1)) };
			} catch (e) {
				results[i] = { file: rel, crash: true, status: res.status, stderr: `unparseable output: ${e.message}\n${res.out.slice(-2000)}` };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(FULLWALK_JOBS, FULLWALK_FILES.length) }, worker));
	return results;
}

// ── Self-test (--self-test) ─────────────────────────────────────────────────
// Synthetic same-key diffs pin the KNOWN exemption contract: a pure
// permutation at a known key stays KNOWN; a content bug (wrong member name,
// wrong union constituent, drifted canonType flags) at the same key must be
// caught as KNOWN-SHAPE-VIOLATION. Without shape validation the violation
// assertions below fail — the gate green-lights a genuine bug riding on an
// exempted coordinate. This mode is the regression guard for that behavior.
function selfTest() {
	let failed = 0;
	const check = (name, ok, detail = '') => {
		console.log(`${ok ? 'SELF-OK  ' : 'SELF-FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
		if (!ok) failed++;
	};
	const prop = (name, t, flags = 1, decls = [['util.ts', 0, 0]]) => ({ name, flags, decls, t });
	const splitKey = key => ({ m: key.slice(0, key.indexOf('@')), at: key.slice(key.indexOf('@') + 1) });
	const run = (key, stockV, tnbV) => compareEntries(
		[{ ...splitKey(key), v: stockV }],
		[{ ...splitKey(key), v: tnbV }],
	);

	const U2_KEY = 'getApparentProperties@util.ts:add-decl';
	const U1_KEY = 'typeToString@types.ts:Tpl-decl';
	const U1T_KEY = 'getApparentType@types.ts:Tpl-decl';
	const LU2_KEY = 'getPropertiesOfType@types.ts:Tpl-decl';
	const U2T_KEY = 'getPropertiesOfType@types.ts:lang-elemaccess';

	// U2 member lists: reorder stays known, a wrong member name is a violation.
	let r = run(U2_KEY, [prop('add', 't1'), prop('Shape', 't2'), prop('Box', 't3')], [prop('Box', 't3'), prop('add', 't1'), prop('Shape', 't2')]);
	check('U2 reorder at known key stays a known pass', r.fail === 0 && r.known === 1);
	r = run(U2_KEY, [prop('add', 't1'), prop('Shape', 't2')], [prop('addd', 't1'), prop('Shape', 't2')]);
	check('U2 wrong member name at known key is KNOWN-SHAPE-VIOLATION', r.fail === 1 && r.known === 0);

	// U1 union-constituent order in type strings: reorder stays known, a wrong
	// constituent is a violation.
	r = run(U1_KEY, '"a" | "b" | "c"', '"c" | "a" | "b"');
	check('U1 union reorder stays a known pass', r.fail === 0 && r.known === 1);
	r = run(U1_KEY, '"a" | "b" | "c"', '"c" | "a" | "d"');
	check('U1 wrong constituent at known key is KNOWN-SHAPE-VIOLATION', r.fail === 1 && r.known === 0);

	// U1 canonType: same union reorder stays known; flags drift is a violation.
	r = run(U1T_KEY, { s: '"a" | "b" | "c"', f: 134217728, of: 0 }, { s: '"c" | "a" | "b"', f: 134217728, of: 0 });
	check('U1 canonType reorder (same flags) stays a known pass', r.fail === 0 && r.known === 1);
	r = run(U1T_KEY, { s: '"a" | "b" | "c"', f: 134217728, of: 0 }, { s: '"c" | "a" | "b"', f: 64, of: 0 });
	check('U1 canonType flags drift at known key is KNOWN-SHAPE-VIOLATION', r.fail === 1 && r.known === 0);

	// LU2: the documented padStart/padEnd parameter rename + reorder stays
	// known; a wrong member name is a violation.
	const padStart = { name: 'padStart', flags: 8192, decls: [['lib.es5.d.ts', 174]], t: '(maxLength: number, fillString?: string | undefined) => string' };
	const padStartTnb = { ...padStart, t: '(targetLength: number, padString?: string | undefined) => string' };
	r = run(LU2_KEY, [padStart, prop('padEnd', 'x')], [prop('padEnd', 'x'), padStartTnb]);
	check('LU2 documented rename + reorder stays a known pass', r.fail === 0 && r.known === 1);
	r = run(LU2_KEY, [padStart, prop('padEnd', 'x')], [prop('padEnd', 'x'), { ...padStartTnb, name: 'padStartX' }]);
	check('LU2 wrong member name at known key is KNOWN-SHAPE-VIOLATION', r.fail === 1 && r.known === 0);

	// U2T: truncation-tail type-string drift (same member identity) stays
	// known; a wrong member name is a violation.
	const every = { name: 'every', flags: 8192, decls: [['lib.es5.d.ts', 174]], t: '{ (): boolean; … 12 more …; last: string; }' };
	const everyTnb = { ...every, t: '{ (): boolean; … 13 more …; other: number; }' };
	r = run(U2T_KEY, [{ name: '0', flags: 4, decls: [], t: 'P' }, every], [everyTnb, { name: '0', flags: 4, decls: [], t: 'P' }]);
	check('U2T truncation-tail t drift stays a known pass', r.fail === 0 && r.known === 1);
	r = run(U2T_KEY, [{ name: '0', flags: 4, decls: [], t: 'P' }, every], [{ ...everyTnb, name: 'evry' }, { name: '0', flags: 4, decls: [], t: 'P' }]);
	check('U2T wrong member name at known key is KNOWN-SHAPE-VIOLATION', r.fail === 1 && r.known === 0);

	// Full-walk canon (F2): union-sort / member-list sort / LU2 rename bake the
	// ordering exemptions into canon; the crashed-child path must fail the verdict.
	check('full-walk union canon sorts top-level constituents', fullWalkCanonTypeStr('"b" | "a" | "c"') === '"a" | "b" | "c"');
	check('full-walk union canon sorts nested unions inside braces', fullWalkCanonTypeStr('{ a: "b" | "a" }') === '{ a: "a" | "b" }');
	check('full-walk union canon keeps the annotation prefix', fullWalkCanonTypeStr('{ raw: readonly string[] | ArrayLike<string>; }') === '{ raw: ArrayLike<string> | readonly string[]; }');
	check('full-walk union canon keeps the extends prefix', fullWalkCanonTypeStr('S extends "b" | "a"') === 'S extends "a" | "b"');
	check('full-walk union canon leaves member order compared', fullWalkCanonTypeStr('{ a: 1; b: 2; }') === '{ a: 1; b: 2; }');
	check('full-walk canon strips order-dependent truncation tails', fullWalkCanonTypeStr('{ m: T; ... 3 more ...; z: U; }') === '{ … }');
	check('full-walk canon applies the LU2 rename', fullWalkCanonTypeStr('(maxLength: number, fillString?: string | undefined) => string') === '(targetLength: number, padString?: string | undefined) => string');
	const memberSort = list => [...list].sort((x, y) => (stable(x) < stable(y) ? -1 : 1));
	check('full-walk member-list sort equalizes reordered arrays',
		stable(memberSort([{ name: 'b', flags: 1, decls: [], t: 'x' }, { name: 'a', flags: 1, decls: [], t: 'y' }]))
		=== stable([{ name: 'a', flags: 1, decls: [], t: 'y' }, { name: 'b', flags: 1, decls: [], t: 'x' }]));
	check('synthetic crashed tnb child forces VERDICT FAIL',
		finalVerdict({ crashes: 1, fail: 0 }) === 'FAIL' && finalVerdict({ crashes: 0, fail: 0 }) === 'PASS');

	// Shape census: bit decomposition, missing-expected FAIL, stale-exemption FAIL.
	check('census bit decomposition 0b101 → [1, 4]', JSON.stringify(decomposeBits(0b101, CENSUS_FLAG_MAX)) === '[1,4]');
	const cenTf = new Map([[1, 'Any'], [2, 'Unknown'], [4, 'Undefined']]);
	const cenOf = new Map([[1, 'Class'], [2, 'Interface']]);
	let g = censusGate(cenTf, cenOf, new Map(), new Map(),
		{ f: [1, 2], of: [1, 2] }, { f: [2, 4], of: [1, 2] });
	check('census: expected bit missing from one side forces CENSUS-FAIL',
		g.errors.length === 2
		&& g.errors.some(e => e === 'CENSUS-FAIL type-flag missing from stock: Undefined')
		&& g.errors.some(e => e === 'CENSUS-FAIL type-flag missing from tnb: Any'));
	const cenRes = new Map([[1, 'Any'], [CENSUS_FLAG_MAX, 'Reserved2']]);
	g = censusGate(cenRes, new Map(), new Map([['Reserved2', 'reserved bit']]), new Map(),
		{ f: [1, CENSUS_FLAG_MAX], of: [] }, { f: [1], of: [] });
	check('census: observed exempted bit forces stale CENSUS-FAIL',
		g.errors.length === 1 && g.errors[0] === 'CENSUS-FAIL stale type-flag exemption Reserved2 — reserved bit (observed on stock)');
	g = censusGate(cenTf, cenOf, new Map(), new Map(),
		{ f: [1, 2, 4], of: [1, 2] }, { f: [1, 2, 4], of: [1, 2] });
	check('census: all expected bits on both sides pass with an N/M summary',
		g.errors.length === 0 && g.summary === 'census: 3/3 type-flag bits, 2/2 object-flag bits, both sides');

	console.log(failed === 0 ? '\nSELF-TEST: PASS' : `\nSELF-TEST: FAIL (${failed} assertions)`);
	process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes('--self-test')) {
	selfTest();
} else if (process.env.TNB_DIFF_SIDE) {
	const out = runSide(process.env.TNB_DIFF_SIDE, process.argv[2]);
	fs.writeSync(1, JSON.stringify(out) + '\n');
	process.exit(0);
} else if (FULLWALK) {
	await parentMainFullWalk();
} else {
	parentMain();
}
