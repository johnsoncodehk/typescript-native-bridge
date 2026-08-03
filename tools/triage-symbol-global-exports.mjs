#!/usr/bin/env node
/**
 * Symbol.globalExports parity (README "Known issues (unfixed stock-API
 * gaps)" #1).
 *
 * Stock sets `file.symbol.globalExports` only for `export as namespace Foo`
 * (UMD) modules (binder bindNamespaceExportDeclaration); tsgo keeps the same
 * table on the SourceFile (`ast.SourceFile.GlobalExports`) and a wire symbol
 * carries no file handle, so the public `Symbol.globalExports` field read
 * undefined on every bridge symbol.
 *
 * The fix wires the field end-to-end: SymbolResponse gains a
 * `hasGlobalExports` flag (computed from the symbol's declaration SourceFiles
 * — any `sf.Symbol == symbol && len(sf.GlobalExports) > 0`), a
 * `getGlobalExportsOfSymbol` symbol-table RPC returns the table's values
 * name-sorted for run stability (issue #42), and convertSymbolWireShape
 * installs a lazy accessor that materializes the stock-shaped Map keyed by
 * escaped name (consumers use `.get(name)`).
 *
 * This witness drives the public API on both sides: the file's module symbol
 * via `checker.getSymbolAtLocation(sf)` (stock resolves sf.symbol; the TNB
 * adapter falls back to a whole-file node RPC for plain disk files). It then
 * compares `.globalExports`: non-undefined on both, the same escaped-name
 * key set, and each entry resolving to a symbol whose name matches on both
 * sides.
 *
 * Usage: node tools/triage-symbol-global-exports.mjs
 * Env:   STOCK_TSSERVER_PATH  override stock tsserver.js path (default
 *        /tmp/stock-ts-p3/...)
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const stockTsserver = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB
const tss = require2(path.join(path.dirname(stockTsserver), 'typescript.js')); // stock 6.0.3

// ── Fixture ───────────────────────────────────────────────────────────────
// Stock (and tsgo) set file.symbol.globalExports ONLY on declaration files —
// bindNamespaceExportDeclaration errors with
// "Global module exports may only appear in declaration files" on a .ts
// source, so the fixture must be a .d.ts. The table holds one alias symbol
// per `export as namespace Name` (the namespace itself, keyed by its name).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-sym-global-exports-'));
const srcPath = path.join(dir, 'a.d.ts');
fs.writeFileSync(srcPath, `export as namespace Foo;
export declare const x: number;
export declare const y: string;
`);
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
    include: ['a.d.ts'],
}));

const failures = [];

// Stock 6.0.3 lacks getModuleSymbolForSourceFile — resolve the module symbol
// through checker.getSymbolAtLocation (stock: sf.symbol). The TNB harness's
// program.getSourceFile returns a host-parsed AST whose own `.symbol` carries
// the host binder's globalExports (false green), so the TNB side must take the
// bridge module symbol: checker.getModuleSymbolForSourceFile (the component-
// meta consumer path) RPCs Go and returns a registry Symbol.
function stockModuleSymbolOf(ts, program, fileName) {
    const sf = program.getSourceFile(fileName);
    const checker = program.getTypeChecker();
    return checker.getSymbolAtLocation(sf) ?? sf.symbol;
}
function tnbModuleSymbolOf(program, fileName) {
    const sf = program.getSourceFile(fileName);
    return program.getTypeChecker().getModuleSymbolForSourceFile(sf);
}

// ── Stock 6.0.3: plain createProgram ─────────────────────────────────────
const stockProgram = tss.createProgram([srcPath], {
    strict: true, noEmit: true, target: tss.ScriptTarget.ES2022, module: tss.ModuleKind.ESNext,
});
const stockSym = stockModuleSymbolOf(tss, stockProgram, srcPath);
const stockGx = stockSym?.globalExports;

if (!stockSym || typeof stockSym.getName !== 'function') {
    failures.push('stock: no module symbol for the fixture file (fixture/transport changed)');
}
else if (!(stockGx instanceof Map)) {
    failures.push(`stock: expected file.symbol.globalExports to be a Map on an "export as namespace" declaration file, got ${stockGx === undefined ? 'undefined' : `${typeof stockGx}`}`);
}
else if (stockGx.size === 0) {
    failures.push('stock: expected at least the "Foo" alias in globalExports');
}

// ── TNB: watch/builder path so the module symbol really crosses the bridge ──
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
const tnbSym = tnbModuleSymbolOf(program, srcPath);
const tnbGx = tnbSym?.globalExports;
watch.close?.();

if (!tnbSym || typeof tnbSym.getName !== 'function') {
    failures.push('TNB: no module symbol for the fixture file (getModuleSymbolForSourceFile resolved nothing)');
}
else if (typeof tnbSym.id !== 'number' || !tnbSym.objectRegistry) {
    // Guard: a host-binder symbol would carry globalExports from the stock
    // binder and pass trivially — the witness must exercise the bridge path.
    failures.push('TNB: module symbol is not a bridge registry Symbol — the fixture did not cross the bridge');
}
else if (tnbGx === undefined) {
    failures.push('TNB: Symbol.globalExports reads undefined on the module symbol — the field does not cross the bridge');
}
else if (!(tnbGx instanceof Map)) {
    failures.push(`TNB: Symbol.globalExports must be a Map keyed by escaped name, got ${typeof tnbGx}`);
}
else if (tnbGx.size !== stockGx?.size) {
    failures.push(`TNB: Symbol.globalExports size ${tnbGx.size} != stock ${stockGx?.size}`);
}
else if (stockGx instanceof Map) {
    const stockNames = [...stockGx.keys()].sort();
    const tnbNames = [...tnbGx.keys()].sort();
    if (JSON.stringify(stockNames) !== JSON.stringify(tnbNames)) {
        failures.push(`TNB: globalExports escaped-name set mismatch: stock=${JSON.stringify(stockNames)} tnb=${JSON.stringify(tnbNames)}`);
    }
    for (const [key, stockEntry] of stockGx) {
        const tnbEntry = tnbGx.get(key);
        if (!tnbEntry) {
            failures.push(`TNB: globalExports has no entry for "${key}"`);
            continue;
        }
        if (typeof tnbEntry.getName !== 'function') {
            failures.push(`TNB: globalExports entry "${key}" is not a Symbol (no getName)`);
        }
        else if (tnbEntry.getName() !== stockEntry.getName()) {
            failures.push(`TNB: globalExports entry "${key}" resolves to symbol "${tnbEntry.getName()}", stock has "${stockEntry.getName()}"`);
        }
    }
}

if (failures.length) {
    console.error('FAIL');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log('ok symbol.globalExports parity: UMD module symbol exposes a stock-shaped Map keyed by escaped name with matching entries');
