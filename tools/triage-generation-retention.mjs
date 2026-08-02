#!/usr/bin/env node
/**
 * Generation-retention witness (per-generation leak class).
 *
 * Drives N edit+F12 rounds against a tsserver — each updateOpen textChange
 * forces a new program generation, each definition request pulls types and
 * symbols across the bridge so generation-scoped closures get installed.
 * Post-GC retained heap (heapUsed after two forced major GCs, in-child via
 * tools/tnb-gc-marks.cjs) is sampled at definition-response marks. Any
 * closure that pins a generation island onto a process-global object shows
 * up as a positive heapUsed slope across marks.
 *
 * Verdict: least-squares slope of post-GC heapUsed (MB/round) must stay
 * under the threshold. The first generation is exempt by construction —
 * its island pin is a one-time constant that moves the intercept, not the
 * slope. With --stock-tsserver the threshold is derived from a stock
 * calibration run: max(--max-slope-mb, stockSlope*2 + 0.02); stock is
 * flat on this protocol, so the absolute floor dominates in practice.
 *
 * Usage:
 *   node tools/triage-generation-retention.mjs --tsserver=<path>
 *       [--label=tnb] [--rounds=100] [--marks=2,25,50,75,100]
 *       [--max-slope-mb=0.05] [--stock-tsserver=<path>]
 *       [--keep-fixture=1] [--out=<json>]
 *
 * Exit 0 = within threshold, 1 = regression, 2 = setup/usage error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const gcMarksPath = path.join(toolsDir, 'tnb-gc-marks.cjs');
const { withTsserver } = await import(pathToFileURL(path.join(repoRoot, 'tools/tsserver-harness.mjs')).href);

function argVal(name, dflt) {
    const m = process.argv.find(a => a.startsWith(`--${name}=`));
    return m ? m.split('=')[1] : dflt;
}

const TSSERVER = argVal('tsserver', '');
const STOCK_TSSERVER = argVal('stock-tsserver', '');
const LABEL = argVal('label', 'target');
const ROUNDS = Number(argVal('rounds', '100'));
const MARKS = argVal('marks', '2,25,50,75,100').split(',').map(Number).filter(n => n > 0).sort((a, b) => a - b);
const MAX_SLOPE_MB = Number(argVal('max-slope-mb', '0.05'));
const KEEP_FIXTURE = argVal('keep-fixture', '0') !== '0';
const OUT = argVal('out', '');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node tools/triage-generation-retention.mjs --tsserver=<path> [--rounds=100] [--marks=2,25,50,75,100] [--max-slope-mb=0.05] [--stock-tsserver=<path>]');
    process.exit(2);
}

if (!TSSERVER) usage('missing --tsserver');
if (!fs.existsSync(TSSERVER)) usage(`missing tsserver: ${TSSERVER}`);
if (STOCK_TSSERVER && !fs.existsSync(STOCK_TSSERVER)) usage(`missing stock tsserver: ${STOCK_TSSERVER}`);
if (!fs.existsSync(gcMarksPath)) usage(`missing helper: ${gcMarksPath}`);
if (MARKS.length < 2 || MARKS[MARKS.length - 1] > ROUNDS) usage(`marks must have >=2 entries within rounds=${ROUNDS}`);

// ── Hermetic fixture: 20 cross-importing modules + index probe ─────
const MODULE_COUNT = 20;
const EDIT_LINE = 3; // mod00.ts: `export interface AppConfig { marker: number }`
const NAME_COL = 18; // 1-based col of 'A' in `export interface AppConfig`
const APP = 'AppConfig';
const CUSTOM = 'CustomAppConfig';
const DEF_PROBE = { line: 4, offset: 22 }; // index.ts: `export const probe: T01 = v01;` — inside T01

const pad = n => String(n).padStart(2, '0');

function writeFixture(dir) {
    for (let i = 0; i < MODULE_COUNT; i++) {
        const a = pad(i);
        const b = pad((i + 1) % MODULE_COUNT);
        const c = pad((i + 7) % MODULE_COUNT);
        const lines = [
            `import { T${b}, v${b} } from './mod${b}';`,
            `import { T${c}, v${c} } from './mod${c}';`,
        ];
        if (i === 0) lines.push(`export interface ${APP} { marker: number }`);
        else lines.push(`export interface Extra${a} { e: string }`);
        lines.push(
            `export interface T${a} { v${a}: number; next: T${b}; other?: T${c} }`,
            `export const v${a}: T${a} = { v${a}: ${i}, next: v${b}, other: v${c} };`,
            `export function f${a}(x: T${a}): number { return x.v${a} + v${b}.v${b}; }`,
        );
        fs.writeFileSync(path.join(dir, `mod${a}.ts`), lines.join('\n') + '\n');
    }
    fs.writeFileSync(path.join(dir, 'index.ts'), [
        `import { T01, v01 } from './mod01';`,
        `import { T07, v07 } from './mod07';`,
        `import { T13, v13 } from './mod13';`,
        `export const probe: T01 = v01;`,
        `export const probe2: T07 = v07;`,
        `export const probe3: T13 = v13;`,
        `export const total: number = probe.v01 + probe2.v07 + probe3.v13;`,
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'es2020',
            module: 'commonjs',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
        },
        include: ['*.ts'],
    }, null, 2) + '\n');
}

function slopeMbPerRound(points) {
    const n = points.length;
    const sx = points.reduce((s, p) => s + p.def, 0);
    const sy = points.reduce((s, p) => s + p.heapUsedMb, 0);
    const sxx = points.reduce((s, p) => s + p.def * p.def, 0);
    const sxy = points.reduce((s, p) => s + p.def * p.heapUsedMb, 0);
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

async function runSession({ tsserverPath, label, fixtureDir }) {
    const editFile = path.join(fixtureDir, 'mod00.ts');
    const indexFile = path.join(fixtureDir, 'index.ts');
    const memlogFile = path.join(fixtureDir, `gcmarks-${label}.log`);
    fs.writeFileSync(memlogFile, '');
    const markSet = new Set(MARKS);
    const found = new Map();

    const readMark = def => {
        const text = fs.readFileSync(memlogFile, 'utf8');
        const m = text.match(new RegExp(`GCMARK def=${def} heapUsed=(\\d+) heapTotal=(\\d+) rss=(\\d+)`));
        return m ? { def, heapUsedMb: Number(m[1]) / 1048576, heapTotalMb: Number(m[2]) / 1048576, rssMb: Number(m[3]) / 1048576 } : null;
    };
    const waitMark = async def => {
        const t0 = Date.now();
        for (;;) {
            const hit = readMark(def);
            if (hit) return hit;
            if (Date.now() - t0 > 120_000) throw new Error(`GCMARK def=${def} did not land within 120s (in-child GC failed?)`);
            await new Promise(r => setTimeout(r, 200));
        }
    };

    await withTsserver(
        {
            tsserverPath,
            args: ['--disableAutomaticTypingAcquisition'],
            env: {
                NODE_OPTIONS: `--require ${gcMarksPath}`,
                TNB_GC_MARKS: MARKS.join(','),
                TNB_MEMLOG_FILE: memlogFile,
            },
            deadlineMs: 900_000,
        },
        async ({ send }) => {
            await send('configure', { preferences: { includeCompletionsForModuleExports: false } });
            await send('updateOpen', {
                changedFiles: [],
                closedFiles: [],
                openFiles: [
                    { file: indexFile, fileContent: fs.readFileSync(indexFile, 'utf8'), projectRootPath: fixtureDir },
                    { file: editFile, fileContent: fs.readFileSync(editFile, 'utf8'), projectRootPath: fixtureDir },
                ],
            });
            // Wait until index.ts lands in the configured project.
            const tProject = Date.now();
            for (;;) {
                const r = await send('projectInfo', { file: indexFile, needFileNameList: false });
                const name = r?.body?.configFileName ?? '';
                if (name.endsWith('tsconfig.json')) break;
                if (Date.now() - tProject > 180_000) throw new Error(`project not configured after 180s (configFileName=${name || '?'})`);
                await new Promise(r2 => setTimeout(r2, 500));
            }
            // No warmup definition: the helper counts definition responses,
            // so definition #N must map to round N.
            for (let round = 1; round <= ROUNDS; round++) {
                const toCustom = round % 2 === 1;
                const textChanges = toCustom
                    ? [{ start: { line: EDIT_LINE, offset: NAME_COL }, end: { line: EDIT_LINE, offset: NAME_COL }, newText: 'Custom' }]
                    : [{ start: { line: EDIT_LINE, offset: NAME_COL }, end: { line: EDIT_LINE, offset: NAME_COL + CUSTOM.length - APP.length }, newText: '' }];
                await send('updateOpen', { changedFiles: [{ fileName: editFile, textChanges }], openFiles: [], closedFiles: [] });
                const def = await send('definition', { file: indexFile, ...DEF_PROBE });
                if (!def?.success) throw new Error(`definition failed at round ${round}: ${JSON.stringify(def).slice(0, 300)}`);
                if (markSet.has(round)) {
                    const hit = await waitMark(round);
                    found.set(round, hit);
                    console.log(`[${label}] mark def=${round}: heapUsed=${hit.heapUsedMb.toFixed(1)}MB heapTotal=${hit.heapTotalMb.toFixed(1)}MB rss=${hit.rssMb.toFixed(0)}MB`);
                }
            }
        },
    );

    const points = MARKS.map(d => found.get(d) ?? readMark(d)).filter(Boolean);
    if (points.length !== MARKS.length) throw new Error(`missing marks: got ${points.length}/${MARKS.length}`);
    return { label, tsserverPath, rounds: ROUNDS, marks: points, slopeMbPerRound: slopeMbPerRound(points) };
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-genret-'));
const report = { fixtureDir: KEEP_FIXTURE ? fixtureDir : undefined, startedAt: new Date().toISOString() };
try {
    writeFixture(fixtureDir);
    let threshold = MAX_SLOPE_MB;
    if (STOCK_TSSERVER) {
        report.stock = await runSession({ tsserverPath: STOCK_TSSERVER, label: 'stock', fixtureDir });
        threshold = Math.max(MAX_SLOPE_MB, report.stock.slopeMbPerRound * 2 + 0.02);
        console.log(`[stock] slope=${report.stock.slopeMbPerRound.toFixed(4)}MB/round → threshold=${threshold.toFixed(4)}MB/round`);
    }
    report.target = await runSession({ tsserverPath: TSSERVER, label: LABEL, fixtureDir });
    report.thresholdMbPerRound = threshold;
    report.slopeMbPerRound = report.target.slopeMbPerRound;
    report.ok = report.slopeMbPerRound <= threshold;
    console.log(`[${LABEL}] slope=${report.slopeMbPerRound.toFixed(4)}MB/round threshold=${threshold.toFixed(4)}MB/round → ${report.ok ? 'PASS' : 'FAIL'}`);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
}
catch (err) {
    console.error(`triage-generation-retention: ${err?.message ?? err}`);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ...report, ok: false, error: String(err?.message ?? err) }, null, 2) + '\n');
    process.exit(2);
}
finally {
    if (!KEEP_FIXTURE) fs.rmSync(fixtureDir, { recursive: true, force: true });
}
