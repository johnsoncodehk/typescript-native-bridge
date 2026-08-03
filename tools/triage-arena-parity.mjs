#!/usr/bin/env node
/**
 * Arena-vs-JSON differential gate (part 3). Drives every arena-capable hot
 * method twice on ONE session/snapshot — once over the JSON transport
 * (BridgeCall), once over the V8-arena binary transport (BridgeSetArena +
 * BridgeCallArena, decoded here) — and requires deep-equal results, ids
 * included (same session ⇒ same handles). Any encoder/decoder drift (offset,
 * string-table desync, result shape) fails the gate.
 *
 * Usage: node tools/triage-arena-parity.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const addon = require2(path.join(repoRoot, 'native', 'bridge.node'));
addon.setLibPath(path.join(repoRoot, 'lib'));

// ── Fixture (deterministic) ──────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-arena-parity-'));
const aTs = path.join(dir, 'a.ts');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
	include: ['*.ts'],
}, null, 2));
const aSrc = `export interface Entity<K extends string> { id: K; meta: Record<string, unknown>; tags: string[] }
export interface Model extends Entity<"m"> { value: number; nested: { a: string; b: number[] } }
export type NestedPick = Model["nested"];
export const np: NestedPick = { a: "x", b: [1] };
export type RO = readonly [string, number, boolean];
export type MutTup = [string, number];
export type LabTup = [string, second: number];
export type Lit = "x" | 42 | true;
export class Base { z: string = ""; }
export class Derived extends Base { w?: number; }
/** Adds a number and reports it. @param a the number @param b optional label */
export function add(a: number, b?: string): Promise<number> { return Promise.resolve(a); }
export const callResult = add(1, "s");
export const model: Model = { id: "m", meta: {}, tags: ["t"], value: 1, nested: { a: "x", b: [1] } };
export type Cond<T> = T extends string ? "str" : "other";
export function getKey<T, K extends keyof T>(obj: T, k: K): T[K] { return obj[k]; }
export const lit: Lit = "x";
export const tup: RO = ["a", 1, true];
export const mtup: MutTup = ["a", 1];
export const ltup: LabTup = ["a", 1];
export const maybe: string | null | undefined = null;
export const d = new Derived();
export function generic<T extends object>(x: T): T { return x; }
export const g = generic(model);
export const numLit = 42 as const;
export const strLit = "hello" as const;
export type M<T> = { [P in keyof T]?: T[P] };
export const mm: M<Model> = {};
export const { nested } = model;
export { model as modelAlias };
`;
fs.writeFileSync(aTs, aSrc);

// ── Session + snapshot (JSON transport for setup — document payloads) ────
const h = addon.newSession(dir);
if (!h) { console.error('newSession failed'); process.exit(1); }
const H = BigInt(h);
const jsonCall = (method, params) => {
	const r = addon.call(H, method, params == null ? null : JSON.stringify(params));
	return typeof r === 'string' ? JSON.parse(r) : r;
};
const init = jsonCall('initialize', null);
const snap = jsonCall('updateSnapshot', { openProjects: [path.join(dir, 'tsconfig.json')] });
const snapshot = snap.snapshot ?? snap.id;
const project = (snap.projects ?? [])[0]?.id;
if (snapshot == null || !project) { console.error('updateSnapshot: no snapshot/project', JSON.stringify(snap).slice(0, 400)); process.exit(1); }

// ── Arena client (hand mirror of the wire contract; production decoding is
// additionally covered by the volar/sim gates) ─────────────────────────────
const ARENA_RESP_OFFSET = 1 << 20;
const arenaBuf = Buffer.alloc(4 * 1024 * 1024);
addon.setArena(h, arenaBuf);
const view = new DataView(arenaBuf.buffer, arenaBuf.byteOffset, arenaBuf.byteLength);
const dec = new TextDecoder();
const strTab = [''];

const putStr = (s, off, w) => { const n = arenaBuf.write(s, w.off, 'utf8'); view.setUint32(off, w.off, true); view.setUint32(off + 4, n, true); w.off += n; };
const putHandle = (handle, off, w) => {
	const d1 = handle.indexOf('.'), d2 = handle.indexOf('.', d1 + 1);
	view.setUint32(off, Number(handle.slice(0, d1)), true);
	view.setUint32(off + 4, Number(handle.slice(d1 + 1, d2)), true);
	putStr(handle.slice(d2 + 1), off + 8, w);
};

// ── Rename wire-contract mirror (tsgoChecker.ts filePosRename) ─────────────
// getEditsForRename and getRenameInfo disagree on every byte slot, so they
// must encode independently:
//   getEditsForRename: findInStrings u8 @28, findInComments u8 @29,
//                      providePrefixAndSuffixTextForRename tri @30
//   getRenameInfo:     allowRenameOfImportPath tri @28,
//                      providePrefixAndSuffixTextForRename tri @29, byte 30 = 0
const renameBytes = (method, params) => {
	const tri2 = (b) => b === true ? 1 : b === false ? 2 : 0;
	return method === 'getEditsForRename'
		? [params.findInStrings ? 1 : 0, params.findInComments ? 1 : 0, tri2(params.providePrefixAndSuffixTextForRename)]
		: [tri2(params.allowRenameOfImportPath), tri2(params.providePrefixAndSuffixTextForRename), 0];
};

function arenaCall(method, params) {
	const w = { off: 256 };
	view.setBigUint64(0, BigInt(params.snapshot ?? 0), true);
	putStr(String(params.project ?? ''), 8, w);
	const typeId = params.type ?? params.objectId ?? 0;
	switch (method) {
		case 'getTypeAtLocation': case 'getSymbolAtLocation': case 'getResolvedSignature':
			putHandle(String(params.location), 16, w); break;
		case 'getContextualType':
			putHandle(String(params.location), 16, w); view.setInt32(32, params.contextFlags ?? 0, true); break;
		case 'typeToString':
			view.setUint32(16, typeId >>> 0, true); view.setInt32(20, params.flags ?? 0, true);
			if (params.location != null) putHandle(String(params.location), 24, w);
			else { view.setUint32(24, 0, true); view.setUint32(28, 0, true); view.setUint32(32, 0, true); view.setUint32(36, 0, true); }
			break;
		case 'getSignaturesOfType':
			view.setUint32(16, typeId >>> 0, true); view.setInt32(20, params.kind ?? 0, true); break;
		case 'getTypeOfSymbol': case 'getDeclaredTypeOfSymbol':
			view.setBigUint64(16, BigInt(params.symbol ?? 0), true); break;
		case 'getTypeOfSymbolAtLocation':
			view.setBigUint64(16, BigInt(params.symbol ?? 0), true); putHandle(String(params.location), 24, w); break;
		case 'getSymbolAtPosition':
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true); break;
		case 'getTypeAtPosition': case 'getModuleSymbolForSourceFile':
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true); break;
		case 'quickinfo':
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true);
			view.setInt32(28, params.maximumHoverLength ?? 0, true); view.setInt32(32, params.verbosityLevel ?? -1, true); break;
		case 'references': case 'definitionAndBoundSpan':
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true); break;
		case 'getAliasedSymbol': case 'getImmediateAliasedSymbol': case 'getRootSymbols':
		case 'getExportsOfModule': case 'getExportsAndPropertiesOfModule': case 'getExportsOfSymbol':
		case 'getMembersOfSymbol': case 'getParentOfSymbol': case 'getExportSymbolOfSymbol':
		case 'getDocumentationComment': case 'resolveExternalModuleSymbol': case 'symbolIsValue':
		case 'getLocalTypeParametersOfClassOrInterfaceOrTypeAlias': case 'getJsDocTags':
			view.setBigUint64(16, BigInt(params.symbol ?? params.objectId ?? 0), true); break;
		case 'containsArgumentsReference': case 'getContextualTypeForJsxAttribute':
		case 'getTypeArgumentConstraint': case 'getTypeOfAssignmentPattern':
		case 'isDeclarationVisible': case 'isImplementationOfOverload': case 'isOptionalParameter':
		case 'requiresAddingImplicitUndefined': case 'getJsxFragmentFactory':
		case 'getJsxIntrinsicTagNamesAt': case 'getPropertySymbolOfDestructuringAssignment':
		case 'getSignatureFromDeclaration': case 'getExportSpecifierLocalTargetSymbol':
		case 'resolveExternalModuleName':
			putHandle(String(params.location), 16, w); break;
		case 'getPropertyOfType': case 'getTypeOfPropertyOfType': case 'getTypeOfPropertyOfContextualType':
			view.setUint32(16, typeId >>> 0, true); putStr(String(params.name ?? ''), 20, w); break;
		case 'getStringLiteralType': case 'getBigIntLiteralType':
			putStr(String(params.value ?? ''), 16, w); break;
		case 'getNumberLiteralType':
			view.setFloat64(16, Number(params.value ?? 0), true); break;
		case 'getAccessibleSymbolChain':
			view.setBigUint64(16, BigInt(params.symbol ?? 0), true); putHandle(String(params.enclosingDeclaration), 24, w);
			view.setUint32(40, params.meaning >>> 0, true); view.setUint32(44, params.useOnlyExternalAliasing ? 1 : 0, true); break;
		case 'getCandidateSignaturesForStringLiteralCompletions':
			putHandle(String(params.call), 16, w); putHandle(String(params.editingArgument), 32, w); break;
		case 'tryGetThisTypeAt':
			putHandle(String(params.location), 16, w); view.setUint32(32, params.includeGlobalThis ? 1 : 0, true);
			view.setUint32(36, 0, true); view.setUint32(40, 0, true); view.setUint32(44, 0, true); view.setUint32(48, 0, true); break;
		case 'getExpandedParameters':
			view.setBigUint64(16, BigInt(params.signature ?? 0), true); view.setUint32(24, params.skipUnionExpanding ? 1 : 0, true); break;
		case 'getRenameInfo': case 'getEditsForRename': {
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true);
			const [b28, b29, b30] = renameBytes(method, params);
			view.setUint8(28, b28); view.setUint8(29, b29); view.setUint8(30, b30);
			break;
		}
		case 'signatureHelp': {
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true);
			if (params.triggerReason != null) putStr(String(params.triggerReason), 28, w);
			else { view.setUint32(28, 0, true); view.setUint32(32, 0, true); }
			break;
		}
		case 'getCompletionsAtPosition': {
			putStr(String(params.file ?? ''), 16, w); view.setUint32(24, params.position >>> 0, true);
			if (params.triggerCharacter != null) putStr(String(params.triggerCharacter), 28, w);
			else { view.setUint32(28, 0, true); view.setUint32(32, 0, true); }
			view.setUint32(36, params.includeSymbol ? 1 : 0, true);
			const tri = (b) => b === true ? 1 : b === false ? 2 : 0;
			const prefs = params.preferences ?? {};
			view.setUint8(40, tri(prefs.includeCompletionsForModuleExports));
			view.setUint8(41, tri(prefs.includeCompletionsForImportStatements));
			view.setUint8(42, tri(prefs.includeAutomaticOptionalChainCompletions));
			view.setUint8(43, tri(prefs.includeCompletionsWithClassMemberSnippets));
			view.setUint8(44, tri(prefs.includeCompletionsWithObjectLiteralMethodSnippets));
			break;
		}
		case 'getSymbolsDeclarations': case 'getParentsOfSymbols': {
			const ids = params.symbols ?? [];
			view.setUint32(20, ids.length, true);
			if (ids.length) {
				view.setUint32(16, w.off, true);
				for (const id of ids) { view.setBigUint64(w.off, BigInt(id), true); w.off += 8; }
			} else view.setUint32(16, 0, true);
			break;
		}
		case 'getReturnTypeOfSignature': case 'getParametersOfSignature':
		case 'getRestTypeOfSignature': case 'getTypeArgumentsForResolvedSignature':
		case 'getTargetOfSignature': case 'getThisParameterOfSignature':
		case 'getTypeParametersOfSignature': case 'hasEffectiveRestParameter':
			view.setBigUint64(16, BigInt(params.signature ?? params.objectId ?? 0), true); break;
		default: // type / objectId shapes
			view.setUint32(16, typeId >>> 0, true); break;
	}
	const escape = addon.callArena(h, method);
	if (typeof escape === 'string') return JSON.parse(escape);
	// response: header at ARENA_RESP_OFFSET
	const kind = view.getUint8(ARENA_RESP_OFFSET);
	const nsOff = view.getUint32(ARENA_RESP_OFFSET + 8, true);
	const nsLen = view.getUint32(ARENA_RESP_OFFSET + 12, true);
	if (nsLen > 0) {
		const count = view.getUint32(nsOff, true);
		let p = nsOff + 4;
		for (let i = 0; i < count; i++) {
			const n = view.getUint32(p, true);
			strTab.push(dec.decode(arenaBuf.subarray(p + 4, p + 4 + n)));
			p += 4 + n;
		}
	}
	if (kind === 0) return null;
	if (kind === 4) {
		const o = view.getUint32(ARENA_RESP_OFFSET + 16, true), n = view.getUint32(ARENA_RESP_OFFSET + 20, true);
		throw new Error(dec.decode(arenaBuf.subarray(o, o + n)));
	}
	const str = id => (id === 0 ? undefined : strTab[id]);
	const u32z = off => { const x = view.getUint32(off, true); return x === 0 ? undefined : x; };
	const u64z = off => { const x = view.getBigUint64(off, true); return x === 0n ? undefined : Number(x); };
	const u32Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = view.getUint32(p, true); p += 4; } return out; };
	const u64Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = Number(view.getBigUint64(p, true)); p += 8; } return out; };
	const strArr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = str(view.getUint32(p, true)); p += 4; } return out; };
	const u8Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; const p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) out[i] = view.getUint8(p + i); return out; };
	const readHandle = off => `${view.getUint32(off, true)}.${view.getUint32(off + 4, true)}.${str(view.getUint32(off + 8, true)) ?? ''}`;
	// The '0.0.' zero record is a sparse-array hole (labeledElementDeclarations
	// is full-length with holes at unlabeled positions), kept positional.
	const nodeHandleArr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { const h = readHandle(p); out[i] = h === '0.0.' ? null : h; p += 16; } return out; };
	const readType = off => {
		// go-json-experiment omitempty keeps scalar zero values (only omitzero
		// drops them): objectFlags/isThisType cross unconditionally.
		const d = { id: view.getUint32(off, true), flags: view.getUint32(off + 4, true), objectFlags: view.getUint32(off + 8, true) };
		const set = (k, val) => { if (val !== undefined) d[k] = val; };
		set('target', u32z(off + 12)); set('freshType', u32z(off + 16));
		set('regularType', u32z(off + 20)); set('objectType', u32z(off + 24)); set('indexType', u32z(off + 28));
		set('checkType', u32z(off + 32)); set('extendsType', u32z(off + 36)); set('baseType', u32z(off + 40));
		set('substConstraint', u32z(off + 44)); set('symbol', u64z(off + 48)); set('aliasSymbol', u64z(off + 56));
		const f2 = view.getUint8(off + 68);
		d.isThisType = (f2 & 1) !== 0;
		if (f2 & 2) d.fixedLength = view.getInt32(off + 64, true);
		if (f2 & 4) d.readonly = (f2 & 8) !== 0;
		const vk = view.getUint8(off + 69);
		if (vk === 1) d.value = str(view.getUint32(off + 72, true));
		else if (vk === 2) d.value = view.getFloat64(off + 80, true);
		else if (vk === 3) d.value = view.getUint8(off + 80) !== 0;
		else d.value = null;
		set('intrinsicName', str(view.getUint32(off + 88, true)));
		set('typeParameters', u32Arr(off + 92)); set('outerTypeParameters', u32Arr(off + 100));
		set('localTypeParameters', u32Arr(off + 108)); set('aliasTypeArguments', u32Arr(off + 116));
		set('texts', strArr(off + 124)); set('elementFlags', u8Arr(off + 132));
		set('labeledElementDeclarations', nodeHandleArr(off + 140));
		set('thisType', u32z(off + 148));
		set('escapedName', str(view.getUint32(off + 152, true)));
		return d;
	};
	const readSymbol = off => {
		const id = Number(view.getBigUint64(off, true));
		if (id === 0) return null; // zero slot in a symbols run = null element
		const d = { id, project: str(view.getUint32(off + 8, true)), name: str(view.getUint32(off + 12, true)) ?? '', flags: view.getUint32(off + 16, true), checkFlags: view.getUint32(off + 20, true) };
		const dc = view.getUint32(off + 28, true);
		if (dc > 0) { let p = view.getUint32(off + 24, true); d.declarations = new Array(dc); for (let i = 0; i < dc; i++) { d.declarations[i] = readHandle(p); p += 16; } }
		const vd = readHandle(off + 32);
		if (vd !== '0.0.') d.valueDeclaration = vd;
		const par = u64z(off + 48); if (par !== undefined) d.parent = par;
		const exp = u64z(off + 56); if (exp !== undefined) d.exportSymbol = exp;
		return d;
	};
	const readSignature = off => {
		const d = { id: Number(view.getBigUint64(off, true)), flags: view.getUint32(off + 8, true) };
		const dl = readHandle(off + 12); if (dl !== '0.0.') d.declaration = dl;
		const tp = u32Arr(off + 28); if (tp !== undefined) d.typeParameters = tp;
		const ps = u64Arr(off + 36); if (ps !== undefined) d.parameters = ps;
		const th = u64z(off + 44); if (th !== undefined) d.thisParameter = th;
		const tg = u64z(off + 52); if (tg !== undefined) d.target = tg;
		return d;
	};
	// ── LS nav payload readers (issue #12 batch 1; strides mirror arena.go) ──
	const strz = id => str(id) ?? '';
	const readParts = off => {
		const c = view.getUint32(off + 4, true); if (!c) return undefined;
		let p = view.getUint32(off, true);
		const out = new Array(c);
		for (let i = 0; i < c; i++) { out[i] = { text: strz(view.getUint32(p, true)), kind: strz(view.getUint32(p + 4, true)) }; p += 8; }
		return out;
	};
	const readQuickinfo = off => {
		const d = {
			kind: strz(view.getUint32(off, true)),
			kindModifiers: strz(view.getUint32(off + 4, true)),
			start: view.getUint32(off + 8, true),
			length: view.getUint32(off + 12, true),
			displayString: strz(view.getUint32(off + 16, true)),
		};
		const doc = readParts(off + 20); if (doc) d.documentation = doc;
		const tc = view.getUint32(off + 32, true);
		if (tc) {
			let p = view.getUint32(off + 28, true);
			d.tags = new Array(tc);
			for (let i = 0; i < tc; i++) {
				const tag = { name: strz(view.getUint32(p, true)) };
				const text = readParts(p + 4);
				if (text) tag.text = text;
				d.tags[i] = tag; p += 12;
			}
		}
		const flags = view.getUint8(off + 36);
		if (flags & 1) d.canIncreaseVerbosityLevel = (flags & 2) !== 0;
		const dp = readParts(off + 40); if (dp) d.displayParts = dp;
		return d;
	};
	const readDefinitionInfo = off => {
		const d = {
			fileName: strz(view.getUint32(off, true)),
			start: view.getUint32(off + 4, true),
			length: view.getUint32(off + 8, true),
		};
		const f1 = view.getUint8(off + 44), f2 = view.getUint8(off + 45);
		if (f1 & 1) { d.contextStart = view.getUint32(off + 12, true); d.contextLength = view.getUint32(off + 16, true); }
		d.kind = strz(view.getUint32(off + 20, true));
		d.name = strz(view.getUint32(off + 24, true));
		if (f1 & 2) d.containerKind = strz(view.getUint32(off + 28, true));
		if (f1 & 4) d.containerName = strz(view.getUint32(off + 32, true));
		const parts = readParts(off + 36); if (parts) d.displayParts = parts;
		if (f1 & 8) d.unverified = (f2 & 1) !== 0;
		if (f1 & 16) d.isLocal = (f2 & 2) !== 0;
		if (f1 & 32) d.isAmbient = (f2 & 4) !== 0;
		if (f1 & 64) d.failedAliasResolution = (f2 & 8) !== 0;
		return d;
	};
	const readReferenceEntry = off => {
		const flags = view.getUint8(off + 20);
		const d = {
			fileName: strz(view.getUint32(off, true)),
			start: view.getUint32(off + 4, true),
			length: view.getUint32(off + 8, true),
		};
		if (flags & 1) { d.contextStart = view.getUint32(off + 12, true); d.contextLength = view.getUint32(off + 16, true); }
		d.isWriteAccess = (flags & 2) !== 0;
		if (flags & 4) d.isDefinition = (flags & 8) !== 0;
		if (flags & 16) d.isInString = true;
		return d;
	};
	const readReferencedSymbol = off => {
		const definition = readDefinitionInfo(off);
		const count = view.getUint32(off + 52, true);
		let p = view.getUint32(off + 48, true);
		const references = new Array(count);
		for (let i = 0; i < count; i++) { references[i] = readReferenceEntry(p); p += 24; }
		return { definition, references };
	};
	const readDabs = off => {
		const count = view.getUint32(off + 12, true);
		let p = view.getUint32(off + 8, true);
		const definitions = new Array(count);
		for (let i = 0; i < count; i++) { definitions[i] = readDefinitionInfo(p); p += 48; }
		return { definitions, start: view.getUint32(off, true), length: view.getUint32(off + 4, true) };
	};
	const readJsDocTag = off => {
		const d = { name: strz(view.getUint32(off, true)) };
		const text = str(view.getUint32(off + 4, true));
		if (text !== undefined) d.text = text;
		return d;
	};
	const readLightSymbol = off => {
		const id = Number(view.getBigUint64(off, true));
		if (id === 0) return null;
		const d = { id };
		const project = str(view.getUint32(off + 8, true));
		if (project !== undefined) d.project = project;
		d.name = strz(view.getUint32(off + 12, true));
		d.flags = view.getUint32(off + 16, true);
		d.checkFlags = view.getUint32(off + 20, true);
		const parent = Number(view.getBigUint64(off + 24, true));
		if (parent !== 0) d.parent = parent;
		return d;
	};
	const readAmbientModules = off => {
		const count = view.getUint32(off + 4, true);
		let p = view.getUint32(off, true);
		const modules = new Array(count);
		for (let i = 0; i < count; i++) {
			modules[i] = { moduleName: strz(view.getUint32(p, true)), moduleSymbol: readLightSymbol(p + 8) };
			p += 40;
		}
		return { modules };
	};
	const readExpandedParams = off => {
		const count = view.getUint32(off + 4, true);
		let p = view.getUint32(off, true);
		const out = new Array(count);
		for (let i = 0; i < count; i++) {
			const n = view.getUint32(p + 8 * i + 4, true);
			let q = view.getUint32(p + 8 * i, true);
			const inner = new Array(n);
			for (let j = 0; j < n; j++) { inner[j] = Number(view.getBigUint64(q, true)); q += 8; }
			out[i] = inner;
		}
		return out;
	};
	const readCompletionEntry = off => {
		const d = { name: strz(view.getUint32(off, true)) };
		const kind = view.getUint32(off + 60, true);
		if (kind !== 0) d.kind = kind;
		const elementKind = str(view.getUint32(off + 4, true));
		if (elementKind !== undefined) d.elementKind = elementKind;
		const kindModifiers = str(view.getUint32(off + 8, true));
		if (kindModifiers !== undefined) d.kindModifiers = kindModifiers;
		const sortText = str(view.getUint32(off + 12, true));
		if (sortText !== undefined) d.sortText = sortText;
		const insertText = str(view.getUint32(off + 16, true));
		if (insertText !== undefined) d.insertText = insertText;
		const filterText = str(view.getUint32(off + 20, true));
		if (filterText !== undefined) d.filterText = filterText;
		const detail = str(view.getUint32(off + 28, true));
		if (detail !== undefined) d.detail = detail;
		const flags = view.getUint8(off + 64);
		if (flags & 8) {
			const ld = {};
			const ldd = str(view.getUint32(off + 32, true));
			if (ldd !== undefined) ld.detail = ldd;
			const lds = str(view.getUint32(off + 36, true));
			if (lds !== undefined) ld.description = lds;
			d.labelDetails = ld;
		}
		if (flags & 16) d.symbol = readSymbol(view.getUint32(off + 56, true));
		const source = str(view.getUint32(off + 24, true));
		if (source !== undefined) d.source = source;
		if (flags & 1) d.hasAction = true;
		if (flags & 2) d.isRecommended = true;
		if (flags & 4) {
			d.replacementStart = view.getUint32(off + 40, true);
			d.replacementLength = view.getUint32(off + 44, true);
		}
		const cc = strArr(off + 48);
		if (cc) d.commitCharacters = cc;
		if (flags & 32) {
			const data = {};
			const exportName = str(view.getUint32(off + 72, true));
			if (exportName !== undefined) data.exportName = exportName;
			const fileName = str(view.getUint32(off + 76, true));
			if (fileName !== undefined) data.fileName = fileName;
			const moduleSpecifier = str(view.getUint32(off + 68, true));
			if (moduleSpecifier !== undefined) data.moduleSpecifier = moduleSpecifier;
			d.data = data;
		}
		if (flags & 64) d.isPackageJsonImport = true;
		const sourceDisplay = readParts(off + 80);
		if (sourceDisplay) d.sourceDisplay = sourceDisplay;
		return d;
	};
	const readCompletions = off => {
		const f1 = view.getUint8(off);
		const f2 = view.getUint8(off + 1);
		const d = {};
		if (f1 & 8) d.isIncomplete = true;
		const count = view.getUint32(off + 28, true);
		let p = view.getUint32(off + 24, true);
		const entries = new Array(count);
		for (let i = 0; i < count; i++) { entries[i] = readCompletionEntry(p); p += 88; }
		d.entries = entries;
		if (f2 & 1) d.flags = view.getUint32(off + 4, true);
		d.isGlobalCompletion = (f1 & 1) !== 0;
		d.isMemberCompletion = (f1 & 2) !== 0;
		d.isNewIdentifierLocation = (f1 & 4) !== 0;
		if (f2 & 2) {
			d.optionalSpanStart = view.getUint32(off + 8, true);
			d.optionalSpanLength = view.getUint32(off + 12, true);
		}
		const dcc = strArr(off + 16);
		if (dcc) d.defaultCommitCharacters = dcc;
		return d;
	};
	const readSignatureHelpItem = off => {
		const d = {
			isVariadic: (view.getUint8(off + 48) & 1) !== 0,
			prefixDisplayParts: readParts(off) ?? [],
			suffixDisplayParts: readParts(off + 8) ?? [],
			separatorDisplayParts: readParts(off + 16) ?? [],
		};
		const pc = view.getUint32(off + 28, true);
		let p = view.getUint32(off + 24, true);
		const params = new Array(pc);
		for (let i = 0; i < pc; i++) {
			const flags = view.getUint8(p + 20);
			params[i] = {
				name: strz(view.getUint32(p, true)),
				documentation: readParts(p + 4) ?? [],
				displayParts: readParts(p + 12) ?? [],
				isOptional: (flags & 1) !== 0,
				isRest: (flags & 2) !== 0,
			};
			p += 24;
		}
		d.parameters = params;
		d.documentation = readParts(off + 32) ?? [];
		const tc = view.getUint32(off + 44, true);
		if (tc) {
			let t = view.getUint32(off + 40, true);
			d.tags = new Array(tc);
			for (let i = 0; i < tc; i++) {
				const tag = { name: strz(view.getUint32(t, true)) };
				const text = readParts(t + 4);
				if (text) tag.text = text;
				d.tags[i] = tag;
				t += 12;
			}
		}
		return d;
	};
	const readSignatureHelpItems = off => {
		const count = view.getUint32(off + 24, true);
		let p = view.getUint32(off + 20, true);
		const items = new Array(count);
		for (let i = 0; i < count; i++) { items[i] = readSignatureHelpItem(p); p += 52; }
		return {
			items,
			applicableSpan: { start: view.getUint32(off, true), length: view.getUint32(off + 4, true) },
			selectedItemIndex: view.getUint32(off + 8, true),
			argumentIndex: view.getUint32(off + 12, true),
			argumentCount: view.getUint32(off + 16, true),
		};
	};
	const readRenameInfo = off => {
		const d = { canRename: (view.getUint8(off) & 1) !== 0 };
		const fileToRename = str(view.getUint32(off + 4, true));
		if (fileToRename !== undefined) d.fileToRename = fileToRename;
		const displayName = str(view.getUint32(off + 8, true));
		if (displayName !== undefined) d.displayName = displayName;
		const fullDisplayName = str(view.getUint32(off + 12, true));
		if (fullDisplayName !== undefined) d.fullDisplayName = fullDisplayName;
		const kind = str(view.getUint32(off + 16, true));
		if (kind !== undefined) d.kind = kind;
		if (view.getUint8(off) & 2) d.kindModifiers = str(view.getUint32(off + 20, true)) ?? '';
		if (d.canRename) d.triggerSpan = { start: view.getUint32(off + 24, true), length: view.getUint32(off + 28, true) };
		const localizedErrorMessage = str(view.getUint32(off + 32, true));
		if (localizedErrorMessage !== undefined) d.localizedErrorMessage = localizedErrorMessage;
		return d;
	};
	const readRenameLocation = off => {
		const d = {
			fileName: strz(view.getUint32(off, true)),
			start: view.getUint32(off + 4, true),
			length: view.getUint32(off + 8, true),
		};
		const flags = view.getUint8(off + 28);
		if (flags & 1) {
			d.contextStart = view.getUint32(off + 12, true);
			d.contextLength = view.getUint32(off + 16, true);
		}
		const prefixText = str(view.getUint32(off + 20, true));
		if (prefixText !== undefined) d.prefixText = prefixText;
		const suffixText = str(view.getUint32(off + 24, true));
		if (suffixText !== undefined) d.suffixText = suffixText;
		return d;
	};
	const RESULT = {
		getTypeAtLocation: 'type', getContextualType: 'type', getApparentType: 'type',
		getTypeOfSymbolAtLocation: 'type', getTypeOfSymbol: 'type', getDeclaredTypeOfSymbol: 'type',
		getBaseTypeOfLiteralType: 'type', getNonNullableType: 'type', getTargetOfType: 'type',
		getFreshTypeOfType: 'type', getRegularTypeOfType: 'type', getObjectTypeOfType: 'type',
		getCheckTypeOfType: 'type', getExtendsTypeOfType: 'type', getBaseTypeOfType: 'type',
		getReturnTypeOfSignature: 'type',
		getTypeArguments: 'types', getBaseTypes: 'types', getTypesOfType: 'types',
		getTypeParametersOfType: 'types', getOuterTypeParametersOfType: 'types',
		getLocalTypeParametersOfType: 'types', getAliasTypeArgumentsOfType: 'types',
		getSymbolAtPosition: 'symbol', getSymbolAtLocation: 'symbol', getSymbolOfType: 'symbol',
		getPropertiesOfType: 'symbols', getParametersOfSignature: 'symbols',
		getResolvedSignature: 'signature', getSignaturesOfType: 'signatures',
		typeToString: 'string', isArrayType: 'bool',
		quickinfo: 'quickinfo', references: 'referencedSymbols', definitionAndBoundSpan: 'definitionAndBoundSpan',
		getAliasedSymbol: 'symbol', getImmediateAliasedSymbol: 'symbol', getExportSymbolOfSymbol: 'symbol',
		getParentOfSymbol: 'symbol', resolveExternalModuleSymbol: 'symbol', getAliasSymbolOfType: 'symbol',
		getPropertyOfType: 'symbol', getPropertySymbolOfDestructuringAssignment: 'symbol',
		getExportSpecifierLocalTargetSymbol: 'symbol', resolveExternalModuleName: 'symbol',
		getTargetOfSignature: 'symbol', getThisParameterOfSignature: 'symbol', getModuleSymbolForSourceFile: 'symbol',
		getRootSymbols: 'symbols', getExportsOfModule: 'symbols', getExportsAndPropertiesOfModule: 'symbols',
		getExportsOfSymbol: 'symbols', getMembersOfSymbol: 'symbols', getExactOptionalProperties: 'symbols',
		getAugmentedPropertiesOfType: 'symbols', getJsxIntrinsicTagNamesAt: 'symbols', getAccessibleSymbolChain: 'symbols',
		getDocumentationComment: 'string', getJsxFragmentFactory: 'string',
		symbolIsValue: 'bool', isEmptyAnonymousObjectType: 'bool', isLibType: 'bool', isNullableType: 'bool',
		isTupleType: 'bool', typeHasCallOrConstructSignatures: 'bool', containsArgumentsReference: 'bool',
		isDeclarationVisible: 'bool', isImplementationOfOverload: 'bool', isOptionalParameter: 'bool',
		requiresAddingImplicitUndefined: 'bool', hasEffectiveRestParameter: 'bool',
		getLocalTypeParametersOfClassOrInterfaceOrTypeAlias: 'types', collectVisitedTypeParameters: 'types',
		getTypeArgumentsForResolvedSignature: 'types', getTypeParametersOfSignature: 'types',
		createArrayType: 'type', createPromiseType: 'type', getAwaitedType: 'type', getBaseConstraintOfType: 'type',
		getConstraintOfTypeParameter: 'type', getDefaultFromTypeParameter: 'type', getElementTypeOfArrayType: 'type',
		getIndexedAccessIndexType: 'type', getPromisedTypeOfPromise: 'type', getWidenedLiteralType: 'type',
		getConstraintOfType: 'type', getFalseTypeOfConditionalType: 'type', getTrueTypeOfConditionalType: 'type',
		getContextualTypeForJsxAttribute: 'type', getTypeArgumentConstraint: 'type', getTypeOfAssignmentPattern: 'type',
		getTypeOfPropertyOfType: 'type', getTypeOfPropertyOfContextualType: 'type', getRestTypeOfSignature: 'type',
		getStringLiteralType: 'type', getBigIntLiteralType: 'type', getNumberLiteralType: 'type',
		getTypeAtPosition: 'type', tryGetThisTypeAt: 'type',
		getAnyType: 'type', getBigIntType: 'type', getBooleanType: 'type', getESSymbolType: 'type',
		getErrorType: 'type', getNeverType: 'type', getNonPrimitiveType: 'type', getNullType: 'type',
		getNumberType: 'type', getOptionalType: 'type', getPromiseLikeType: 'type', getPromiseType: 'type',
		getStringType: 'type', getUndefinedType: 'type', getUnknownType: 'type', getVoidType: 'type',
		getAnyAsyncIterableType: 'type',
		getJsDocTags: 'jsdocTags', getExpandedParameters: 'expandedParams',
		getSignatureFromDeclaration: 'signature', getCandidateSignaturesForStringLiteralCompletions: 'signatures',
		getSymbolsDeclarations: 'symbols', getParentsOfSymbols: 'symbols', getAmbientModules: 'ambientModules',
		getCompletionsAtPosition: 'completionInfo', signatureHelp: 'signatureHelpItems',
		getRenameInfo: 'renameInfo', getEditsForRename: 'renameLocations',
	};
	{
		const resKind = RESULT[method];
		if (resKind === 'string') {
			const o = view.getUint32(ARENA_RESP_OFFSET + 16, true), n = view.getUint32(ARENA_RESP_OFFSET + 20, true);
			return dec.decode(arenaBuf.subarray(o, o + n));
		}
		if (resKind === 'bool') return view.getUint8(ARENA_RESP_OFFSET + 16) !== 0;
		if (resKind === 'expandedParams') return readExpandedParams(ARENA_RESP_OFFSET + 16);
	}
	const resKind = RESULT[method];
	const count = view.getUint32(ARENA_RESP_OFFSET + 16, true);
	let off = ARENA_RESP_OFFSET + 20;
	const recKind = resKind === 'type' || resKind === 'types' ? 'type' : resKind === 'symbol' || resKind === 'symbols' ? 'symbol' : resKind === 'quickinfo' || resKind === 'referencedSymbols' || resKind === 'definitionAndBoundSpan' || resKind === 'jsdocTags' || resKind === 'expandedParams' || resKind === 'ambientModules' || resKind === 'completionInfo' || resKind === 'signatureHelpItems' || resKind === 'renameInfo' || resKind === 'renameLocations' ? resKind : 'signature';
	const read = recKind === 'type' ? readType : recKind === 'symbol' ? readSymbol : recKind === 'quickinfo' ? readQuickinfo : recKind === 'referencedSymbols' ? readReferencedSymbol : recKind === 'definitionAndBoundSpan' ? readDabs : recKind === 'jsdocTags' ? readJsDocTag : recKind === 'expandedParams' ? readExpandedParams : recKind === 'ambientModules' ? readAmbientModules : recKind === 'completionInfo' ? readCompletions : recKind === 'signatureHelpItems' ? readSignatureHelpItems : recKind === 'renameInfo' ? readRenameInfo : recKind === 'renameLocations' ? readRenameLocation : readSignature;
	const stride = recKind === 'type' ? 156 : recKind === 'symbol' ? 72 : recKind === 'quickinfo' ? 48 : recKind === 'referencedSymbols' ? 56 : recKind === 'definitionAndBoundSpan' ? 16 : recKind === 'jsdocTags' ? 8 : recKind === 'expandedParams' ? 8 : recKind === 'ambientModules' ? 8 : recKind === 'completionInfo' ? 32 : recKind === 'signatureHelpItems' ? 28 : recKind === 'renameInfo' ? 36 : recKind === 'renameLocations' ? 32 : 64;
	const out = [];
	for (let i = 0; i < count; i++) { out.push(read(off)); off += stride; }
	const singular = resKind === 'type' || resKind === 'symbol' || resKind === 'signature' || resKind === 'quickinfo' || resKind === 'definitionAndBoundSpan' || resKind === 'expandedParams' || resKind === 'ambientModules' || resKind === 'completionInfo' || resKind === 'signatureHelpItems' || resKind === 'renameInfo';
	return singular ? out[0] : out;
}

// ── Compare ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const norm = v => JSON.stringify(v, (k, x) => {
	if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)));
	return x;
});
function query(method, params, note = '') {
	let j, a, jErr, aErr;
	try { j = jsonCall(method, params); } catch (e) { jErr = e.message; }
	try { a = arenaCall(method, params); } catch (e) { aErr = e.message; }
	const label = `${method}${note ? ' ' + note : ''}`;
	if (jErr || aErr) {
		if (jErr === aErr) { pass++; console.log(`ok ${label} (both error: ${jErr.slice(0, 80)})`); return undefined; }
		fail++; console.log(`FAIL ${label}: jsonErr=${jErr} arenaErr=${aErr}`); return undefined;
	}
	// Go map iteration order is nondeterministic for export tables: compare the
	// symbol SET (id-sorted) for these two methods, not the array order.
	if ((method === 'getExportsAndPropertiesOfModule' || method === 'getExportsOfModule') && Array.isArray(j) && Array.isArray(a)) {
		j = [...j].sort((x, y) => x.id - y.id);
		a = [...a].sort((x, y) => x.id - y.id);
	}
	if (norm(j) !== norm(a)) {
		fail++;
		console.log(`FAIL ${label}:`);
		console.log(`  json : ${norm(j)?.slice(0, 500)}`);
		console.log(`  arena: ${norm(a)?.slice(0, 500)}`);
		return a ?? j;
	}
	pass++;
	console.log(`ok ${label}`);
	return j;
}

// ── Battery ──────────────────────────────────────────────────────────────
const pos = needle => { const i = aSrc.indexOf(needle); if (i < 0) throw new Error('fixture missing ' + needle); return i; };
const P = extra => ({ snapshot, project, ...extra });

const symAdd = query('getSymbolAtPosition', P({ file: aTs, position: pos('add(a: number') }), '(fn decl)');
const symModel = query('getSymbolAtPosition', P({ file: aTs, position: pos('model: Model') }), '(model)');
const symTup = query('getSymbolAtPosition', P({ file: aTs, position: pos('tup: RO') }), '(tuple)');
const symMTup = query('getSymbolAtPosition', P({ file: aTs, position: pos('mtup: MutTup') }), '(mutable tuple)');
const symLTup = query('getSymbolAtPosition', P({ file: aTs, position: pos('ltup: LabTup') }), '(labeled tuple)');
const symLit = query('getSymbolAtPosition', P({ file: aTs, position: pos('lit: Lit') }), '(union literal)');
const symMaybe = query('getSymbolAtPosition', P({ file: aTs, position: pos('maybe: string') }), '(nullable)');
const symD = query('getSymbolAtPosition', P({ file: aTs, position: pos('d = new Derived') }), '(class)');
const symNum = query('getSymbolAtPosition', P({ file: aTs, position: pos('numLit') }), '(num literal)');
const symStr = query('getSymbolAtPosition', P({ file: aTs, position: pos('strLit') }), '(str literal)');
const symGen = query('getSymbolAtPosition', P({ file: aTs, position: pos('generic<T') }), '(generic fn)');
const symEntity = query('getSymbolAtPosition', P({ file: aTs, position: pos('Entity<K') }), '(interface)');
const symCond = query('getSymbolAtPosition', P({ file: aTs, position: pos('Cond<T>') }), '(conditional alias)');
const symMm = query('getSymbolAtPosition', P({ file: aTs, position: pos('mm: M<Model>') }), '(alias args)');

// LS nav payloads (issue #12 batch 1): quickinfo / references / definitionAndBoundSpan
query('quickinfo', P({ file: aTs, position: pos('add(a: number') }), '(fn decl)');
query('quickinfo', P({ file: aTs, position: pos('model: Model') }), '(const decl)');
query('quickinfo', P({ file: aTs, position: pos('model)') }), '(usage)');
query('quickinfo', P({ file: aTs, position: pos('lit: Lit') }), '(union literal)');
query('quickinfo', P({ file: aTs, position: pos('export interface Entity') }), '(keyword: null-ish)');
query('quickinfo', P({ file: aTs, position: pos('Derived extends') }), '(class)');
query('references', P({ file: aTs, position: pos('add(a: number') }), '(fn: decl+call)');
query('references', P({ file: aTs, position: pos('model: Model') }), '(const: several uses)');
query('references', P({ file: aTs, position: pos('Model extends') }), '(interface decl)');
query('references', P({ file: aTs, position: pos('model)') }), '(usage)');
query('definitionAndBoundSpan', P({ file: aTs, position: pos('model)') }), '(usage→decl)');
query('definitionAndBoundSpan', P({ file: aTs, position: pos('add(1') }), '(call→fn)');
query('definitionAndBoundSpan', P({ file: aTs, position: pos('Model extends') }), '(on decl)');
query('definitionAndBoundSpan', P({ file: aTs, position: pos('Derived extends') }), '(class decl)');

if (!symAdd || !symModel) { console.error('seed queries failed'); process.exit(1); }

const addType = query('getTypeOfSymbol', P({ symbol: symAdd.id }));
query('getDeclaredTypeOfSymbol', P({ symbol: symAdd.id }));
query('getTypeOfSymbolAtLocation', P({ symbol: symAdd.id, location: symAdd.valueDeclaration }));
const modelType = query('getTypeOfSymbol', P({ symbol: symModel.id }));
const tupType = query('getTypeOfSymbol', P({ symbol: symTup.id }));
const mtupType = query('getTypeOfSymbol', P({ symbol: symMTup.id }));
const ltupType = query('getTypeOfSymbol', P({ symbol: symLTup.id }));
const litType = query('getTypeOfSymbol', P({ symbol: symLit.id }));
const maybeType = query('getTypeOfSymbol', P({ symbol: symMaybe.id }));
const dType = query('getTypeOfSymbol', P({ symbol: symD.id }));
const numType = query('getTypeOfSymbol', P({ symbol: symNum.id }));
const strType = query('getTypeOfSymbol', P({ symbol: symStr.id }));
const genType = query('getTypeOfSymbol', P({ symbol: symGen.id }));

// node-handle methods (declaration handles are valid node handles)
query('getTypeAtLocation', P({ location: symAdd.valueDeclaration }));
query('getSymbolAtLocation', P({ location: symModel.valueDeclaration }));
query('getContextualType', P({ location: symAdd.valueDeclaration, contextFlags: 0 }));
// getResolvedSignature needs a call-expression handle (not obtainable from
// symbol declarations); its signature record decoder is covered via
// getSignaturesOfType above. getContextualTypeForArgumentAtIndex likewise
// needs a call-expression handle; its "type" result decoder and node-handle
// request shape are covered via getContextualType / getTypeAtLocation.

if (addType) {
	const sigs = query('getSignaturesOfType', P({ type: addType.id, kind: 0 }));
	if (sigs?.length) {
		const sig = sigs[0];
		query('getReturnTypeOfSignature', P({ signature: sig.id }));
		query('getParametersOfSignature', P({ objectId: sig.id }));
	}
}
// Relation methods are only callable on applicable types (the Go handlers
// deref As{Interface,Conditional,…}Type() unconditionally — same on both
// transports; stock callers guard by flags).
const entityType = symEntity && query('getDeclaredTypeOfSymbol', P({ symbol: symEntity.id }), '(interface declared)');
if (entityType) {
	query('getTypeParametersOfType', P({ objectId: entityType.id }));
	query('getOuterTypeParametersOfType', P({ objectId: entityType.id }));
	query('getLocalTypeParametersOfType', P({ objectId: entityType.id }));
}
const condType = symCond && query('getDeclaredTypeOfSymbol', P({ symbol: symCond.id }), '(conditional declared)');
if (condType) {
	query('getCheckTypeOfType', P({ objectId: condType.id }));
	query('getExtendsTypeOfType', P({ objectId: condType.id }));
}
const mmType = symMm && query('getTypeOfSymbol', P({ symbol: symMm.id }));
if (mmType) query('getAliasTypeArgumentsOfType', P({ objectId: mmType.id }));
if (modelType) {
	query('getPropertiesOfType', P({ type: modelType.id }));
	query('getSymbolOfType', P({ objectId: modelType.id }));
	query('getApparentType', P({ type: modelType.id }));
	query('typeToString', P({ type: modelType.id }));
	query('typeToString', P({ type: modelType.id, flags: 1, location: symModel.valueDeclaration }), '(flags+location)');
	query('isArrayType', P({ type: modelType.id }), '(false)');
	query('getTypeArguments', P({ type: modelType.id }));
}
if (tupType) {
	query('isArrayType', P({ type: tupType.id }), '(true, readonly tuple)');
	query('getTypeArguments', P({ type: tupType.id }));
	query('getTargetOfType', P({ objectId: tupType.id }));
	query('getBaseTypes', P({ type: tupType.id }));
}
if (mtupType) query('isArrayType', P({ type: mtupType.id }), '(mutable tuple: readonly=false field)');
if (ltupType) query('getTargetOfType', P({ objectId: ltupType.id }), '(labeled tuple target: labeledElementDeclarations with a hole)');
if (litType) {
	query('getTypesOfType', P({ objectId: litType.id }), '(union constituents: value kinds 1/2/3)');
	query('getBaseTypeOfLiteralType', P({ type: litType.id }));
	// getFreshTypeOfType/getRegularTypeOfType panic on unions (AsLiteralType)
	// — covered on the literal types below.
}
if (numType) {
	query('getBaseTypeOfLiteralType', P({ type: numType.id }), '(42)');
	query('getFreshTypeOfType', P({ objectId: numType.id }));
	query('getRegularTypeOfType', P({ objectId: numType.id }));
}
if (strType) query('getBaseTypeOfLiteralType', P({ type: strType.id }), '("hello")');
if (maybeType) query('getNonNullableType', P({ type: maybeType.id }));
if (dType) {
	query('getBaseTypes', P({ type: dType.id }));
	query('getPropertiesOfType', P({ type: dType.id }), '(inherited members)');
	query('getApparentType', P({ type: dType.id }));
}
if (genType) {
	const sigs = query('getSignaturesOfType', P({ type: genType.id, kind: 0 }), '(generic)');
	if (sigs?.length) query('getParametersOfSignature', P({ objectId: sigs[0].id }), '(generic sig)');
}

// safe on any type (nil-checked handlers)
if (modelType) {
	query('getAliasTypeArgumentsOfType', P({ objectId: modelType.id }), '(no alias)');
	query('getOuterTypeParametersOfType', P({ objectId: modelType.id }), '(interface)');
	query('getLocalTypeParametersOfType', P({ objectId: modelType.id }), '(interface)');
}

// ── issue #12 candidate 2 battery: record-shaped query classes ────────────
const symNp = query('getSymbolAtPosition', P({ file: aTs, position: pos('NestedPick = Model') }), '(indexed-access alias)');
const symCallResult = query('getSymbolAtPosition', P({ file: aTs, position: pos('callResult = add') }));
const moduleSym = query('getModuleSymbolForSourceFile', P({ file: aTs }), '(module symbol)');

// symbol u64 @16 family
const symAlias = query('getSymbolAtPosition', P({ file: aTs, position: pos('modelAlias }') }), '(export alias)');
if (symAlias) {
	query('getAliasedSymbol', P({ symbol: symAlias.id }));
	query('getImmediateAliasedSymbol', P({ symbol: symAlias.id }));
	query('resolveExternalModuleSymbol', P({ symbol: symAlias.id }));
}
query('getRootSymbols', P({ symbol: symModel.id }));
query('getParentOfSymbol', P({ objectId: symModel.id }));
query('getExportSymbolOfSymbol', P({ objectId: symModel.id }), '(no export symbol)');
if (moduleSym) {
	query('getExportsOfModule', P({ symbol: moduleSym.id }));
	query('getExportsAndPropertiesOfModule', P({ symbol: moduleSym.id }));
}
query('getExportsOfSymbol', P({ objectId: symEntity.id }));
query('getMembersOfSymbol', P({ objectId: symEntity.id }));
query('getDocumentationComment', P({ symbol: symAdd.id }), '(jsdoc fn)');
query('symbolIsValue', P({ symbol: symModel.id }), '(value)');
query('symbolIsValue', P({ symbol: symEntity.id }), '(type)');
query('getLocalTypeParametersOfClassOrInterfaceOrTypeAlias', P({ symbol: symEntity.id }), '(K)');
query('getJsDocTags', P({ symbol: symAdd.id }), '(jsdoc tags)');
query('getJsDocTags', P({ symbol: symModel.id }), '(no jsdoc)');

// type u32 @16 family
query('collectVisitedTypeParameters', P({ type: genType.id }));
query('createArrayType', P({ type: modelType.id }));
query('createPromiseType', P({ type: modelType.id }));
query('getAugmentedPropertiesOfType', P({ type: dType.id }));
query('getAwaitedType', P({ type: addType.id }), '(non-promise)');
if (symCallResult) {
	const promiseType = query('getTypeOfSymbol', P({ symbol: symCallResult.id }));
	if (promiseType) {
		query('getAwaitedType', P({ type: promiseType.id }), '(promise)');
		query('getPromisedTypeOfPromise', P({ type: promiseType.id }));
	}
}
query('getBaseConstraintOfType', P({ type: litType.id }));
query('getConstraintOfTypeParameter', P({ type: entityType.id }));
query('getDefaultFromTypeParameter', P({ type: entityType.id }), '(no default)');
query('getElementTypeOfArrayType', P({ type: tupType.id }), '(tuple)');
query('getExactOptionalProperties', P({ type: modelType.id }));
const symGetKey = query('getSymbolAtPosition', P({ file: aTs, position: pos('getKey<T') }), '(generic fn for indexed access)');
if (symGetKey) {
	const gkType = query('getTypeOfSymbol', P({ symbol: symGetKey.id }));
	const gkSigs = gkType && query('getSignaturesOfType', P({ type: gkType.id, kind: 0 }));
	const gkRet = gkSigs?.length && query('getReturnTypeOfSignature', P({ signature: gkSigs[0].id }), '(T[K])');
	if (gkRet) query('getIndexedAccessIndexType', P({ objectId: gkRet.id }), '(K)');
}
query('getWidenedLiteralType', P({ type: litType.id }));
query('isEmptyAnonymousObjectType', P({ type: modelType.id }), '(false)');
query('isLibType', P({ type: modelType.id }), '(false)');
query('isNullableType', P({ type: maybeType.id }), '(true)');
query('isTupleType', P({ type: tupType.id }), '(true)');
query('typeHasCallOrConstructSignatures', P({ type: addType.id }), '(true)');
// getConstraintOfType takes a substitution type (not producible from this
// fixture's surface — same reachability convention as getResolvedSignature).
query('getFalseTypeOfConditionalType', P({ objectId: condType.id }));
query('getTrueTypeOfConditionalType', P({ objectId: condType.id }));
if (mmType) query('getAliasSymbolOfType', P({ objectId: mmType.id }));

// intrinsic type getters
for (const m of ['getAnyType', 'getBigIntType', 'getBooleanType', 'getESSymbolType', 'getErrorType', 'getNeverType', 'getNonPrimitiveType', 'getNullType', 'getNumberType', 'getOptionalType', 'getPromiseLikeType', 'getPromiseType', 'getStringType', 'getUndefinedType', 'getUnknownType', 'getVoidType', 'getAnyAsyncIterableType']) {
	query(m, P({}));
}

// node handle @16 family
query('containsArgumentsReference', P({ location: symAdd.valueDeclaration }), '(false)');
query('getContextualTypeForJsxAttribute', P({ location: symAdd.valueDeclaration }), '(not jsx)');
query('getTypeArgumentConstraint', P({ location: symAdd.valueDeclaration }), '(not a type ref)');
query('getTypeOfAssignmentPattern', P({ location: symAdd.valueDeclaration }), '(not a pattern)');
query('isDeclarationVisible', P({ location: symAdd.valueDeclaration }), '(visible)');
query('isImplementationOfOverload', P({ location: symAdd.valueDeclaration }), '(false)');
const symParamB = query('getSymbolAtPosition', P({ file: aTs, position: pos('b?: string') }), '(parameter)');
if (symParamB) {
	query('isOptionalParameter', P({ location: symParamB.valueDeclaration }), '(true)');
	query('requiresAddingImplicitUndefined', P({ location: symParamB.valueDeclaration }), '(b?)');
}
query('getJsxFragmentFactory', P({ location: symAdd.valueDeclaration }));
query('getJsxIntrinsicTagNamesAt', P({ location: symAdd.valueDeclaration }), '(no jsx)');
const symNested = query('getSymbolAtPosition', P({ file: aTs, position: pos('nested } = model') }), '(destructuring)');
if (symNested) query('getPropertySymbolOfDestructuringAssignment', P({ location: symNested.valueDeclaration }));
query('getSignatureFromDeclaration', P({ location: symAdd.valueDeclaration }), '(fn decl)');
if (symAlias) {
	query('getExportSpecifierLocalTargetSymbol', P({ location: symAlias.declarations?.[0] }), '(export specifier)');
}
query('resolveExternalModuleName', P({ location: symAdd.valueDeclaration }), '(not a module specifier)');

// signature u64 @16 family
if (addType) {
	const sigs = query('getSignaturesOfType', P({ type: addType.id, kind: 0 }));
	if (sigs?.length) {
		const sig = sigs[0];
		query('getRestTypeOfSignature', P({ signature: sig.id }), '(no rest)');
		query('getTypeArgumentsForResolvedSignature', P({ signature: sig.id }), '(no type args)');
		query('getTargetOfSignature', P({ objectId: sig.id }), '(no target)');
		query('getThisParameterOfSignature', P({ objectId: sig.id }), '(no this param)');
		query('getTypeParametersOfSignature', P({ objectId: sig.id }), '(none)');
		query('hasEffectiveRestParameter', P({ signature: sig.id }), '(false)');
		query('getExpandedParameters', P({ signature: sig.id }), '(a, b?)');
		query('getExpandedParameters', P({ signature: sig.id, skipUnionExpanding: true }), '(skip union)');
	}
}

// typeName family
query('getPropertyOfType', P({ type: modelType.id, name: 'value' }), '(hit)');
query('getPropertyOfType', P({ type: modelType.id, name: 'missing' }), '(miss)');
query('getTypeOfPropertyOfType', P({ type: modelType.id, name: 'value' }));
query('getTypeOfPropertyOfContextualType', P({ type: modelType.id, name: 'value' }));

// literal value family
query('getStringLiteralType', P({ value: 'hello' }));
query('getBigIntLiteralType', P({ value: '9007199254740993' }));
query('getNumberLiteralType', P({ value: 42 }));

// file @16 family
query('getTypeAtPosition', P({ file: aTs, position: pos('add(a: number') }));

// symbolChain / twoHandles / thisAt
query('getAccessibleSymbolChain', P({ symbol: symModel.id, enclosingDeclaration: symModel.valueDeclaration, meaning: 1 }));
// getCandidateSignaturesForStringLiteralCompletions needs call-expression and
// argument handles (not producible from the surface — reachability convention).
query('tryGetThisTypeAt', P({ location: symAdd.valueDeclaration, includeGlobalThis: true }));

// batch symbol-declarations (holes decode as null) + ambient modules
query('getSymbolsDeclarations', P({ symbols: [symAdd.id, symModel.id, 999999] }), '(2 valid + 1 hole)');
query('getParentsOfSymbols', P({ symbols: [symModel.id] }));
query('getAmbientModules', P({}), '(no ambient modules in fixture)');
query('getCompletionsAtPosition', P({ file: aTs, position: pos('callResult = add') }), '(mid-expression)');
query('getCompletionsAtPosition', P({ file: aTs, position: aSrc.length }), '(eof)');
query('getCompletionsAtPosition', P({ file: aTs, position: pos('model: Model'), includeSymbol: true }), '(includeSymbol)');
query('signatureHelp', P({ file: aTs, position: pos('add(1') + 4 }), '(inside add call)');
query('signatureHelp', P({ file: aTs, position: pos('model: Model') }), '(not a call site: null-ish)');
query('getRenameInfo', P({ file: aTs, position: pos('add(a: number') }), '(fn decl)');
query('getRenameInfo', P({ file: aTs, position: pos('export interface Entity') }), '(keyword: cannot rename)');
query('getEditsForRename', P({ file: aTs, position: pos('add(a: number') }), '(fn decl: decl+call)');
query('getEditsForRename', P({ file: aTs, position: pos('model: Model') }), '(const: several uses)');
query('getEditsForRename', P({ file: aTs, position: pos('model: Model'), providePrefixAndSuffixTextForRename: true }), '(with prefix/suffix)');
// tsgo's reference finder does not honor findInStrings today ("!!! not
// implemented", findallreferences.go), so this stays green; once the engine
// honors it, the arena encoder must send byte28 = findInStrings exactly like
// the JSON transport — any drift DIFFs here.
query('getEditsForRename', P({ file: aTs, position: pos('add(a: number'), findInStrings: true }), '(fn decl: findInStrings)');

// ── Rename wire-contract self-check ────────────────────────────────────
// The JSON-vs-arena differential above cannot see drift on the
// findInStrings/findInComments bytes: tsgo ignores both flags, so the two
// transports return the same spans no matter what the encoder wrote. Assert
// the mirror bytes directly — the findInStrings battery case starts
// DIFFing for real once the engine honors the flag.
const checkRenameBytes = (method, params, want, note) => {
	const got = renameBytes(method, params);
	if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
		fail++;
		console.log(`FAIL rename-encode ${method} ${note}: bytes [${got}] != contract [${want}]`);
		return;
	}
	pass++;
	console.log(`ok rename-encode ${method} ${note} [${want}]`);
};
checkRenameBytes('getEditsForRename', { findInStrings: true }, [1, 0, 0], '(findInStrings)');
checkRenameBytes('getEditsForRename', { findInComments: true }, [0, 1, 0], '(findInComments)');
checkRenameBytes('getEditsForRename', { providePrefixAndSuffixTextForRename: true }, [0, 0, 1], '(prefix/suffix)');
checkRenameBytes('getRenameInfo', { allowRenameOfImportPath: true }, [1, 0, 0], '(allowRenameOfImportPath)');
checkRenameBytes('getRenameInfo', { providePrefixAndSuffixTextForRename: true }, [0, 1, 0], '(prefix/suffix)');
checkRenameBytes('getRenameInfo', { allowRenameOfImportPath: true, providePrefixAndSuffixTextForRename: true }, [1, 1, 0], '(both, byte30 zero)');

addon.disposeSession(H);
console.log(`\nVERDICT: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} ok, ${fail} mismatches)`);
process.exit(fail === 0 ? 0 : 1);
