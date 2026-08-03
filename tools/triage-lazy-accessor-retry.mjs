#!/usr/bin/env node
/**
 * Lazy accessor retry contract (review issue C).
 *
 * convertTypeWireShape lays lazy accessors (NESTED_TYPE_SINGLE,
 * NESTED_TYPE_ARRAY, aliasSymbol, Substitution constraint) that RPC through
 * the object registry on first read and memoize the result. Each used to
 * `catch { resolved = undefined }` and memoize that — a transient registry
 * failure (snapshot rotation, disposed project) then pinned a permanent
 * wrong value for the rest of the session. The fix: a failed RPC must not
 * memoize; the accessor stays live and the next read retries.
 *
 * This witness forces the failure: the registry method under test is
 * wrapped to throw on its first call and delegate afterwards. It then
 * asserts the transient contract — first read undefined, accessor still
 * live (not memoized), second read resolves, third read is the memoized
 * success — plus exactly one re-RPC (the retry) for the method.
 *
 * Box<string>'s `.target` exercises the NESTED_TYPE_SINGLE path,
 * Pair<string>'s `aliasTypeArguments` the NESTED_TYPE_ARRAY path, and its
 * `aliasSymbol` the fetchSymbol path. `exportSymbol` (convertSymbolWireShape)
 * is covered by crafting a wire symbol with a numeric exportSymbol handle off
 * the snapshot registry — tsgo sets that field on module-scope exported
 * locals, which the overlay adapter otherwise resolves before callers see
 * them (S′). The Substitution-type `constraint` alias has no reliable
 * source-level trigger (see triage-type-field-audit notes) and is covered by
 * code-path parity only.
 *
 * A second exportSymbol scenario covers the light-first upgrade contract
 * (README known issue #2): a symbol created from a LIGHT payload must still
 * get the accessor when a later FULL payload for the same id re-applies the
 * exportSymbol handle — the WeakSet gate must not block the re-install.
 *
 * Usage: node tools/triage-lazy-accessor-retry.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js'));

// ── Fixture ───────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-lazy-retry-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
	include: ['a.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), `interface Box<T> { x: T; }
declare const box: Box<string>;
type Pair<T> = [T, T];
declare const pair: Pair<string>;
export const exportedSym: string = "hi";
`);

// ── Harness: same watch/builder path as triage-type-field-audit.mjs so the
//    types really cross the bridge ────────────────────────────────────────
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

function declType(name) {
	for (const st of sf.statements) {
		if (tsb.isVariableStatement(st)) {
			for (const d of st.declarationList.declarations) {
				if (d.name.getText(sf) === name) return checker.getTypeAtLocation(d.name);
			}
		}
	}
	throw new Error(`site node not found: ${name}`);
}

// ── Failure injection: throw on the first RPC for the methods under test,
//    delegate afterwards. Instance patch — the accessors resolve the method
//    off the registry object at call time, so the wrap is picked up. ───────
const failures = [];
const patchedRegistries = new WeakSet();
const methodCalls = new Map();
function patchRegistry(reg) {
	if (patchedRegistries.has(reg)) return;
	patchedRegistries.add(reg);
	const origFetchType = reg.fetchType;
	const origFetchTypes = reg.fetchTypes;
	const origFetchSymbol = reg.fetchSymbol;
	// First call per method throws; later calls delegate. Returns true on
	// the injected (throwing) call so the wrapper can raise before touching
	// the original.
	const throwOnFirst = method => {
		const n = (methodCalls.get(method) ?? 0) + 1;
		methodCalls.set(method, n);
		return n === 1;
	};
	reg.fetchType = function (self, method, raw, ...rest) {
		if (method === 'getTargetOfType' && throwOnFirst(method)) {
			throw new Error(`simulated transient registry failure (${method})`);
		}
		return origFetchType.call(this, self, method, raw, ...rest);
	};
	reg.fetchTypes = function (self, method, raw, ...rest) {
		if (method === 'getAliasTypeArgumentsOfType' && throwOnFirst(method)) {
			throw new Error(`simulated transient registry failure (${method})`);
		}
		return origFetchTypes.call(this, self, method, raw, ...rest);
	};
	reg.fetchSymbol = function (self, method, raw, ...rest) {
		if (method === 'getAliasSymbolOfType' && throwOnFirst(method)) {
			throw new Error(`simulated transient registry failure (${method})`);
		}
		return origFetchSymbol.call(this, self, method, raw, ...rest);
	};
}

// ── Scenario ─────────────────────────────────────────────────────────────
// Reads `prop` three times on a fresh type: the first read hits the injected
// failure (must return undefined WITHOUT memoizing — the accessor stays
// live), the second must retry and resolve, the third is the memoized win.
// `isResolved` asserts the resolved value shape; `callsAfter` is the method
// call count the whole sequence must have produced (1 throw + 1 retry).
function scenario(label, type, prop, method, isResolved, callsAfter) {
	if (!type) throw new Error(`${label}: no type`);
	const reg = type.objectRegistry;
	if (!reg) throw new Error(`${label}: no objectRegistry`);
	patchRegistry(reg);
	const first = type[prop];
	const descAfterFirst = Object.getOwnPropertyDescriptor(type, prop);
	const second = type[prop];
	const third = type[prop];
	if (first !== undefined) {
		failures.push(`${label}: first read after injected failure expected undefined, got ${Array.isArray(first) ? `array[${first.length}]` : JSON.stringify(first)}`);
	}
	if (!descAfterFirst || typeof descAfterFirst.get !== 'function') {
		failures.push(`${label}: accessor was memoized by the failed read — must stay live so the next read retries`);
	}
	if (!isResolved(second)) {
		failures.push(`${label}: second read expected resolved value, got ${Array.isArray(second) ? `array[${second.length}]` : typeof second === 'object' ? `object flags=${second?.flags}` : JSON.stringify(second)}`);
	}
	if (second !== third) {
		failures.push(`${label}: third read must return the memoized success (identity) — success path no longer retries`);
	}
	const calls = methodCalls.get(method) ?? 0;
	if (calls !== callsAfter) {
		failures.push(`${label}: expected exactly ${callsAfter} ${method} RPC calls (1 injected throw + 1 retry), saw ${calls}`);
	}
}

const isTypeObject = v => !!v && typeof v === 'object' && typeof v.flags === 'number';
const isTypeArray = v => Array.isArray(v) && v.length >= 1 && v.every(isTypeObject);
const isSymbolObject = v => !!v && typeof v === 'object' && typeof v.flags === 'number' && typeof v.getName === 'function';

scenario('box.target (NESTED_TYPE_SINGLE)', declType('box'), 'target', 'getTargetOfType', isTypeObject, 2);
scenario('pair.aliasTypeArguments (NESTED_TYPE_ARRAY)', declType('pair'), 'aliasTypeArguments', 'getAliasTypeArgumentsOfType', isTypeArray, 2);
scenario('pair.aliasSymbol (fetchSymbol)', declType('pair'), 'aliasSymbol', 'getAliasSymbolOfType', isSymbolObject, 2);

// ── exportSymbol scenario ─────────────────────────────────────────────────
// convertSymbolWireShape installs the exportSymbol accessor on wire symbols
// whose payload carries a numeric exportSymbol handle (tsgo sets it on a
// module-scope exported declaration's local symbol, e.g. `export const x`).
// The overlay adapter refines scope symbols before callers see them (S′
// resolves the numeric handle), so the raw wire symbol must be read straight
// from the snapshot registry: getSymbolsInScope populates it, then a fresh
// symbol is crafted from the resolved handle ids — the same payload shape
// getSymbolsDeclarations delivers on a real batch. The accessor RPCs through
// `reg.fetchSymbol`; the same throw-once patch must keep it live.
checker.getSymbolsInScope(sf, tsb.SymbolFlags.Value); // populate snapshot registry
const snapshotReg = declType('box').objectRegistry.snapshotRegistry;
const EXPORT_VALUE = 1 << 20;
let localExported;
for (const sym of snapshotReg.symbols.values()) {
    if (sym.getName?.() === 'exportedSym' && (sym.flags & EXPORT_VALUE) !== 0) { localExported = sym; break; }
}
if (!localExported || typeof localExported.exportSymbol !== 'object' || typeof localExported.exportSymbol.id !== 'number') {
    failures.push('exportSymbol: no snapshot-registry wire symbol with a resolved exportSymbol handle found (fixture/transport changed)');
}
else {
    const exportId = localExported.exportSymbol.id;
    const project = localExported.exportSymbol.canonicalProject?.id ?? localExported.canonicalProject?.id;
    let FRESH = 0x7fffffff;
    while (snapshotReg.getSymbol(FRESH)) FRESH--;
    const sym = snapshotReg.getOrCreateSymbol({ id: FRESH, name: 'exportedSym', flags: 2, checkFlags: 0, project, exportSymbol: exportId });
    const reg = sym.objectRegistry;
    let calls = 0;
    const origFetchSymbol = reg.fetchSymbol.bind(reg);
    reg.fetchSymbol = function (source, method, handle, projectId) {
        if (method === 'getExportSymbolOfSymbol') {
            calls++;
            if (calls === 1) throw new Error('simulated transient registry failure (getExportSymbolOfSymbol)');
        }
        return origFetchSymbol(source, method, handle, projectId);
    };
    const first = sym.exportSymbol;
    const descAfterFirst = Object.getOwnPropertyDescriptor(sym, 'exportSymbol');
    const second = sym.exportSymbol;
    const third = sym.exportSymbol;
    if (first !== undefined) {
        failures.push(`exportSymbol: first read after injected failure expected undefined, got ${JSON.stringify(first)}`);
    }
    if (!descAfterFirst || typeof descAfterFirst.get !== 'function') {
        failures.push('exportSymbol: accessor was memoized by the failed read — must stay live so the next read retries');
    }
    if (!isSymbolObject(second)) {
        failures.push(`exportSymbol: second read expected resolved Symbol, got ${typeof second}${second ? ` flags=${second.flags}` : ''}`);
    }
    if (second !== third) {
        failures.push('exportSymbol: third read must return the memoized success (identity) — success path no longer retries');
    }
    if (calls !== 2) {
        failures.push(`exportSymbol: expected exactly 2 getExportSymbolOfSymbol RPC calls (1 injected throw + 1 retry), saw ${calls}`);
    }
}

// ── Light-first upgrade scenario (README known issue #2) ──────────────────
// A symbol created from a LIGHT payload (no exportSymbol handle) must still
// get the exportSymbol accessor when a later FULL payload for the same id is
// re-applied. getOrCreateSymbol upgrades only `parent` on an existing
// instance, so the bridge wrapper re-surfaces the new payload's exportSymbol
// handle; convertSymbolWireShape must not be WeakSet-blocked from installing
// the accessor. RED before the fix: the WeakSet gate early-returns on the
// already-converted symbol, no accessor appears, .exportSymbol reads
// undefined forever.
if (!localExported) {
    failures.push('light-first upgrade: no snapshot-registry wire symbol found (fixture/transport changed)');
}
else {
    const exportId = localExported.exportSymbol?.id;
    const project = localExported.exportSymbol?.canonicalProject?.id ?? localExported.canonicalProject?.id;
    let FRESH = 0x7ffffffe;
    while (snapshotReg.getSymbol(FRESH)) FRESH--;
    const light = snapshotReg.getOrCreateSymbol({ id: FRESH, name: 'exportedSym', flags: 2, checkFlags: 0, project });
    const descBefore = Object.getOwnPropertyDescriptor(light, 'exportSymbol');
    // The upgrade: same id, now carrying the numeric exportSymbol handle.
    const upgraded = snapshotReg.getOrCreateSymbol({ id: FRESH, name: 'exportedSym', flags: 2, checkFlags: 0, project, exportSymbol: exportId });
    if (upgraded !== light) {
        failures.push('light-first upgrade: getOrCreateSymbol must return the same instance for the same id');
    }
    const descAfter = Object.getOwnPropertyDescriptor(upgraded, 'exportSymbol');
    if (descBefore && typeof descBefore.value === 'number') {
        failures.push('light-first upgrade: the light payload unexpectedly carried an exportSymbol handle (fixture/transport changed)');
    }
    if (!descAfter || typeof descAfter.get !== 'function') {
        failures.push('light-first upgrade: the full payload re-apply did not install the exportSymbol accessor (WeakSet-blocked?)');
    }
    else {
        const reg = upgraded.objectRegistry;
        let calls = 0;
        const origFetchSymbol = reg.fetchSymbol.bind(reg);
        reg.fetchSymbol = function (source, method, handle, projectId) {
            if (method === 'getExportSymbolOfSymbol') calls++;
            return origFetchSymbol(source, method, handle, projectId);
        };
        const first = upgraded.exportSymbol;
        const second = upgraded.exportSymbol;
        if (first !== second) {
            failures.push('light-first upgrade: a successful read must memoize (identity on repeat)');
        }
        if (!isSymbolObject(first)) {
            failures.push(`light-first upgrade: expected a resolved export Symbol, got ${typeof first}`);
        }
        else if (first.name !== 'exportedSym') {
            failures.push(`light-first upgrade: resolved export symbol name ${first.name}, expected exportedSym`);
        }
        if (calls !== 1) {
            failures.push(`light-first upgrade: expected exactly 1 getExportSymbolOfSymbol RPC call, saw ${calls}`);
        }
    }
}

watch.close?.();

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log('ok lazy accessor retry contract: failed reads are not memoized, retries resolve, success memoizes');
