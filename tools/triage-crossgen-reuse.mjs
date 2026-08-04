#!/usr/bin/env node
/**
 * Cross-generation RemoteSourceFile reuse (issue #11).
 *
 * Drives createTsgoProgram generations programmatically (no eslint deps) and
 * asserts the MiniSourceFileCache stable-entry contract:
 *
 *  - gen 2 with no edits re-fetches NOTHING (runB.rpc == runA.rpc) and the
 *    vendored Program.getSourceFile returns the IDENTICAL RemoteSourceFile
 *    object for every unchanged file (WeakMap-keyed indexes stay valid).
 *  - An overlay edit (host snapshot content != disk) invalidates exactly the
 *    edited file: runC.rpc == runB.rpc + 1, the file decodes to a new object
 *    whose text carries the edit (never serve stale content).
 *  - program.getSourceFile returns a full TS surface in the pure-disk thin
 *    path (parseDiagnostics array, token-level getChildren — the
 *    typescript-estree crash in issue #11).
 *  - A type handle captured in gen 2 must not silently resolve to the NEW
 *    snapshot's same-id type after the gen-3 edit flips the snapshot: the
 *    bridge registry is per-snapshot (proto.go snapshotData.projectRegistries,
 *    keyed by TypeID = t.Id()), so a stale handle either dies loudly ("type
 *    handle N not found in project registry") or serves the value it was
 *    captured with — never a different type from the rebuilt snapshot.
 *
 * Parent spawns three child processes (gen counts 1 / 2 / 3-with-edit) with
 * TSGO_PROFILE=1 and compares the getSourceFileRpc exit counters, so
 * per-generation contributions are isolated exactly.
 *
 * Usage: node tools/triage-crossgen-reuse.mjs
 */
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsPath = path.join(repoRoot, 'lib', 'typescript.js');
const vendorApiPath = path.join(repoRoot, 'vendor', 'native-preview', 'dist', 'api', 'sync', 'api.js');

if (process.env.TNB_WITNESS_CHILD) {
    childMain(process.env.TNB_WITNESS_GENS);
} else {
    parentMain();
}

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-crossgen-'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
            noEmit: true, skipLibCheck: true, types: [],
        },
        include: ['*.ts'],
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'import { bValue } from "./b.js";\nimport { cValue } from "./c.js";\nexport const aValue: string = bValue + cValue[0];\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const bValue: string = "b";\n');
    fs.writeFileSync(path.join(dir, 'c.ts'), 'export const cValue: Array<string> = [];\n');
    return dir;
}

/** Run up to `gens` createTsgoProgram generations (gen 3 edits b.ts via host overlay). */
function childMain(gens) {
    const ts = require(tsPath);
    // Wrap the vendored client BEFORE typescript.js loads it (shared require
    // cache): record every distinct RemoteSourceFile object per file.
    const api = require(vendorApiPath);
    const objectsByFile = new Map();
    const origGet = api.Program.prototype.getSourceFile;
    api.Program.prototype.getSourceFile = function (file) {
        const sf = origGet.call(this, file);
        const gen = globalThis.__tnbGen;
        if (sf && gen) {
            const key = String(file);
            let arr = objectsByFile.get(key);
            if (!arr) objectsByFile.set(key, arr = []);
            if (arr[arr.length - 1] !== sf) arr.push(sf);
        }
        return sf;
    };

    const dir = makeWorkspace();
    const configPath = path.join(dir, 'tsconfig.json');
    const aPath = path.join(dir, 'a.ts');
    const bPath = path.join(dir, 'b.ts');
    const cPath = path.join(dir, 'c.ts');
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir, undefined, configPath);
    const options = { ...parsed.options, configFilePath: configPath, noEmit: true };
    // The overlay edit changes b.ts's declared type (not just appending): a
    // stale gen-2 handle whose wire id no longer exists in the rebuilt
    // snapshot must die loudly, while an id-stable type (c.ts) must never
    // silently resolve to a DIFFERENT same-id type. Appending alone keeps the
    // id sequence stable, which would mask that discrimination.
    const editedB = fs.readFileSync(bPath, 'utf8').replace(': string', ': number') + '\nexport const __edited = 1;\n';

    const firstIdentifier = (sf) => {
        let found;
        const visit = (n) => {
            if (found) return;
            if (n.kind === ts.SyntaxKind.Identifier) { found = n; return; }
            n.forEachChild(visit);
        };
        visit(sf);
        return found;
    };
    const walkKinds = (sf) => {
        const kinds = new Set();
        const visit = (n) => {
            kinds.add(n.kind);
            for (const c of n.getChildren()) visit(c);
        };
        visit(sf);
        return kinds;
    };

    const staleProbe = { captured: {}, probes: {} };
    const out = { surface: {}, identity: {}, stale: staleProbe };
    // Stale-handle scenario state: type objects captured in gen 2, probed in
    // gen 3 after the overlay edit flipped the Go snapshot. The type objects
    // stay in plain module-scope vars — they reference the BridgeClient (via
    // objectRegistry) and must never ride the serialized `out`.
    let oldBType, oldCType, oldBModuleType;
    const probe = (fn) => { try { return { val: fn() }; } catch (e) { return { err: String(e?.message ?? e).slice(0, 300) }; } };
    const maxGen = Number(gens);
    for (let gen = 1; gen <= maxGen; gen++) {
        let host;
        if (gen === 3) {
            // Overlay edit on b.ts: host snapshot content differs from disk.
            const base = ts.createCompilerHost(options);
            host = {
                ...base,
                getScriptSnapshot: (fileName) =>
                    path.resolve(fileName) === bPath ? ts.ScriptSnapshot.fromString(editedB) : undefined,
                getScriptVersion: () => '1',
            };
        }
        globalThis.__tnbGen = gen;
        const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });
        const checker = program.getTypeChecker();
        for (const f of [aPath, bPath, cPath]) {
            const sf = program.getSourceFile(f);
            if (gen === 1 && f === aPath) {
                out.surface.parseDiagnosticsIsArray = Array.isArray(sf.parseDiagnostics);
                out.surface.endOfFileTokenEnd = typeof sf.endOfFileToken?.end === 'number';
            }
            if (gen === 1 && f === cPath) {
                // ESTree conversion walks token children (findNextToken) — a
                // tsgo-backed shell has no tokens; a real parse must.
                out.surface.hasTokenChildren = walkKinds(sf).has(ts.SyntaxKind.GreaterThanToken);
            }
            // Force the tsgo blob for this file to be demanded this generation
            // (the checker adapter resolves the host node by position).
            checker.getTypeAtLocation(firstIdentifier(sf));
        }
        if (gen === 2) {
            // Capture type handles the gen-3 edit will invalidate: b.ts is the
            // overlay-edited file (module type changes), c.ts is untouched but
            // its handle ids come from the same per-snapshot registry.
            const sfB2 = program.getSourceFile(bPath);
            const sfC2 = program.getSourceFile(cPath);
            oldBType = checker.getTypeAtLocation(firstIdentifier(sfB2));
            oldCType = checker.getTypeAtLocation(firstIdentifier(sfC2));
            const modSymB = checker.getSymbolAtLocation(sfB2);
            if (modSymB) oldBModuleType = checker.getTypeOfSymbolAtLocation(modSymB, sfB2);
            staleProbe.captured.bTypeStr = checker.typeToString(oldBType);
            staleProbe.captured.cTypeStr = checker.typeToString(oldCType);
            staleProbe.captured.cArgsStr = checker.getTypeArguments(oldCType).map(t => checker.typeToString(t)).join(',');
            if (oldBModuleType) staleProbe.captured.bModuleStr = checker.typeToString(oldBModuleType);
            staleProbe.captured.bTypeId = oldBType.id;
            staleProbe.captured.cTypeId = oldCType.id;
            if (oldBModuleType) staleProbe.captured.bModuleId = oldBModuleType.id;
        }
        if (gen === 3) {
            const sfB = program.getSourceFile(bPath);
            out.surface.editVisibleOnProgramSf = typeof sfB.text === 'string' && sfB.text.includes('__edited');
            // Stale-handle negative test: the snapshot flipped when the overlay
            // edit rebuilt the project, so the captured gen-2 handles no longer
            // belong to the live registry. Probing them through the gen-3
            // checker must either throw (loud) or serve the captured value —
            // never a silently-different type at the same wire id.
            staleProbe.probes.bTypeStr = probe(() => checker.typeToString(oldBType));
            staleProbe.probes.cTypeStr = probe(() => checker.typeToString(oldCType));
            staleProbe.probes.cArgsStr = probe(() => checker.getTypeArguments(oldCType).map(t => checker.typeToString(t)).join(','));
            if (oldBModuleType) staleProbe.probes.bModuleStr = probe(() => checker.typeToString(oldBModuleType));
        }
    }
    globalThis.__tnbGen = 0;

    const nameOf = (p) => path.basename(p);
    for (const [file, arr] of objectsByFile) {
        out.identity[nameOf(file)] = {
            distinct: arr.length,
            textHasEdit: arr.some((sf) => typeof sf.text === 'string' && sf.text.includes('__edited')),
        };
    }
    fs.writeFileSync(1, JSON.stringify(out) + '\n');
}

function runChild(gens) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, TNB_WITNESS_CHILD: '1', TNB_WITNESS_GENS: String(gens), TSGO_PROFILE: '1' },
        encoding: 'utf8',
        timeout: 180_000,
    });
    if (res.status !== 0) {
        console.error(`child gens=${gens} FAILED (status ${res.status})\n${res.stdout}\n${res.stderr}`);
        process.exit(1);
    }
    const profile = /getSourceFileRpc=(\d+)/.exec(res.stderr);
    assert.ok(profile, `child gens=${gens}: no getSourceFileRpc in profile line\n${res.stderr}`);
    const json = JSON.parse(res.stdout.trim().split('\n').at(-1));
    return { rpc: Number(profile[1]), ...json };
}

function parentMain() {
    const runA = runChild(1);
    const runB = runChild(2);
    const runC = runChild(3);
    let failed = 0;
    const check = (label, cond, detail) => {
        console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
        if (!cond) failed++;
    };

    check('gen2 re-fetches nothing (rpc gen1 == gen1+gen2)', runA.rpc === runB.rpc, `runA=${runA.rpc} runB=${runB.rpc}`);
    check('edit re-fetches exactly one file (rpc +1)', runC.rpc === runB.rpc + 1, `runB=${runB.rpc} runC=${runC.rpc}`);

    for (const f of ['a.ts', 'c.ts']) {
        check(`identity: ${f} same RemoteSourceFile across 3 gens`, runC.identity[f]?.distinct === 1, JSON.stringify(runC.identity[f]));
    }
    check('identity: edited b.ts got a new object carrying the edit',
        runC.identity['b.ts']?.distinct === 2 && runC.identity['b.ts']?.textHasEdit,
        JSON.stringify(runC.identity['b.ts']));

    check('surface: parseDiagnostics is an array', runA.surface.parseDiagnosticsIsArray === true, JSON.stringify(runA.surface));
    check('surface: endOfFileToken has numeric end', runA.surface.endOfFileTokenEnd === true, JSON.stringify(runA.surface));
    check('surface: token-level getChildren (GreaterThanToken present)', runA.surface.hasTokenChildren === true, JSON.stringify(runA.surface));
    check('surface: edit visible through program.getSourceFile (no stale content)', runC.surface.editVisibleOnProgramSf === true, JSON.stringify(runC.surface));
    // Stale-handle negative test: every gen-2 handle probed after the gen-3
    // snapshot flip must either die loudly (err) or serve the value it was
    // captured with (val === captured). A silent different value means the
    // per-snapshot registry resolved the stale id to the rebuilt snapshot's
    // same-id type — the bug class this gate pins.
    const staleProbes = runC.stale?.probes ?? {};
    const staleCaptured = runC.stale?.captured ?? {};
    let staleProbesSeen = 0;
    for (const key of ['bTypeStr', 'cTypeStr', 'cArgsStr', 'bModuleStr']) {
        const p = staleProbes[key];
        if (p === undefined) continue;
        staleProbesSeen++;
        check(`stale: ${key} loud-error or serves captured value (never silent same-id type from new snapshot)`,
            p.err !== undefined || p.val === staleCaptured[key],
            JSON.stringify(p));
    }
    check('stale: at least one probe captured in gen 2', staleProbesSeen >= 2, `seen=${staleProbesSeen}`);
    if (runC.stale?.captured?.bModuleStr === undefined) {
        // b.ts module symbol/type missing is a capture failure, not a probe
        // failure — surface it so a future harness break is visible.
        check('stale: b.ts module type captured (probe present)', staleProbes.bModuleStr !== undefined, JSON.stringify(runC.stale?.captured));
    }

    console.log(`rpc counters: gen1=${runA.rpc} gen1+2=${runB.rpc} gen1+2+3edit=${runC.rpc}`);
    if (failed) {
        console.log(`SUMMARY: ${failed} FAIL`);
        process.exit(1);
    }
    console.log('SUMMARY: all cross-generation reuse checks passed');
}
