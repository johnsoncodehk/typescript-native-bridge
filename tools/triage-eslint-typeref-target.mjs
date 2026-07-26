#!/usr/bin/env node
/**
 * Issue #35 witness: typescript-eslint's type-utils read nested Type fields
 * as objects (`tsutils.isTypeReference(type) → type.target → type.getSymbol()`
 * in containsAllTypesByName, rule @typescript-eslint/promise-function-async).
 * The bridge used to expose raw wire ids on any type that had not passed an
 * adapter method (e.g. getBaseTypes() results), so `.target` came back as the
 * literal id 73 and `.getSymbol` was not a function.
 *
 * This probe is self-contained (no stock install): it drives the TNB
 * watch/builder path so types really cross the bridge, replays the
 * containsAllTypesByName recursion exactly as the compiled rule helper does,
 * then asserts the shape of every nested field the type-field audit covers
 * (object/array-of-objects, never raw ids) plus registry identity
 * (`type.target === type.getTarget()`).
 *
 * Usage: node tools/triage-eslint-typeref-target.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB

// ── Fixture ──────────────────────────────────────────────────────────────
// testFunction is the issue's exact repro; the rest exercises one nested
// field per site (see FIELD SHAPES below).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-typeref-target-'));
const src = `function testFunction(): string[] { return []; }
interface Base<T> { x: T; }
interface Derived extends Base<string> { y: number; }
declare const derived: Derived;
const fresh = "hello";
type C<T> = T extends string ? 1 : 2;
declare function fc<T>(x: T): C<T>;
declare function fia<T extends { a: string }>(x: T): T["a"];
declare function fk<T>(x: T): keyof T;
declare function fu<T extends string>(x: T): Uppercase<T>;
type Pair<T> = [T, T];
declare const pair: Pair<string>;
export const exportedConst = 1;
`;
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
    include: ['a.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), src);

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
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path.join(dir, 'a.ts'));

const failures = [];
const notes = new Set();
const check = (ok, msg) => { if (!ok) failures.push(msg); };
// JSON.stringify can't take BigInt (literal `value` fields) — summarize.
const show = v => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(show).join(',')}]`;
    if (typeof v.id === 'number' && typeof v.flags === 'number') return `{Type id=${v.id},flags=${v.flags}}`;
    if (typeof v.flags === 'number') return `{Symbol ${JSON.stringify(symName(v))},flags=${v.flags}}`;
    return String(v);
};

function findDecl(name) {
    for (const st of sf.statements) {
        if (tsb.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (d.name.getText(sf) === name) return d.name;
            }
        }
        else if (tsb.isFunctionDeclaration(st) && st.name?.getText(sf) === name) return st;
    }
    throw new Error(`decl not found: ${name}`);
}

const TF = tsb.TypeFlags;
const OF = tsb.ObjectFlags;
const isTypeReference = t => (t.flags & TF.Object) !== 0 && (t.objectFlags & OF.Reference) !== 0;
const isUnionOrIntersection = t => (t.flags & (TF.Union | TF.Intersection)) !== 0;
const symName = s => s == null ? s : (typeof s.name === 'string' && s.name !== '' ? s.name : s.getName?.());

// ── Part A: replay containsAllTypesByName (compiled @typescript-eslint/
// type-utils dist semantics) on the issue's repro. Crashed pre-fix with
// "type.getSymbol is not a function" on the raw target id. ────────────────
const walked = [];
function containsAllTypesByName(type, allowedNames) {
    if ((type.flags & (TF.Any | TF.Unknown)) !== 0) return false;
    let t = type;
    if (isTypeReference(t)) {
        walked.push({ kind: 'target', value: t.target });
        t = t.target;
    }
    const symbol = t.getSymbol(); // ← issue #35 crash site
    walked.push({ kind: 'symbol', type: t, value: symbol });
    if (symbol && allowedNames.has(symName(symbol))) return true;
    if (isUnionOrIntersection(t)) return t.types.every(u => containsAllTypesByName(u, allowedNames));
    const bases = t.getBaseTypes?.();
    return bases != null && bases.length > 0 && bases.every(b => containsAllTypesByName(b, allowedNames));
}

const fnType = checker.getTypeAtLocation(findDecl('testFunction'));
const sigs = fnType.getCallSignatures();
check(sigs.length === 1, `testFunction: expected 1 call signature, got ${sigs.length}`);
const returnType = checker.getReturnTypeOfSignature(sigs[0]);
let verdict;
try {
    verdict = containsAllTypesByName(returnType, new Set(['Promise', 'PromiseLike']));
} catch (e) {
    failures.push(`containsAllTypesByName threw (issue #35 repro): ${e.message}`);
}
check(verdict === false, `containsAllTypesByName(string[]) should be false (string[] is not a Promise), got ${verdict}`);
for (const w of walked) {
    if (w.kind === 'target') {
        check(w.value && typeof w.value === 'object' && typeof w.value.id === 'number',
            `isTypeReference → .target must be a Type object, got ${show(w.value)}`);
    }
    else {
        check(w.value === undefined || (typeof w.value === 'object' && typeof symName(w.value) === 'string'),
            `.getSymbol() on type id=${w.type.id} must return a Symbol object, got ${show(w.value)}`);
    }
}
// The walked chain must include Array<string> → target Array<T> (symbol Array).
check(walked.some(w => w.kind === 'symbol' && symName(w.value) === 'Array'),
    `walk should reach the Array symbol via .target, got [${walked.map(w => `${w.kind}:${symName(w.value) ?? w.value}`)}]`);

// ── Part B: nested-field shapes on every probe type. Reading a field also
// forces the bridge's lazy resolution, so a raw id here can never be a
// not-yet-materialized case — it would be a leak. ─────────────────────────
const SINGLE_FIELDS = ['target', 'freshType', 'regularType', 'objectType', 'indexType', 'checkType', 'extendsType', 'baseType', 'substConstraint'];
const ARRAY_FIELDS = ['typeParameters', 'outerTypeParameters', 'localTypeParameters', 'aliasTypeArguments'];
function assertNestedShapes(t, label) {
    for (const f of SINGLE_FIELDS) {
        const v = t[f];
        check(typeof v !== 'number', `${label}.${f}: raw wire id ${v} exposed (issue #35 class)`);
        if (v !== undefined) check(typeof v === 'object' && typeof v.flags === 'number', `${label}.${f}: expected Type object, got ${show(v)}`);
    }
    for (const f of ARRAY_FIELDS) {
        const v = t[f];
        if (v === undefined) continue;
        check(Array.isArray(v), `${label}.${f}: expected array, got ${show(v)}`);
        if (Array.isArray(v)) {
            check(!(v.length > 0 && typeof v[0] === 'number'), `${label}.${f}: raw wire id array ${show(v)} exposed (issue #35 class)`);
            for (const el of v) check(el && typeof el === 'object' && typeof el.flags === 'number', `${label}.${f}: element must be a Type object, got ${show(el)}`);
        }
    }
    for (const f of ['aliasSymbol', 'exportSymbol']) {
        const v = t[f];
        check(typeof v !== 'number', `${label}.${f}: raw wire id ${v} exposed (issue #35 class)`);
    }
    const sym = t.symbol;
    check(typeof sym !== 'number', `${label}.symbol: raw wire id ${sym} exposed`);
}

const retOf = fnName => {
    const t = checker.getTypeAtLocation(findDecl(fnName));
    const s = t.getCallSignatures();
    check(s.length >= 1, `${fnName}: expected call signatures, got ${s.length}`);
    return checker.getReturnTypeOfSignature(s[0]);
};

// Probe set: one type per nested-field carrier.
const derivedType = checker.getTypeAtLocation(findDecl('derived'));
const derivedBases = derivedType.getBaseTypes?.() ?? [];
check(derivedBases.length === 1, `Derived: expected 1 base type, got ${derivedBases.length}`);
const probes = [
    ['returnType string[]', returnType],
    ['string[].target (Array<T>)', isTypeReference(returnType) ? returnType.target : undefined],
    ['Derived', derivedType],
    ['Derived base Base<string>', derivedBases[0]],
    ['Base<string>.target', derivedBases[0] && isTypeReference(derivedBases[0]) ? derivedBases[0].target : undefined],
    ['fresh literal', checker.getTypeAtLocation(findDecl('fresh').parent.initializer)],
    ['conditional C<T>', retOf('fc')],
    ['indexed access T["a"]', retOf('fia')],
    ['keyof T', retOf('fk')],
    ['Uppercase<T>', retOf('fu')],
    ['Pair<string> (alias args)', checker.getTypeAtLocation(findDecl('pair'))],
];
const visited = new Set();
for (const [label, t] of probes) {
    if (!t) { failures.push(`${label}: probe type unavailable`); continue; }
    assertNestedShapes(t, label);
    // Recurse one graph level so nested carriers (e.g. a conditional's
    // checkType) are shape-checked on their own fields too.
    for (const f of SINGLE_FIELDS) {
        const v = t[f];
        if (v && typeof v === 'object' && typeof v.flags === 'number' && !visited.has(v)) {
            visited.add(v);
            assertNestedShapes(v, `${label}.${f}`);
        }
    }
    for (const f of ARRAY_FIELDS) {
        const v = t[f];
        if (Array.isArray(v)) {
            for (const el of v) {
                if (el && typeof el === 'object' && typeof el.flags === 'number' && !visited.has(el)) {
                    visited.add(el);
                    assertNestedShapes(el, `${label}.${f}[i]`);
                }
            }
        }
    }
}

// Field presence spot-checks (the fixture must actually carry these fields,
// or the shape assertions above are vacuous):
const expectPresent = [
    ['returnType string[].target', returnType.target],
    ['string[].target.typeParameters', returnType.target?.typeParameters?.length ? returnType.target.typeParameters : undefined],
    ['Derived base .target', derivedBases[0]?.target],
    ['Pair<string>.aliasSymbol', checker.getTypeAtLocation(findDecl('pair')).aliasSymbol],
    ['Pair<string>.aliasTypeArguments', (() => { const a = checker.getTypeAtLocation(findDecl('pair')).aliasTypeArguments; return a?.length ? a : undefined; })()],
    ['conditional.checkType', retOf('fc').checkType],
    ['conditional.extendsType', retOf('fc').extendsType],
    ['indexedAccess.objectType', retOf('fia').objectType],
    ['indexedAccess.indexType', retOf('fia').indexType],
    ['keyof.target', retOf('fk').target],
    ['Uppercase.target', retOf('fu').target],
    ['fresh.freshType', checker.getTypeAtLocation(findDecl('fresh').parent.initializer).freshType],
];
for (const [label, v] of expectPresent) {
    check(v !== undefined, `${label}: expected the fixture to carry this field (probe would be vacuous)`);
}

// ── Part C: identity + memoization. Nested reads must go through the
// id-keyed registry, so the property, the vendored method, and repeated
// reads all yield the same instance. ──────────────────────────────────────
check(returnType.target === returnType.target, `string[].target: repeated reads must be memoized (===)`);
try {
    check(returnType.target === returnType.getTarget(), `string[].target must be registry-identical to getTarget() (===)`);
} catch (e) {
    failures.push(`getTarget() threw: ${e.message}`);
}
const baseTarget = derivedBases[0]?.target;
if (baseTarget) {
    try {
        check(baseTarget.getSymbol() === baseTarget.symbol, `Base<T>.getSymbol() === .symbol (lazy symbol accessor identity)`);
    } catch (e) {
        failures.push(`Base<T>.getSymbol() threw: ${e.message}`);
    }
    const tps = baseTarget.typeParameters;
    check(Array.isArray(tps) && tps.length === 1, `Base<T>.typeParameters: expected [T], got ${show(tps)}`);
    if (Array.isArray(tps) && tps.length === 1) {
        check(tps[0] === baseTarget.typeParameters[0], `typeParameters element reads must be memoized (===)`);
    }
}
// aliasSymbol resolves to a Symbol whose name is the alias.
const pairType = checker.getTypeAtLocation(findDecl('pair'));
check(symName(pairType.aliasSymbol) === 'Pair', `Pair<string>.aliasSymbol name: expected "Pair", got ${JSON.stringify(symName(pairType.aliasSymbol))}`);

// ── Part D: symbol nested fields. exportSymbol is a wire-supported symbol
// field (tsgo sets it on a module-scope exported declaration's local symbol,
// e.g. `export const x`), though current tsgo API responses rarely surface
// such symbols — assert the shape wherever one does surface. ──────────────
let exportSymbolSeen = 0;
const seenSyms = new Set();
function scanSymbol(s, label) {
    if (!s || seenSyms.has(s)) return;
    seenSyms.add(s);
    const v = s.exportSymbol;
    if (v !== undefined) {
        exportSymbolSeen++;
        check(typeof v !== 'number', `${label}.exportSymbol: raw wire id ${v} exposed (issue #35 class)`);
        check(v === undefined || (typeof v === 'object' && typeof v.flags === 'number'), `${label}.exportSymbol: expected Symbol object, got ${show(v)}`);
    }
}
for (const [label, t] of probes) {
    if (!t) continue;
    scanSymbol(t.symbol, `${label}.symbol`);
    scanSymbol(t.aliasSymbol, `${label}.aliasSymbol`);
    for (const p of t.getProperties?.() ?? []) scanSymbol(p, `${label}.prop`);
}
scanSymbol(checker.getSymbolAtLocation(findDecl('exportedConst')), 'exportedConst local symbol');
if (!exportSymbolSeen) notes.add('no surfaced symbol carried exportSymbol; its conversion is data-driven and unexercised here');

watch.close?.();

if (failures.length) {
    console.error('FAIL');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log(`ok eslint typeref interop: containsAllTypesByName replay on the #35 repro, ${probes.length} probe types, nested-field shapes + registry identity verified (fork ${tsb.version})`);
for (const n of notes) console.log(`  note: ${n}`);
