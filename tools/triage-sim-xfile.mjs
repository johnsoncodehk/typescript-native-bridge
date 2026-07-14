#!/usr/bin/env node
/**
 * IDE sim C: cross-file ops + project lifecycle — TNB vs stock tsserver diff.
 * Read-only fixtures; all edits via in-memory updateOpen textChanges.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');
const cm = path.join(tw, 'component-meta');
const throwFile = '/tmp/tnb-sim-c-throws.jsonl';
const outJson = '/tmp/tnb-sim-c-xfile-result.json';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
];

const KEYWORDS = new Set(`
abstract accessor any as asserts async await boolean break case catch class const continue
debugger declare default delete do else enum export extends false finally for from function
get global if implements import in infer instanceof interface intrinsic keyof let module
namespace never new null number object of package private protected public readonly require
return set static string super switch symbol this throw true try type typeof undefined unique
unknown var void while with yield satisfies overrides bigint
`.trim().split(/\s+/));

function existsFile(p) {
	try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}
function normFile(f) { return f == null ? '' : String(f); }
function badTnbPath(f) {
	const s = normFile(f);
	if (!s) return false;
	if (s.startsWith('bundled://')) return true;
	if (!existsFile(s)) return true;
	return false;
}
function offsetToLoc(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
function firstIdentifier(text) {
	const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	let m;
	while ((m = re.exec(text))) {
		if (KEYWORDS.has(m[0])) continue;
		return { name: m[0], ...offsetToLoc(text, m.index), index: m.index };
	}
	const m2 = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/);
	if (!m2) return null;
	return { name: m2[0], ...offsetToLoc(text, m2.index), index: m2.index };
}
function sortKeys(a) { return [...a].sort(); }
function sameSet(a, b) {
	const sa = sortKeys(a), sb = sortKeys(b);
	return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
function diagSet(diags) {
	return (diags ?? []).map(d => {
		const start = d.start ?? d.startLocation;
		const line = typeof start === 'object' ? start.line : undefined;
		const offset = typeof start === 'object' ? start.offset : start;
		return `${d.code}:${line ?? '?'}:${offset ?? '?'}`;
	}).sort();
}
function locsFromRename(body) {
	const out = [];
	for (const fileLocs of body?.locs ?? []) {
		const file = normFile(fileLocs.file);
		for (const l of fileLocs.locs ?? []) {
			out.push({ file, line: l.start?.line, offset: l.start?.offset });
		}
	}
	return out;
}
function locsFromRefs(body) {
	const refs = body?.refs ?? (Array.isArray(body) ? body : []);
	return (refs ?? []).map(r => ({ file: normFile(r.file), line: r.start?.line, offset: r.start?.offset }));
}
function locsFromImpl(body) {
	const arr = Array.isArray(body) ? body : (body ?? []);
	return (arr ?? []).map(r => ({ file: normFile(r.file), line: r.start?.line, offset: r.start?.offset }));
}
function navtoPairs(body) {
	return (Array.isArray(body) ? body : []).map(e => ({ name: e.name, file: normFile(e.file) }));
}
function setOfLocs(locs) { return locs.map(l => `${l.file}:${l.line}:${l.offset}`); }
function setOfNav(pairs) { return pairs.map(p => `${p.name}@${p.file}`); }
function read(p) { return fs.readFileSync(p, 'utf8'); }

const S1_A = path.join(cm, 'ts-component/PropDefinitions.ts');
const S1_B = path.join(cm, 'ts-component/component.ts');
const S1_C = path.join(cm, 'ts-named-export/component.ts');
const S1_SYM = 'simCrossExport';
const S1_SYM_BROKEN = 'simCrossExportBroken';
const s1ContentA = `export function ${S1_SYM}(): number {\n\treturn 1;\n}\n`;
const s1ContentB = `import { ${S1_SYM} } from './PropDefinitions';\nexport function simConsumerB(): number {\n\treturn ${S1_SYM}();\n}\n`;
const s1ContentC = `import { ${S1_SYM} } from '../ts-component/PropDefinitions';\nexport function simConsumerC(): number {\n\treturn ${S1_SYM}();\n}\n`;
const s1ContentABroken = s1ContentA.replaceAll(S1_SYM, S1_SYM_BROKEN);

const discoveryFiles = [
	path.join(cm, 'ts-component/PropDefinitions.ts'),
	path.join(cm, 'ts-component/component.ts'),
	path.join(cm, 'ts-named-export/component.ts'),
	path.join(cm, 'reference-type-props/my-props.ts'),
	path.join(cm, 'reference-type-props/component.vue'),
	path.join(cm, 'reference-type-events/my-events.ts'),
	path.join(cm, 'reference-type-events/component.vue'),
	path.join(cm, 'reference-type-slots/my-slots.ts'),
	path.join(cm, 'reference-type-slots/component.vue'),
	path.join(cm, 'reference-type-exposed/my-exposed.ts'),
	path.join(cm, 'reference-type-exposed/component.vue'),
	path.join(cm, 'generic/main.vue'),
	path.join(cm, 'generic/component.vue'),
];

const churnFiles = [
	path.join(cm, '#4577/main.vue'),
	path.join(cm, 'generic/main.vue'),
	path.join(cm, 'generic/component.vue'),
	path.join(cm, 'ts-component/component.ts'),
	path.join(cm, 'ts-component/PropDefinitions.ts'),
	path.join(cm, 'reference-type-props/component.vue'),
	path.join(cm, 'reference-type-props/my-props.ts'),
	path.join(cm, 'reference-type-slots/component.vue'),
];

const diskContent = {};
for (const f of [...new Set([...discoveryFiles, ...churnFiles, S1_A, S1_B, S1_C])]) {
	if (existsFile(f)) diskContent[f] = read(f);
}

const units = [];
let pickedSymbols = [];

function recordUnit(u) { units.push(u); return u; }
function summarizeSide(side) {
	if (!side) return null;
	return {
		success: side.success,
		set: side.set ? sortKeys(side.set).slice(0, 40) : undefined,
		setN: side.set?.length,
		scalar: side.scalar,
		raw: side.raw,
	};
}
function compareUnit({ id, scene, command, target, tnb, stock }) {
	const reasons = [];
	if (!!tnb?.success !== !!stock?.success) reasons.push('success-mismatch');
	if (tnb?.badPaths?.length) reasons.push('tnb-bad-path:' + tnb.badPaths.join('|'));
	if (tnb?.set != null && stock?.set != null && !sameSet(tnb.set, stock.set)) reasons.push('set-mismatch');
	if (tnb?.scalar != null && stock?.scalar != null && tnb.scalar !== stock.scalar) reasons.push('scalar-mismatch');
	const status = reasons.length ? 'DIFF' : 'MATCH';
	return recordUnit({
		id, scene, command, target, status,
		reason: reasons.join(',') || undefined,
		tnbKey: summarizeSide(tnb),
		stockKey: summarizeSide(stock),
	});
}

function createEventSink() {
	const byFile = new Map();
	const waiters = new Set();
	function notify() { for (const w of [...waiters]) w(); }
	function onEvent(ev) {
		const e = ev?.event;
		const file = ev?.body?.file;
		if (file && (e === 'syntaxDiag' || e === 'semanticDiag' || e === 'suggestionDiag')) {
			if (!byFile.has(file)) byFile.set(file, {});
			const slot = byFile.get(file);
			const diags = ev.body.diagnostics ?? [];
			if (e === 'syntaxDiag') slot.syntax = diags;
			if (e === 'semanticDiag') slot.semantic = diags;
			if (e === 'suggestionDiag') slot.suggestion = diags;
			notify();
		}
	}
	function clearFiles(files) { for (const f of files) byFile.set(f, {}); }
	async function geterrCollect(send, files, timeoutMs = 45_000) {
		clearFiles(files);
		const waitDone = new Promise((resolve) => {
			const t0 = Date.now();
			const tick = () => {
				const ready = files.every(f => {
					const s = byFile.get(f);
					return s && s.syntax != null && s.semantic != null && s.suggestion != null;
				});
				if (ready) { waiters.delete(tick); clearInterval(iv); resolve('ready'); return; }
				if (Date.now() - t0 > timeoutMs) { waiters.delete(tick); clearInterval(iv); resolve('timeout'); }
			};
			waiters.add(tick);
			const iv = setInterval(tick, 25);
		});
		const sendP = send('geterr', { delay: 0, files }, timeoutMs).catch(() => null);
		await Promise.race([waitDone, sendP.then(async () => waitDone)]);
		await new Promise(r => setTimeout(r, 50));
		const out = {};
		for (const f of files) out[f] = byFile.get(f) ?? {};
		return out;
	}
	return { onEvent, geterrCollect };
}

function openFilesArgs(files, contentMap, projectRootPath) {
	return files.map(f => ({
		file: f,
		fileContent: contentMap[f] ?? diskContent[f] ?? '',
		projectRootPath,
	}));
}
function textChangeReplaceAll(file, oldText, newText) {
	const end = offsetToLoc(oldText, oldText.length);
	return {
		fileName: file,
		textChanges: [{
			start: { line: 1, offset: 1 },
			end: { line: end.line, offset: end.offset },
			newText,
		}],
	};
}

function buildDiscoveryCandidates(maxN = 100) {
	const candidates = [];
	const seenPos = new Set();
	function pushCand(name, file, index) {
		if (KEYWORDS.has(name)) return;
		const loc = offsetToLoc(diskContent[file], index);
		const key = `${file}:${loc.line}:${loc.offset}`;
		if (seenPos.has(key)) return;
		seenPos.add(key);
		candidates.push({ name, file, line: loc.line, offset: loc.offset });
	}
	// Seed known exported cross-file symbols first (deterministic positions).
	const seeds = [
		[path.join(cm, 'ts-component/PropDefinitions.ts'), 'MyProps'],
		[path.join(cm, 'reference-type-props/my-props.ts'), 'MyNestedProps'],
		[path.join(cm, 'reference-type-events/my-events.ts'), 'MyEvents'],
		[path.join(cm, 'reference-type-slots/my-slots.ts'), 'MySlots'],
		[path.join(cm, 'reference-type-exposed/my-exposed.ts'), 'MyExposed'],
		[path.join(cm, 'ts-named-export/component.ts'), 'Foo'],
		[path.join(cm, 'ts-named-export/component.ts'), 'Bar'],
		[path.join(cm, 'reference-type-props/my-props.ts'), 'StringRequired'],
		[path.join(cm, 'ts-component/component.ts'), 'defineComponent'],
	];
	for (const [file, name] of seeds) {
		const text = diskContent[file];
		if (!text) continue;
		const re = new RegExp(`\\b${name}\\b`);
		const m = re.exec(text);
		if (m) pushCand(name, file, m.index);
	}
	// Spread walk: cap per file so later files (MyEvents/…) are reached.
	const perFileCap = 6;
	for (const f of discoveryFiles) {
		const text = diskContent[f];
		if (!text) continue;
		const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
		let m;
		const seenNameInFile = new Set();
		let nThis = 0;
		while ((m = re.exec(text))) {
			const name = m[0];
			if (KEYWORDS.has(name)) continue;
			if (seenNameInFile.has(name)) continue;
			seenNameInFile.add(name);
			pushCand(name, f, m.index);
			nThis++;
			if (nThis >= perFileCap) break;
			if (candidates.length >= maxN) return candidates;
		}
	}
	return candidates.slice(0, maxN);
}

async function discoverSymbols(send, candidates) {
	const found = [];
	const seenNames = new Set();
	for (const c of candidates) {
		let refs;
		try { refs = await send('references', { file: c.file, line: c.line, offset: c.offset }, 25_000); }
		catch { continue; }
		if (!refs?.success) continue;
		const locs = locsFromRefs(refs.body).filter(l => l.file.startsWith(tw));
		const fileSet = new Set(locs.map(l => l.file));
		if (fileSet.size < 2) continue;
		if (seenNames.has(c.name)) continue;
		seenNames.add(c.name);
		found.push({
			name: c.name, file: c.file, line: c.line, offset: c.offset,
			fileCount: fileSet.size, nrefs: locs.length, files: [...fileSet].sort(),
		});
		// do NOT early-return — finish all candidate refs for byte-identical cmds
	}
	return found.slice(0, 5);
}

async function runSide(label, tsserverPath, env, fixedSymbols = null) {
	const sink = createEventSink();
	const captured = {};
	const meta = { label, symbols: [], churnOpenAfter: [], scene5QuickinfoTargets: [] };

	await withTsserver({
		tsserverPath, args: harnessArgs, env, deadlineMs: 600_000, onEvent: sink.onEvent,
	}, async ({ send }) => {
		await send('configure', { preferences: {} });

		// SCENE 1
		const s1Map = { [S1_A]: s1ContentA, [S1_B]: s1ContentB, [S1_C]: s1ContentC };
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs([S1_A, S1_B, S1_C], s1Map, cm) });
		{
			const diags = await sink.geterrCollect(send, [S1_B, S1_C], 60_000);
			captured['s1:baseline:B'] = { success: true, set: diagSet(diags[S1_B]?.semantic), raw: { semantic: diags[S1_B]?.semantic ?? [] } };
			captured['s1:baseline:C'] = { success: true, set: diagSet(diags[S1_C]?.semantic), raw: { semantic: diags[S1_C]?.semantic ?? [] } };
		}
		await send('updateOpen', { openFiles: [], closedFiles: [], changedFiles: [textChangeReplaceAll(S1_A, s1ContentA, s1ContentABroken)] });
		{
			const diags = await sink.geterrCollect(send, [S1_B, S1_C], 60_000);
			captured['s1:broken:B'] = { success: true, set: diagSet(diags[S1_B]?.semantic), raw: { semantic: diags[S1_B]?.semantic ?? [] } };
			captured['s1:broken:C'] = { success: true, set: diagSet(diags[S1_C]?.semantic), raw: { semantic: diags[S1_C]?.semantic ?? [] } };
		}
		await send('updateOpen', { openFiles: [], closedFiles: [], changedFiles: [textChangeReplaceAll(S1_A, s1ContentABroken, s1ContentA)] });
		{
			const diags = await sink.geterrCollect(send, [S1_B, S1_C], 60_000);
			captured['s1:reverted:B'] = { success: true, set: diagSet(diags[S1_B]?.semantic), raw: { semantic: diags[S1_B]?.semantic ?? [] } };
			captured['s1:reverted:C'] = { success: true, set: diagSet(diags[S1_C]?.semantic), raw: { semantic: diags[S1_C]?.semantic ?? [] } };
		}
		await send('updateOpen', { openFiles: [], changedFiles: [], closedFiles: [S1_A, S1_B, S1_C] });

		// SCENE 2+3
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs(discoveryFiles, diskContent, cm) });
		// Fixed candidate list (disk-only) → identical refs probes on both sides.
		// Action symbols: STOCK pick (fixedSymbols) so rename/etc. targets match.
		const candidates = buildDiscoveryCandidates(100);
		const discovered = await discoverSymbols(send, candidates);
		const symbols = (fixedSymbols && fixedSymbols.length) ? fixedSymbols : discovered;
		meta.symbols = symbols;
		meta.discovered = discovered;
		captured.__symbols = symbols;
		captured.__discovered = discovered;

		for (const sym of symbols) {
			const idBase = `${sym.name}@${path.basename(sym.file)}:${sym.line}:${sym.offset}`;
			let renameRes;
			try {
				renameRes = await send('rename', {
					file: sym.file, line: sym.line, offset: sym.offset,
					findInComments: false, findInStrings: false,
				}, 30_000);
			} catch (e) { renameRes = { success: false, message: String(e.message ?? e) }; }
			const renameLocs = locsFromRename(renameRes?.body);
			captured[`s2:rename:${idBase}`] = {
				success: !!renameRes?.success, set: setOfLocs(renameLocs),
				raw: { canRename: renameRes?.body?.info?.canRename, locsN: renameLocs.length, sample: renameLocs.slice(0, 8) },
				badPaths: label === 'TNB' ? [...new Set(renameLocs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [],
			};

			let refRes;
			try { refRes = await send('references', { file: sym.file, line: sym.line, offset: sym.offset }, 30_000); }
			catch (e) { refRes = { success: false, message: String(e.message ?? e) }; }
			const refLocs = locsFromRefs(refRes?.body);
			captured[`s3:references:${idBase}`] = {
				success: !!refRes?.success, set: setOfLocs(refLocs),
				raw: { n: refLocs.length, sample: refLocs.slice(0, 8) },
				badPaths: label === 'TNB' ? [...new Set(refLocs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [],
			};

			let implRes;
			try { implRes = await send('implementation', { file: sym.file, line: sym.line, offset: sym.offset }, 30_000); }
			catch (e) { implRes = { success: false, message: String(e.message ?? e) }; }
			const implLocs = locsFromImpl(implRes?.body);
			captured[`s3:implementation:${idBase}`] = {
				success: !!implRes?.success, set: setOfLocs(implLocs),
				raw: { n: implLocs.length, sample: implLocs.slice(0, 8) },
				badPaths: label === 'TNB' ? [...new Set(implLocs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [],
			};

			let navRes;
			try { navRes = await send('navto', { searchValue: sym.name, currentFileOnly: false }, 30_000); }
			catch (e) { navRes = { success: false, message: String(e.message ?? e) }; }
			const pairs = navtoPairs(navRes?.body);
			captured[`s3:navto:${idBase}`] = {
				success: !!navRes?.success, set: setOfNav(pairs),
				raw: { n: pairs.length, sample: pairs.slice(0, 8) },
				badPaths: label === 'TNB' ? [...new Set(pairs.filter(p => badTnbPath(p.file)).map(p => p.file))] : [],
			};
		}
		await send('updateOpen', { openFiles: [], changedFiles: [], closedFiles: discoveryFiles });

		// SCENE 4
		for (let cycle = 1; cycle <= 3; cycle++) {
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs(churnFiles, diskContent, cm) });
			const toClose = churnFiles.slice(0, 4);
			const stillOpen = churnFiles.slice(4);
			await send('updateOpen', { openFiles: [], changedFiles: [], closedFiles: toClose });
			const toReopen = toClose.slice(0, 2);
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs(toReopen, diskContent, cm) });
			const openNow = [...stillOpen, ...toReopen];
			if (cycle === 1) meta.churnOpenAfter = openNow;

			for (const f of openNow) {
				const text = diskContent[f] ?? '';
				const ident = firstIdentifier(text);
				const idQi = `s4:c${cycle}:quickinfo:${path.basename(path.dirname(f))}/${path.basename(f)}`;
				if (!ident) {
					captured[idQi] = { success: false, scalar: 'no-ident', set: [], raw: null };
				} else {
					let qi;
					try { qi = await send('quickinfo', { file: f, line: ident.line, offset: ident.offset }, 20_000); }
					catch (e) { qi = { success: false, message: String(e.message ?? e) }; }
					captured[idQi] = {
						success: !!qi?.success,
						scalar: `${qi?.body?.kind ?? ''}|${qi?.body?.displayString ?? ''}`,
						raw: { kind: qi?.body?.kind, displayString: qi?.body?.displayString, ident },
					};
				}
				const idGe = `s4:c${cycle}:geterr:${path.basename(path.dirname(f))}/${path.basename(f)}`;
				const diags = await sink.geterrCollect(send, [f], 45_000);
				captured[idGe] = { success: true, set: diagSet(diags[f]?.semantic), raw: { semantic: (diags[f]?.semantic ?? []).slice(0, 10) } };
			}
			await send('updateOpen', { openFiles: [], changedFiles: [], closedFiles: openNow });
		}

		// SCENE 5
		const s5Files = meta.churnOpenAfter.length ? meta.churnOpenAfter : churnFiles.slice(4);
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs(s5Files, diskContent, cm) });
		meta.scene5QuickinfoTargets = s5Files;
		const needFile = s5Files[0];
		let pinfo;
		try { pinfo = await send('projectInfo', { file: needFile, needFileNameList: false }, 20_000); }
		catch (e) { pinfo = { success: false, message: String(e.message ?? e) }; }
		captured['s5:projectInfo'] = {
			success: !!pinfo?.success,
			scalar: `${pinfo?.body?.configFileName ?? ''}|${pinfo?.body?.languageServiceDisabled ?? ''}`,
			raw: { configFileName: pinfo?.body?.configFileName, fileNamesN: pinfo?.body?.fileNames?.length },
		};
		await send('configure', { preferences: { quotePreference: 'single', includeCompletionsForModuleExports: true } });
		await send('configure', { preferences: {} });
		captured['s5:configure'] = { success: true, scalar: 'ok', raw: { note: 'preferences changed then restored' } };
		try {
			await send('reloadProjects', {}, 60_000);
			captured['s5:reloadProjects'] = { success: true, scalar: 'ok', raw: {} };
		} catch (e) {
			captured['s5:reloadProjects'] = { success: false, scalar: String(e.message ?? e), raw: {} };
		}
		for (const f of s5Files) {
			const text = diskContent[f] ?? '';
			const ident = firstIdentifier(text);
			const idQi = `s5:quickinfo:${path.basename(path.dirname(f))}/${path.basename(f)}`;
			if (!ident) { captured[idQi] = { success: false, scalar: 'no-ident', set: [], raw: null }; continue; }
			let qi;
			try { qi = await send('quickinfo', { file: f, line: ident.line, offset: ident.offset }, 20_000); }
			catch (e) { qi = { success: false, message: String(e.message ?? e) }; }
			captured[idQi] = {
				success: !!qi?.success,
				scalar: `${qi?.body?.kind ?? ''}|${qi?.body?.displayString ?? ''}`,
				raw: { kind: qi?.body?.kind, displayString: qi?.body?.displayString, ident },
			};
		}
	});

	return { captured, meta };
}

async function replayDiff(unit) {
	async function minimal(label, tsserverPath, env) {
		const sink = createEventSink();
		return withTsserver({
			tsserverPath, args: harnessArgs, env, deadlineMs: 120_000, onEvent: sink.onEvent,
		}, async ({ send }) => {
			await send('configure', { preferences: {} });
			const command = unit.command;

			if (unit.id.startsWith('s1:')) {
				const broken = unit.id.includes('broken');
				const file = unit.id.endsWith(':B') ? S1_B : S1_C;
				await send('updateOpen', {
					changedFiles: [], closedFiles: [],
					openFiles: openFilesArgs([S1_A, S1_B, S1_C], {
						[S1_A]: broken ? s1ContentABroken : s1ContentA,
						[S1_B]: s1ContentB, [S1_C]: s1ContentC,
					}, cm),
				});
				const diags = await sink.geterrCollect(send, [file], 45_000);
				return { success: true, set: diagSet(diags[file]?.semantic), raw: { semantic: diags[file]?.semantic ?? [] } };
			}

			if (unit.id.startsWith('s2:') || unit.id.startsWith('s3:')) {
				const sym = pickedSymbols.find(s => unit.id.includes(`${s.name}@`));
				if (!sym) return { success: false, raw: { error: 'symbol-not-found' } };
				await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs(discoveryFiles, diskContent, cm) });
				if (command === 'rename') {
					const r = await send('rename', { file: sym.file, line: sym.line, offset: sym.offset, findInComments: false, findInStrings: false }, 30_000);
					const locs = locsFromRename(r?.body);
					return { success: !!r?.success, set: setOfLocs(locs), raw: { n: locs.length, sample: locs.slice(0, 8) },
						badPaths: label === 'TNB' ? [...new Set(locs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [] };
				}
				if (command === 'references') {
					const r = await send('references', { file: sym.file, line: sym.line, offset: sym.offset }, 30_000);
					const locs = locsFromRefs(r?.body);
					return { success: !!r?.success, set: setOfLocs(locs), raw: { n: locs.length, sample: locs.slice(0, 8) },
						badPaths: label === 'TNB' ? [...new Set(locs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [] };
				}
				if (command === 'implementation') {
					const r = await send('implementation', { file: sym.file, line: sym.line, offset: sym.offset }, 30_000);
					const locs = locsFromImpl(r?.body);
					return { success: !!r?.success, set: setOfLocs(locs), raw: { n: locs.length, sample: locs.slice(0, 8) },
						badPaths: label === 'TNB' ? [...new Set(locs.filter(l => badTnbPath(l.file)).map(l => l.file))] : [] };
				}
				if (command === 'navto') {
					const r = await send('navto', { searchValue: sym.name, currentFileOnly: false }, 30_000);
					const pairs = navtoPairs(r?.body);
					return { success: !!r?.success, set: setOfNav(pairs), raw: { n: pairs.length, sample: pairs.slice(0, 8) },
						badPaths: label === 'TNB' ? [...new Set(pairs.filter(p => badTnbPath(p.file)).map(p => p.file))] : [] };
				}
			}

			if (unit.id.startsWith('s4:') || unit.id.startsWith('s5:quickinfo')) {
				const m = unit.id.match(/:(?:quickinfo|geterr):(.+)$/);
				const tail = m?.[1];
				const file = churnFiles.find(f => `${path.basename(path.dirname(f))}/${path.basename(f)}` === tail);
				if (!file) return { success: false, raw: { error: 'file-not-found', tail } };
				await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs([file], diskContent, cm) });
				if (command === 'geterr') {
					const diags = await sink.geterrCollect(send, [file], 45_000);
					return { success: true, set: diagSet(diags[file]?.semantic), raw: { semantic: diags[file]?.semantic ?? [] } };
				}
				const ident = firstIdentifier(diskContent[file] ?? '');
				if (!ident) return { success: false, scalar: 'no-ident' };
				const qi = await send('quickinfo', { file, line: ident.line, offset: ident.offset }, 20_000);
				return { success: !!qi?.success, scalar: `${qi?.body?.kind ?? ''}|${qi?.body?.displayString ?? ''}`,
					raw: { kind: qi?.body?.kind, displayString: qi?.body?.displayString } };
			}

			if (unit.id === 's5:projectInfo') {
				const f = churnFiles[4];
				await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: openFilesArgs([f], diskContent, cm) });
				const pinfo = await send('projectInfo', { file: f, needFileNameList: false }, 20_000);
				return { success: !!pinfo?.success, scalar: `${pinfo?.body?.configFileName ?? ''}|${pinfo?.body?.languageServiceDisabled ?? ''}`,
					raw: { configFileName: pinfo?.body?.configFileName } };
			}
			if (unit.id === 's5:configure' || unit.id === 's5:reloadProjects') {
				return { success: true, scalar: 'ok', raw: { note: 'lifecycle no-op replay' } };
			}
			return { success: false, raw: { error: 'unhandled-replay', id: unit.id } };
		});
	}

	const stock = await minimal('STOCK', stockPath, process.env);
	const tnb = await minimal('TNB', tnbPath, tnbHarnessEnv({ TNB_TRACE_THROW: '1', TNB_TRACE_THROW_FILE: throwFile }));
	const stillDiff = (() => {
		if (!!tnb?.success !== !!stock?.success) return true;
		if (tnb?.badPaths?.length) return true;
		if (tnb?.set != null && stock?.set != null && !sameSet(tnb.set, stock.set)) return true;
		if (tnb?.scalar != null && stock?.scalar != null && tnb.scalar !== stock.scalar) return true;
		return false;
	})();
	return { class: stillDiff ? 'ALWAYS' : 'SEQ-ONLY', stock, tnb };
}

function sceneOfId(id) {
	if (id.startsWith('s1:')) return 1;
	if (id.startsWith('s2:')) return 2;
	if (id.startsWith('s3:')) return 3;
	if (id.startsWith('s4:')) return 4;
	if (id.startsWith('s5:')) return 5;
	return 0;
}
function commandOfId(id) {
	if (id.includes(':rename:')) return 'rename';
	if (id.includes(':references:')) return 'references';
	if (id.includes(':implementation:')) return 'implementation';
	if (id.includes(':navto:')) return 'navto';
	if (id.includes(':quickinfo:')) return 'quickinfo';
	if (id.includes(':geterr:') || id.includes('baseline') || id.includes('broken') || id.includes('reverted')) return 'geterr';
	if (id.includes('projectInfo')) return 'projectInfo';
	if (id.includes('configure')) return 'configure';
	if (id.includes('reloadProjects')) return 'reloadProjects';
	return 'unknown';
}

async function main() {
	try { fs.rmSync(throwFile, { force: true }); } catch { /* ignore */ }

	console.log('== STOCK session ==');
	const stockRun = await runSide('STOCK', stockPath, process.env);
	pickedSymbols = stockRun.meta.symbols;
	console.log('picked symbols:', JSON.stringify(pickedSymbols, null, 2));

	console.log('== TNB session ==');
	const tnbRun = await runSide('TNB', tnbPath, tnbHarnessEnv({
		TNB_TRACE_THROW: '1', TNB_TRACE_THROW_FILE: throwFile,
	}), pickedSymbols);

	const stockKeys = Object.keys(stockRun.captured).filter(k => !k.startsWith('__'));
	const tnbKeys = Object.keys(tnbRun.captured).filter(k => !k.startsWith('__'));
	const stockSyms = stockRun.captured.__symbols ?? [];
	const tnbSyms = tnbRun.captured.__symbols ?? [];
	pickedSymbols = stockSyms;
	const alignNote = [];
	if (JSON.stringify(stockSyms.map(s => s.name)) !== JSON.stringify(tnbSyms.map(s => s.name))) {
		alignNote.push({ stock: stockSyms.map(s => s.name), tnb: tnbSyms.map(s => s.name) });
	}

	function remapTnbKey(stockId) {
		if (!(stockId.startsWith('s2:') || stockId.startsWith('s3:'))) return stockId;
		const m = stockId.match(/^(s[23]:(?:rename|references|implementation|navto):)([^@]+)@/);
		if (!m) return stockId;
		const prefix = m[1];
		const name = m[2];
		const idx = stockSyms.findIndex(s => s.name === name);
		if (idx < 0 || !tnbSyms[idx]) return stockId;
		const tName = tnbSyms[idx].name;
		return tnbKeys.find(k => k.startsWith(prefix) && k.includes(`${tName}@`)) ?? stockId;
	}

	for (const id of stockKeys.sort()) {
		const tnbId = remapTnbKey(id);
		const stock = stockRun.captured[id];
		const tnb = tnbRun.captured[tnbId] ?? { success: false, raw: { missing: true, tnbId } };
		compareUnit({
			id, scene: sceneOfId(id), command: commandOfId(id), target: id.replace(/^s\d+:/, ''),
			tnb, stock,
		});
	}

	const diffs = units.filter(u => u.status === 'DIFF');
	console.log(`comparing done: total=${units.length} diffs=${diffs.length}; replaying...`);
	for (const d of diffs) {
		console.log('replay', d.id);
		try { d.replay = await replayDiff(d); }
		catch (e) { d.replay = { class: 'ALWAYS', error: String(e.message ?? e) }; }
	}

	const match = units.filter(u => u.status === 'MATCH').length;
	const diff = units.filter(u => u.status === 'DIFF').length;
	const skip = units.filter(u => u.status === 'SKIP').length;
	const total = units.length;
	const byScene = {};
	for (const u of units) {
		byScene[u.scene] ??= { total: 0, match: 0, diff: 0, skip: 0 };
		byScene[u.scene].total++;
		byScene[u.scene][u.status.toLowerCase()]++;
	}
	const summaryLine = `SUMMARY: total=${total} match=${match} diff=${diff} skip=${skip}`;
	console.log(summaryLine);
	console.log('byScene', JSON.stringify(byScene));

	const result = {
		summaryLine, total, match, diff, skip,
		conserved: total === match + diff + skip,
		byScene, pickedSymbols, alignNote, units,
		throwsFile: throwFile,
		throwsExists: fs.existsSync(throwFile),
		throwsContent: fs.existsSync(throwFile) ? fs.readFileSync(throwFile, 'utf8') : '',
		deviation: [
			'tsconfigProject/ only ships empty fixture.ts (no 3 mutual .ts on disk). Scene 1 uses three real on-disk .ts under component-meta/ with in-memory mutual-ref content (disk untouched).',
			'Harness args omit --suppressDiagnosticEvents so geterr semanticDiag events are observable.',
		],
		stockKeys, tnbKeys,
	};
	fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
	console.log('wrote', outJson);
	if (total !== match + diff + skip) { console.error('CONSERVATION FAIL'); process.exit(2); }
	process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
