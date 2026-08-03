#!/usr/bin/env node
/**
 * Overlay delta-sync witness: a tsserver `change` sequence must reach the
 * bridge as `{edits, baseVersion}` deltas once an overlay base exists, and
 * Go's overlay text after the sequence must equal the host text — proven by
 * resolving identifiers inserted mid-sequence. Covers multi-file,
 * interleaved edits, and an astral (surrogate-pair) boundary before an edit.
 *
 * Wire shape is asserted from the overlay.sync trace events (TNB_TRACE_RPC):
 * the first divergent sync is a full push (establishes the base), and the
 * sync after the second edit round must be delta-shaped with tiny payloads.
 *
 * Usage: node tools/triage-overlay-delta-sync.mjs
 * Exit: 0 = PASS.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const traceFile = '/tmp/tnb-delta-sync-trace.log';
fs.rmSync(traceFile, { force: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-delta-'));
const mainTs = path.join(dir, 'main.ts');
const otherTs = path.join(dir, 'other.ts');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: 'es2022' },
	include: ['*.ts'],
}));
const mainV0 = `const emoji = "😀😀";
const before = 1;
`;
const otherV0 = `export const other = "v1";
`;
fs.writeFileSync(mainTs, mainV0);
fs.writeFileSync(otherTs, otherV0);

// Host-text mirror: the witness composes every edit locally so query
// positions are computed from the true current text, never hand-counted.
const hostText = new Map([[mainTs, mainV0], [otherTs, otherV0]]);
function lineCol(text, index) {
	const pre = text.slice(0, index).split('\n');
	return { line: pre.length, offset: pre[pre.length - 1].length + 1 };
}
async function edit(send, file, at, deleteLen, insert) {
	const text = hostText.get(file);
	const start = lineCol(text, at);
	const end = lineCol(text, at + deleteLen);
	await send('change', { file, line: start.line, offset: start.offset, endLine: end.line, endOffset: end.offset, insertString: insert }, 30_000);
	hostText.set(file, text.slice(0, at) + insert + text.slice(at + deleteLen));
}

const CMD = 30_000;
let bad = 0;
const fail = msg => { bad++; console.error(`FAIL ${msg}`); };

await withTsserver(
	{ tsserverPath: tnbPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env: tnbHarnessEnv({ TNB_TRACE_RPC: '1', TNB_TRACE_RPC_FILE: traceFile }), deadlineMs: 5 * 60 * 1000 },
	async ({ send }) => {
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [
			{ file: mainTs, fileContent: mainV0, projectRootPath: dir },
			{ file: otherTs, fileContent: otherV0, projectRootPath: dir },
		] }, CMD);
		const warm = await send('quickinfo', { file: mainTs, line: 2, offset: 7 }, CMD);
		if (!warm?.success) fail(`warm quickinfo unsuccessful: ${warm?.message}`);

		const qiAt = async (file, needle, round) => {
			const text = hostText.get(file);
			const at = text.indexOf(needle);
			if (at < 0) { fail(`${round}: needle ${needle} not in host text`); return ''; }
			const pos = lineCol(text, at);
			const r = await send('quickinfo', { file, line: pos.line, offset: pos.offset }, CMD);
			return r?.body?.displayString ?? `<unsuccessful:${r?.message}>`;
		};

		// Round 1 (full push — establishes the overlay base mirror/version).
		await edit(send, mainTs, mainV0.length, 0, 'const deltaBase = 1;\n');
		const d1 = await qiAt(mainTs, 'deltaBase', 'round1');
		if (!d1.includes('deltaBase') || !d1.includes('1')) fail(`round1 deltaBase: ${JSON.stringify(d1)}`);
		else console.log(`ok round1 (full push): ${d1}`);

		// Round 2 (delta): append a marker, then replace an initializer.
		await edit(send, mainTs, hostText.get(mainTs).length, 0, 'const deltaMarker = 42;\n');
		const beforeAt = hostText.get(mainTs).indexOf('= 1;') + 2;
		await edit(send, mainTs, beforeAt, 1, '100');
		// Round 2, second file: interleaved value replace.
		const otherAt = hostText.get(otherTs).indexOf('"v1"');
		await edit(send, otherTs, otherAt, 4, '"v2-longer"');
		// Round 2, astral boundary: comment right after the surrogate pairs.
		const astralAt = hostText.get(mainTs).indexOf('"😀😀"') + 6;
		await edit(send, mainTs, astralAt, 0, ' /* past-astral */');

		const d2 = await qiAt(mainTs, 'deltaMarker', 'round2');
		if (!d2.includes('deltaMarker') || !d2.includes('42')) fail(`round2 deltaMarker: ${JSON.stringify(d2)}`);
		else console.log(`ok round2 deltaMarker: ${d2}`);
		const d3 = await qiAt(mainTs, 'before', 'round2');
		if (!d3.includes('100')) fail(`round2 before replace: ${JSON.stringify(d3)}`);
		else console.log(`ok round2 before: ${d3}`);
		const d4 = await qiAt(otherTs, 'other', 'round2');
		if (!d4.includes('v2-longer')) fail(`round2 other: ${JSON.stringify(d4)}`);
		else console.log(`ok round2 other: ${d4}`);
	},
);

// ── Wire shape from the overlay.sync trace ─────────────────────────────────
const events = fs.existsSync(traceFile)
	? fs.readFileSync(traceFile, 'utf8').split('\n').filter(l => l.includes('overlay.sync')).map(l => l.slice(l.indexOf('overlay.sync')))
	: [];
if (events.length === 0) fail('no overlay.sync trace events (TNB_TRACE_RPC instrumentation missing?)');
for (const e of events) console.log(`trace ${e}`);
const sends = events.filter(e => /deduped=false/.test(e));
if (!sends.some(e => /deltaFiles=0/.test(e))) fail(`expected an initial full push (deltaFiles=0): ${JSON.stringify(sends)}`);
if (!sends.some(e => /deltaFiles=[1-9]/.test(e))) fail(`no delta-shaped sync after the second edit round: ${JSON.stringify(sends)}`);
const byteLines = sends.map(e => +(e.match(/bytes=(\d+)/)?.[1] ?? Infinity));
if (byteLines.some(b => b > 4000)) fail(`delta payload too large (full-text leak?): ${JSON.stringify(byteLines)}`);

console.log(bad === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(bad === 0 ? 0 : 1);
