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
process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');

// ── Fixture (deterministic) ──────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-arena-parity-'));
const aTs = path.join(dir, 'a.ts');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
	include: ['*.ts'],
}, null, 2));
const aSrc = `export interface Entity<K extends string> { id: K; meta: Record<string, unknown>; tags: string[] }
export interface Model extends Entity<"m"> { value: number; nested: { a: string; b: number[] } }
export type RO = readonly [string, number, boolean];
export type MutTup = [string, number];
export type Lit = "x" | 42 | true;
export class Base { z: string = ""; }
export class Derived extends Base { w?: number; }
export function add(a: number, b?: string): Promise<number> { return Promise.resolve(a); }
export const callResult = add(1, "s");
export const model: Model = { id: "m", meta: {}, tags: ["t"], value: 1, nested: { a: "x", b: [1] } };
export type Cond<T> = T extends string ? "str" : "other";
export const lit: Lit = "x";
export const tup: RO = ["a", 1, true];
export const mtup: MutTup = ["a", 1];
export const maybe: string | null | undefined = null;
export const d = new Derived();
export function generic<T extends object>(x: T): T { return x; }
export const g = generic(model);
export const numLit = 42 as const;
export const strLit = "hello" as const;
export type M<T> = { [P in keyof T]?: T[P] };
export const mm: M<Model> = {};
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
		case 'getReturnTypeOfSignature': case 'getParametersOfSignature':
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
	if (method === 'typeToString') {
		const o = view.getUint32(ARENA_RESP_OFFSET + 16, true), n = view.getUint32(ARENA_RESP_OFFSET + 20, true);
		return dec.decode(arenaBuf.subarray(o, o + n));
	}
	if (method === 'isArrayType') return view.getUint8(ARENA_RESP_OFFSET + 16) !== 0;
	const str = id => (id === 0 ? undefined : strTab[id]);
	const u32z = off => { const x = view.getUint32(off, true); return x === 0 ? undefined : x; };
	const u64z = off => { const x = view.getBigUint64(off, true); return x === 0n ? undefined : Number(x); };
	const u32Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = view.getUint32(p, true); p += 4; } return out; };
	const u64Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = Number(view.getBigUint64(p, true)); p += 8; } return out; };
	const strArr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; let p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) { out[i] = str(view.getUint32(p, true)); p += 4; } return out; };
	const u8Arr = off => { const c = view.getUint32(off + 4, true); if (!c) return undefined; const p = view.getUint32(off, true); const out = new Array(c); for (let i = 0; i < c; i++) out[i] = view.getUint8(p + i); return out; };
	const readHandle = off => `${view.getUint32(off, true)}.${view.getUint32(off + 4, true)}.${str(view.getUint32(off + 8, true)) ?? ''}`;
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
		return d;
	};
	const readSymbol = off => {
		const d = { id: Number(view.getBigUint64(off, true)), project: str(view.getUint32(off + 8, true)), name: str(view.getUint32(off + 12, true)) ?? '', flags: view.getUint32(off + 16, true), checkFlags: view.getUint32(off + 20, true) };
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
	};
	const resKind = RESULT[method];
	const count = view.getUint32(ARENA_RESP_OFFSET + 16, true);
	let off = ARENA_RESP_OFFSET + 20;
	const recKind = resKind === 'type' || resKind === 'types' ? 'type' : resKind === 'symbol' || resKind === 'symbols' ? 'symbol' : 'signature';
	const read = recKind === 'type' ? readType : recKind === 'symbol' ? readSymbol : readSignature;
	const stride = recKind === 'type' ? 152 : recKind === 'symbol' ? 72 : 64;
	const out = [];
	for (let i = 0; i < count; i++) { out.push(read(off)); off += stride; }
	return resKind === recKind ? out[0] : out;
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
const symLit = query('getSymbolAtPosition', P({ file: aTs, position: pos('lit: Lit') }), '(union literal)');
const symMaybe = query('getSymbolAtPosition', P({ file: aTs, position: pos('maybe: string') }), '(nullable)');
const symD = query('getSymbolAtPosition', P({ file: aTs, position: pos('d = new Derived') }), '(class)');
const symNum = query('getSymbolAtPosition', P({ file: aTs, position: pos('numLit') }), '(num literal)');
const symStr = query('getSymbolAtPosition', P({ file: aTs, position: pos('strLit') }), '(str literal)');
const symGen = query('getSymbolAtPosition', P({ file: aTs, position: pos('generic<T') }), '(generic fn)');
const symEntity = query('getSymbolAtPosition', P({ file: aTs, position: pos('Entity<K') }), '(interface)');
const symCond = query('getSymbolAtPosition', P({ file: aTs, position: pos('Cond<T>') }), '(conditional alias)');
const symMm = query('getSymbolAtPosition', P({ file: aTs, position: pos('mm: M<Model>') }), '(alias args)');

if (!symAdd || !symModel) { console.error('seed queries failed'); process.exit(1); }

const addType = query('getTypeOfSymbol', P({ symbol: symAdd.id }));
query('getDeclaredTypeOfSymbol', P({ symbol: symAdd.id }));
query('getTypeOfSymbolAtLocation', P({ symbol: symAdd.id, location: symAdd.valueDeclaration }));
const modelType = query('getTypeOfSymbol', P({ symbol: symModel.id }));
const tupType = query('getTypeOfSymbol', P({ symbol: symTup.id }));
const mtupType = query('getTypeOfSymbol', P({ symbol: symMTup.id }));
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
// getSignaturesOfType above.

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

addon.disposeSession(H);
console.log(`\nVERDICT: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} ok, ${fail} mismatches)`);
process.exit(fail === 0 ? 0 : 1);
