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
    const editedB = fs.readFileSync(bPath, 'utf8') + '\nexport const __edited = 1;\n';

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

    const out = { surface: {}, identity: {} };
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
        if (gen === 3) {
            const sfB = program.getSourceFile(bPath);
            out.surface.editVisibleOnProgramSf = typeof sfB.text === 'string' && sfB.text.includes('__edited');
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

    console.log(`rpc counters: gen1=${runA.rpc} gen1+2=${runB.rpc} gen1+2+3edit=${runC.rpc}`);
    if (failed) {
        console.log(`SUMMARY: ${failed} FAIL`);
        process.exit(1);
    }
    console.log('SUMMARY: all cross-generation reuse checks passed');
}
