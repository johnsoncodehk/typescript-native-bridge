#!/usr/bin/env node
/**
 * Issue #73 witness: checker.getBaseTypes on the empty tuple type that comes
 * from an array literal (`const empty: [] = []`, `[] as const`, `x.match(re)
 * || []`) nil-dereferenced inside tsgo's getBaseTypes and killed the process —
 * a native panic cannot be caught, so one lint rule walking base types
 * (eslint-plugin-unicorn's no-loop-iterable-mutation, on by default in its
 * recommended preset) aborted the whole run with no file or rule name.
 *
 * The type is malformed by construction: createArrayLiteralType clones the
 * arity-0 tuple target through cloneTypeReference, which allocates
 * *TypeReference data and then copies the source's objectFlags — Tuple
 * included — so the type's flags say tuple while its data is a reference, and
 * AsInterfaceType() is nil. getBaseTypes now resolves the tuple through its
 * target and reads the readonly modifier off the type the caller asked about —
 * the shape upstream's merged microsoft/TypeScript#64080 guards at the proto
 * serializer, where the same tuple-reference data is read.
 *
 * Most shapes are compared in lockstep (typeToString + base-type arity +
 * base-type names); the two non-empty tuple rows are NOT — stock throws a
 * catchable TypeError there where the bridge answers no base types, so they are
 * pinned as known divergences instead. In-process, because a panic takes the
 * child with it.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 *
 * Usage: node tools/triage-empty-tuple-basetypes.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const tss = require2(stockTsPath); // stock

const FIXTURE = `export declare const re: RegExp;
export const annotated: [] = [];
export const asserted = [] as const;
export const fromMatch: RegExpMatchArray | [] = /x/.exec('x') || [];
export function words(text: string) {
	const tokens = text.match(re) || [];
	return tokens.length;
}
export declare const roEmpty: readonly [];
export function variadic<T extends unknown[]>(x: [string, ...T]): void;
export declare const targetable: [string, number];
export declare const roOne: readonly [string];
export type RoAlias = readonly [];
export class Base {}
export class Derived extends Base {}
export interface Parent {}
export interface Child extends Parent {}
export declare const lit: [string, number];
`;

// Each literal case names the declaration its empty literal belongs to, so the
// lookup never depends on traversal order.
const CASES = [
	{ label: 'annotated [] (identifier)', kind: 'VariableDeclaration', name: 'annotated', via: 'name' },
	{ label: 'annotated [] (annotation node)', kind: 'TupleTypeNode', owner: 'annotated' },
	{ label: 'annotated [] (literal)', kind: 'ArrayLiteralExpression', owner: 'annotated' },
	{ label: '[] as const (literal)', kind: 'ArrayLiteralExpression', owner: 'asserted' },
	{ label: 're.exec() || [] (literal)', kind: 'ArrayLiteralExpression', owner: 'fromMatch' },
	{ label: 'text.match(re) || [] (literal)', kind: 'ArrayLiteralExpression', owner: 'tokens' },
	{ label: 'readonly [] (identifier)', kind: 'VariableDeclaration', name: 'roEmpty', via: 'name' },
	{ label: 'readonly [] (annotation node)', kind: 'TupleTypeNode', owner: 'roEmpty' },
	{ label: 'readonly [string] (identifier)', kind: 'VariableDeclaration', name: 'roOne', via: 'name' },
	{ label: 'tuple target [string, number]', kind: 'VariableDeclaration', name: 'targetable', via: 'type' },
	{ label: 'tuple target [string, ...T]', kind: 'ParameterDeclaration', name: 'x', via: 'type' },
	{ label: 'Derived class', kind: 'Identifier', text: 'Derived' },
	{ label: 'Child interface', kind: 'Identifier', text: 'Child' },
	{ label: 'lit [string, number] (identifier)', kind: 'VariableDeclaration', name: 'lit', via: 'name' },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-tuple-basetypes-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	include: ['src.ts'],
	compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', types: [] },
}));
fs.writeFileSync(path.join(dir, 'src.ts'), FIXTURE);

function program(engine) {
	if (engine === tsb) {
		const NOOP = () => {};
		const host = engine.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, engine.sys, engine.createAbstractBuilder, NOOP, NOOP);
		host.watchFile = () => ({ close: NOOP });
		host.watchDirectory = () => ({ close: NOOP });
		host.setTimeout = undefined;
		host.clearTimeout = undefined;
		let builder;
		host.afterProgramCreate = b => { builder = b; };
		const watch = engine.createWatchProgram(host);
		return { program: (builder ?? watch.getProgram()).getProgram(), close: () => watch.close?.() };
	}
	return {
		program: engine.createProgram([path.join(dir, 'src.ts')], {
			strict: true, noEmit: true, target: engine.ScriptTarget.ES2022, module: engine.ModuleKind.ESNext, moduleResolution: engine.ModuleResolutionKind.Bundler,
		}),
		close: () => {},
	};
}

function collect(engine, sourceFile) {
	// Predicates, not SyntaxKind lookups: the fork remaps kinds, so a shared
	// `SyntaxKind[node.kind]` name lookup is engine-specific by construction.
	const found = { tuples: [], arrayLiterals: [], declarations: [], parameters: [], identifiers: [] };
	(function walk(node) {
		if (engine.isTupleTypeNode(node)) found.tuples.push(node);
		if (engine.isArrayLiteralExpression(node)) found.arrayLiterals.push(node);
		if (engine.isVariableDeclaration(node)) found.declarations.push(node);
		if (engine.isParameter(node)) found.parameters.push(node);
		if (engine.isIdentifier(node)) found.identifiers.push(node);
		node.forEachChild(walk);
	})(sourceFile);
	return found;
}

// The empty literal a case means is the one bound to a named declaration —
// `asserted = [] as const`, `fromMatch = ... || []`, `words`'s `text.match(re)
// || []`. Naming it removes any dependence on traversal order, so a fixture
// edit cannot silently point a label at a different node while the numbers
// still line up.
function enclosingDeclarationName(engine, node) {
	for (let n = node.parent; n; n = n.parent) {
		if (engine.isVariableDeclaration(n) && engine.isIdentifier(n.name)) return n.name.text;
		if (engine.isFunctionDeclaration(n) && n.name) return n.name.text;
		if (engine.isSourceFile(n)) return undefined;
	}
	return undefined;
}

function resolveNode(engine, found, sourceFile, spec) {
	if (spec.kind === 'ArrayLiteralExpression') {
		const node = found.arrayLiterals.find(n => n.elements.length === 0 && enclosingDeclarationName(engine, n) === spec.owner);
		if (!node) throw new Error(`${spec.label}: no empty array literal owned by ${spec.owner}`);
		return node;
	}
	if (spec.kind === 'TupleTypeNode') {
		const node = spec.owner
			? found.tuples.find(n => enclosingDeclarationName(engine, n) === spec.owner)
			: found.tuples[0];
		if (!node) throw new Error(`${spec.label}: no tuple type node${spec.owner ? ` owned by ${spec.owner}` : ''}`);
		return node;
	}
	if (spec.kind === 'VariableDeclaration') {
		const node = found.declarations.find(n => engine.isIdentifier(n.name) && n.name.text === spec.name);
		if (!node) throw new Error(`${spec.label}: no declaration named ${spec.name}`);
		if (spec.via === 'name') return node.name;
		if (spec.via === 'type') return node.type;
		return node;
	}
	if (spec.kind === 'ParameterDeclaration') {
		const node = found.parameters.find(n => engine.isIdentifier(n.name) && n.name.text === spec.name);
		if (!node) throw new Error(`${spec.label}: no parameter named ${spec.name}`);
		return spec.via === 'type' ? node.type : node;
	}
	const wanted = spec.kind === 'Identifier' ? spec.text : undefined;
	const node = found.identifiers.find(n => n.getText(sourceFile) === wanted
		&& (engine.isClassDeclaration(n.parent) || engine.isInterfaceDeclaration(n.parent)
			|| engine.isVariableDeclaration(n.parent) || engine.isTypeReferenceNode(n.parent)));
	if (!node) throw new Error(`${spec.label}: no identifier ${spec.text}`);
	return node;
}

function probe(engine) {
	const { program: prog, close } = program(engine);
	const checker = prog.getTypeChecker();
	const sourceFile = prog.getSourceFile(path.join(dir, 'src.ts'));
	const found = collect(engine, sourceFile);
	const out = { _bases: {} };
	for (const spec of CASES) {
		const node = resolveNode(engine, found, sourceFile, spec);
		const type = checker.getTypeAtLocation(node);
		// Stock throws a catchable TypeError on a non-empty tuple (it reads
		// undefined's `symbol`), so both sides canonicalize "rejected the
		// input" to one token: the gate is about the answers, and a native
		// panic cannot be caught at all — it ends the child before this line.
		let bases;
		try { bases = checker.getBaseTypes(type); }
		catch { bases = undefined; }
		if (!bases) {
			// undefined as well as a throw counts as "rejected the input": a
			// bridge-facing adapter answers undefined where stock throws.
			out[spec.label] = { type: checker.typeToString(type), throws: true };
			out._bases[spec.label] = [];
			continue;
		}
		out[spec.label] = {
			type: checker.typeToString(type),
			baseCount: bases.length,
			bases: bases.map(b => checker.typeToString(b)),
		};
		out._bases[spec.label] = bases;
	}
	close();
	return out;
}

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const tnb = probe(tsb);
const stk = probe(tss);

// The non-empty tuple is a known, pre-existing divergence, not a regression
// this fix introduces: stock rejects the input (catchable TypeError from
// reading an undefined `symbol`) where the bridge answers no base types. It is
// pinned, and deliberately kept out of the stock-equality loop above so a
// future upstream convergence cannot pass unnoticed either way.
// The two non-empty tuple rows: same known divergence, pinned instead of
// compared, and kept out of the equality loop so a future convergence cannot
// pass unnoticed either way.
// The tuple TARGET rows join them for the same reason (stock rejects a
// non-empty tuple wherever it is asked about it, target or reference), which is
// also why getTupleBaseType's element loop and its variadic branch cannot be
// pinned differentially at all: no engine answers there to compare against.
// They stay in as panic/recursion canaries — a regression that made the target
// arm recurse or panic shows up as a dead child, not a diff.
const NON_GOALS = [
	'lit [string, number] (identifier)',
	'readonly [string] (identifier)',
	'tuple target [string, number]',
	'tuple target [string, ...T]',
];

for (const spec of CASES) {
	if (NON_GOALS.includes(spec.label)) continue;
	const a = tnb[spec.label], b = stk[spec.label];
	check(JSON.stringify(a) === JSON.stringify(b),
		`${spec.label}: base-type drift vs stock\n    tnb   = ${JSON.stringify(a)}\n    stock = ${JSON.stringify(b)}`);
}
for (const label of NON_GOALS) {
	check(tnb[label].baseCount === 0,
		`${label}: expected the bridge's existing answer (0 bases), got ${JSON.stringify(tnb[label])}`);
	check(stk[label].throws === true,
		`${label}: stock no longer rejects the non-empty tuple — re-check the divergence`);
}

// Literal pins: the arity-0 literal rows must answer exactly what the
// annotation/identifier rows answer. A fix that returned no bases would keep
// the process alive and still be wrong here.
for (const label of ['[] as const (literal)', 'annotated [] (literal)', 're.exec() || [] (literal)', 'text.match(re) || [] (literal)', 'annotated [] (identifier)', 'annotated [] (annotation node)']) {
	const row = tnb[label];
	check(row && row.baseCount === 1, `${label}: expected 1 base type, got ${JSON.stringify(row)}`);
	check(row && row.bases.length === 1 && row.bases[0] === 'never[]',
		`${label}: expected never[], got ${JSON.stringify(row?.bases)}`);
}
// The clone arm recomputes instead of memoizing (its data is a *TypeReference
// with no field to memoize in), so pin what makes that observable-equivalent:
// the recomputed type is the SAME registry type the memoized paths hand out,
// and it is a different type from the readonly target's base. A future edit
// that allocated a fresh array per call would keep every string row above
// green and fail these.
const tnbBases = tnb._bases;
check(tnbBases['annotated [] (literal)'][0] === tnbBases['[] as const (literal)'][0],
	'the mutable and readonly clones must share one base type instance');
check(tnbBases['annotated [] (literal)'][0] === tnbBases['annotated [] (identifier)'][0],
	'the clone base and the declared mutable tuple base must be the same type instance');
check(tnbBases['readonly [] (identifier)'][0] !== tnbBases['annotated [] (literal)'][0],
	'the readonly tuple base must NOT be the mutable base type instance');
check(tnbBases['annotated [] (literal)'][0] === tnbBases['annotated [] (literal)'][0],
	'repeated reads must hand back the same base type instance');

// Declared readonly tuples keep the readonly base: the primitive that the
// guard must not collapse into "everything mutable" (the shape that a naive
// hardcoded false regressed, invisible to the array-literal rows above).
for (const label of ['readonly [] (identifier)', 'readonly [] (annotation node)']) {
	check(tnb[label]?.bases?.[0] === 'readonly never[]',
		`${label}: expected readonly never[], got ${JSON.stringify(tnb[label])}`);
}
check(tnb['readonly [string] (identifier)'].type === 'readonly [string]',
	`readonly [string]: expected the readonly tuple type, got ${JSON.stringify(tnb['readonly [string] (identifier)'])}`);

// The class/interface rows keep their own answers (no over-broad target read).
check(tnb['Derived class'].bases.includes('Base'), `Derived class: expected Base among ${JSON.stringify(tnb['Derived class'].bases)}`);
check(tnb['Child interface'].bases.includes('Parent'), `Child interface: expected Parent among ${JSON.stringify(tnb['Child interface'].bases)}`);

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`ok empty-tuple-basetypes: #73 repro, ${CASES.length - NON_GOALS.length} shapes agree with stock, ${NON_GOALS.length} known divergences pinned (fork ${tsb.version})`);

process.exit(0);
