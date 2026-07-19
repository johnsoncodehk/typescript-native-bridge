#!/usr/bin/env node
/**
 * Broad LS command sweep against TNB tsserver to surface adapter throw hits.
 * Fixtures are generated under /tmp/tnb-sweep-fixtures/ (not committed).
 * Usage: TNB_TRACE_THROW=1 TNB_TRACE_THROW_FILE=/tmp/tnb-throw-hits-sweep.jsonl node tools/sweep-ls-throws.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const FIXTURE_ROOT = '/tmp/tnb-sweep-fixtures';
const MAX_POSITIONS = 400;
const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

/** @type {Record<string, Record<string, number>>} */
const stats = Object.create(null);
const failures = [];
/** @type {Array<{method:string,kind:string,command:string,file:string,offset:number,line:number,col:number,raw:object}>} */
const correlatedHits = [];

function bump(command, fileBase) {
	if (!stats[command]) stats[command] = Object.create(null);
	stats[command][fileBase] = (stats[command][fileBase] ?? 0) + 1;
}

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, offset: col };
}

/** Collect identifier start offsets (simple scan; keywords included — fine for sweep breadth). */
function collectIdentifierOffsets(text) {
	const offsets = [];
	const re = /[A-Za-z_$][\w$]*/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		offsets.push(m.index);
	}
	return offsets;
}

function sampleOffsets(offsets, max) {
	if (offsets.length <= max) return offsets;
	const out = [];
	const n = offsets.length;
	for (let i = 0; i < max; i++) {
		out.push(offsets[Math.floor((i * n) / max)]);
	}
	return out;
}

function writeFixtures() {
	fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
	fs.writeFileSync(path.join(FIXTURE_ROOT, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ES2022',
			module: 'ESNext',
			moduleResolution: 'bundler',
			jsx: 'react-jsx',
			strict: true,
			experimentalDecorators: true,
			emitDecoratorMetadata: true,
			skipLibCheck: true,
		},
		include: ['./**/*'],
	}, null, 2));

	// Line numbers below are 1-based content lines (after write). Keep constructs for reply checklist.
	const aTs = `// sweep fixture a.ts — broad TypeScript surface for LS throw discovery
export type Id = string;
export type TemplateLit = \`user-\${string}-\${number}\`;
export type Cond<T> = T extends string ? 's' : 'n';
export type Mapped<T> = { [K in keyof T]-?: T[K] };
export type AliasWithDefault<T extends object = { x: number }, U = string> = { a: T; b: U };

export interface BaseRow { id: Id; label: string }
export interface GenericIface<T extends BaseRow = BaseRow, U = number> {
	item: T;
	score: U;
	getName(): string;
}

export enum Color { Red = 1, Green = 2, Blue = 3 }
export const enum ConstColor { Cyan = 10, Magenta = 20 }

export namespace Util {
	export const version = 1;
	export function nest(n: number): number { return n + version; }
	export namespace Inner {
		export type Box<T> = { value: T };
	}
}

/** JSDoc-documented helper with typed params. */
export function documentedAdd(/** left */ a: number, /** right */ b: number): number {
	return a + b;
}

export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: string | number): string | number {
	return typeof x === 'string' ? x.toUpperCase() : x * 2;
}

export function genericFn<T extends BaseRow, U = string>(item: T, tag: U = 'tag' as U): Cond<U> {
	const held = item;
	const { id, label } = held;
	const [first, ...rest] = [id, label, tag as string];
	void rest;
	return (typeof tag === 'string' ? 's' : 'n') as Cond<U>;
}

export class GenericClass<T extends BaseRow = BaseRow> {
	#secret = 0;
	constructor(public item: T, private alias = 'a') {
		this.#secret = 1;
	}
	get score(): number { return this.#secret; }
	set score(v: number) { this.#secret = v; }
	method(x: T): Mapped<T> {
		return { ...x } as Mapped<T>;
	}
}

function deco(target: unknown, ctx: ClassDecoratorContext): void {
	void target; void ctx;
}
@deco
export class Decorated {
	value = 1;
}

export async function loadAsync(url: string): Promise<TemplateLit> {
	await Promise.resolve();
	const data = await Promise.resolve(\`user-\${url}-1\` as TemplateLit);
	return data;
}

export function destructure(
	{ id, label = 'none' }: BaseRow,
	[head, tail = 0]: [string, number?],
): string {
	return \`\${id}:\${label}:\${head}:\${tail}\`;
}

export type Pair<P> = [P, P];
export const sat = { id: '1', label: 'row' } satisfies BaseRow;

export function moreDestructure(
	opts: { count?: number } = {},
	items: string[] = ['x'],
): number {
	const { count = items.length } = opts;
	const [head = 'h', mid = 'm', ...tail] = items;
	void head; void mid; void tail;
	return count;
}

export async function pipeline(rows: BaseRow[]): Promise<number> {
	let total = 0;
	for (const row of rows) {
		const next = await loadAsync(row.id);
		total += next.length;
	}
	return total;
}

export type { AliasWithDefault as ReExportAlias };
export { documentedAdd as addDoc };
export { Color, ConstColor, Util, genericFn, GenericClass, Decorated, loadAsync, destructure, sat, moreDestructure, pipeline };
`;

	const bTsx = `/** @jsxImportSource react */
import type { BaseRow, GenericIface, Cond, Mapped, TemplateLit } from './a';
import { genericFn, GenericClass, Color, ConstColor, Util, loadAsync, destructure, sat, overload } from './a';
import { documentedAdd } from './a';

export type Props = {
	row: BaseRow;
	iface: GenericIface<BaseRow, number>;
	lit: TemplateLit;
};

function Badge(props: { text: string; tone?: Color }): JSX.Element {
	const { text, tone = Color.Red } = props;
	return <span data-tone={tone}>{text}</span>;
}

export function Card(props: Props): JSX.Element {
	const { row, iface, lit } = props;
	const mapped: Mapped<BaseRow> = { id: row.id, label: row.label };
	const box = new GenericClass(row);
	const tag: Cond<string> = genericFn(row, 'ok');
	const built = destructure(row, [row.id, ConstColor.Cyan]);
	const over = overload(iface.score);
	void Util.Inner;
	void sat;
	void documentedAdd(1, 2);
	void loadAsync(lit);
	return (
		<div className="card">
			<Badge text={mapped.label} tone={Color.Green} />
			<span>{box.score}</span>
			<span>{tag}</span>
			<span>{built}</span>
			<span>{over}</span>
			<span>{iface.item.id}</span>
		</div>
	);
}

export function List(rows: BaseRow[]): JSX.Element {
	return (
		<ul>
			{rows.map((r) => (
				<li key={r.id}>
					<Card row={r} iface={{ item: r, score: 1, getName: () => r.label }} lit={\`user-\${r.id}-0\`} />
				</li>
			))}
		</ul>
	);
}

export default function App(): JSX.Element {
	const rows: BaseRow[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
	return <List {...{ rows } as any} />;
}

export function ExtraPanel({ title }: { title: string }): JSX.Element {
	return (
		<section>
			<header>{title}</header>
			<footer>done</footer>
		</section>
	);
}
`;

	fs.writeFileSync(path.join(FIXTURE_ROOT, 'a.ts'), aTs);
	fs.writeFileSync(path.join(FIXTURE_ROOT, 'b.tsx'), bTsx);
	return {
		aTs: path.join(FIXTURE_ROOT, 'a.ts'),
		bTsx: path.join(FIXTURE_ROOT, 'b.tsx'),
		contents: {
			'a.ts': aTs,
			'b.tsx': bTsx,
		},
	};
}

function throwFilePath() {
	return process.env.TNB_TRACE_THROW_FILE ?? null;
}

function readNewThrowLines(prevLen) {
	const p = throwFilePath();
	if (!p || !fs.existsSync(p)) return { lines: [], len: prevLen };
	const raw = fs.readFileSync(p, 'utf8');
	const slice = raw.slice(prevLen);
	const lines = slice.split('\n').filter(Boolean).map(l => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);
	return { lines, len: raw.length };
}

async function safeSend(send, command, args, meta) {
	bump(command, meta.fileBase);
	const before = readNewThrowLines(meta.throwLen).len;
	meta.throwLen = before;
	let res;
	try {
		res = await send(command, args, 30_000);
		if (res && res.success === false) {
			meta.fail++;
			failures.push({ command, file: meta.fileBase, line: meta.line, col: meta.col, message: String(res.message ?? '').slice(0, 200) });
		}
		else meta.ok++;
	} catch (e) {
		meta.fail++;
		res = { success: false, message: String(e?.message ?? e) };
		failures.push({ command, file: meta.fileBase, line: meta.line, col: meta.col, message: String(res.message).slice(0, 200), threw: true });
	}
	const after = readNewThrowLines(meta.throwLen);
	meta.throwLen = after.len;
	for (const hit of after.lines) {
		correlatedHits.push({
			method: hit.method,
			kind: hit.kind,
			command,
			file: meta.fileBase,
			offset: meta.offset ?? -1,
			line: meta.line ?? -1,
			col: meta.col ?? -1,
			raw: hit,
		});
	}
	return res;
}

async function sweepFile(send, filePath, content, fileBase, meta) {
	const offsets = sampleOffsets(collectIdentifierOffsets(content), MAX_POSITIONS);
	console.error(`[sweep] ${fileBase}: ${offsets.length} positions (of ${collectIdentifierOffsets(content).length} ids)`);

	for (const offset of offsets) {
		const pos = offsetToLineCol(content, offset);
		meta.fileBase = fileBase;
		meta.offset = offset;
		meta.line = pos.line;
		meta.col = pos.offset;
		const loc = { file: filePath, line: pos.line, offset: pos.offset };

		await safeSend(send, 'quickinfo', loc, meta);
		await safeSend(send, 'definitionAndBoundSpan', loc, meta);
		await safeSend(send, 'typeDefinition', loc, meta);
		await safeSend(send, 'implementation', loc, meta);
		await safeSend(send, 'references', loc, meta);
		await safeSend(send, 'rename', { ...loc, findInStrings: false, findInComments: false }, meta);
		await safeSend(send, 'documentHighlights', { ...loc, filesToSearch: [filePath] }, meta);

		const comp = await safeSend(send, 'completionInfo', {
			...loc,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		}, meta);
		const entries = comp?.body?.entries ?? [];
		for (const entry of entries.slice(0, 3)) {
			await safeSend(send, 'completionEntryDetails', {
				file: filePath,
				line: pos.line,
				offset: pos.offset,
				entryName: entry.name,
				source: entry.source,
				data: entry.data,
			}, meta);
		}

		await safeSend(send, 'signatureHelp', {
			...loc,
			triggerReason: { kind: 'invoked' },
		}, meta);
	}

	meta.offset = -1;
	meta.line = -1;
	meta.col = -1;

	await safeSend(send, 'navtree', { file: filePath }, meta);
	await safeSend(send, 'encodedSemanticClassifications-full', {
		file: filePath,
		start: 0,
		length: content.length,
	}, meta);

	const sem = await safeSend(send, 'semanticDiagnosticsSync', { file: filePath }, meta);
	const sug = await safeSend(send, 'suggestionDiagnosticsSync', { file: filePath }, meta);
	const diags = [...(sem?.body ?? []), ...(sug?.body ?? [])];
	for (const d of diags) {
		const start = d.start;
		const end = d.end;
		if (!start || !end) continue;
		const codes = typeof d.code === 'number' ? [d.code] : [];
		await safeSend(send, 'getCodeFixes', {
			file: filePath,
			startLine: start.line,
			startOffset: start.offset,
			endLine: end.line,
			endOffset: end.offset,
			errorCodes: codes,
		}, meta);
	}
}

function printStats() {
	const commands = Object.keys(stats).sort();
	const files = [...new Set(commands.flatMap(c => Object.keys(stats[c])))].sort();
	console.log('\n=== request stats (command × file → count) ===');
	let total = 0;
	for (const command of commands) {
		for (const file of files) {
			const n = stats[command][file] ?? 0;
			if (n === 0) continue;
			total += n;
			console.log(`${command}\t${file}\t${n}`);
		}
	}
	console.log(`TOTAL\t*\t${total}`);
	console.log(`\n=== correlated throw hits: ${correlatedHits.length} ===`);
	for (const h of correlatedHits.slice(0, 50)) {
		console.log(JSON.stringify({
			method: h.method,
			kind: h.kind,
			command: h.command,
			file: h.file,
			offset: h.offset,
			line: h.line,
			col: h.col,
			topStack: h.raw?.stack?.[0],
		}));
	}
	if (correlatedHits.length > 50) {
		console.log(`... ${correlatedHits.length - 50} more`);
	}
	const corrPath = '/tmp/tnb-throw-hits-sweep-correlated.json';
	fs.writeFileSync(corrPath, JSON.stringify(correlatedHits, null, 2));
	console.error(`[sweep] wrote ${corrPath}`);
}

async function main() {
	const { aTs, bTsx, contents } = writeFixtures();
	const aLines = contents['a.ts'].split('\n').length;
	const bLines = contents['b.tsx'].split('\n').length;
	console.error(`[sweep] fixtures: a.ts=${aLines} lines, b.tsx=${bLines} lines, total=${aLines + bLines}`);
	if (aLines + bLines < 150) {
		throw new Error(`fixture lines ${aLines + bLines} < 150`);
	}

	const meta = { ok: 0, fail: 0, throwLen: 0, fileBase: '', offset: -1, line: -1, col: -1 };
	const throwPath = throwFilePath();
	if (throwPath && fs.existsSync(throwPath)) {
		meta.throwLen = fs.statSync(throwPath).size;
	}

	await withTsserver({
		tsserverPath: tnbPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
		env: tnbHarnessEnv({
			TNB_TRACE_THROW: process.env.TNB_TRACE_THROW,
			TNB_TRACE_THROW_FILE: process.env.TNB_TRACE_THROW_FILE,
		}),
		deadlineMs: 900_000,
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [
				{ file: aTs, fileContent: contents['a.ts'], projectRootPath: FIXTURE_ROOT },
				{ file: bTsx, fileContent: contents['b.tsx'], projectRootPath: FIXTURE_ROOT },
			],
		});

		await sweepFile(send, aTs, contents['a.ts'], 'a.ts', meta);
		await sweepFile(send, bTsx, contents['b.tsx'], 'b.tsx', meta);
	});

	printStats();
	console.error(`[sweep] ok≈${meta.ok} fail≈${meta.fail}`);
	fs.writeFileSync('/tmp/tnb-sweep-failures.json', JSON.stringify(failures, null, 1));
	const byCmdMsg = Object.create(null);
	for (const f of failures) {
		const key = `${f.command} :: ${f.message.split('\n')[0]}`;
		byCmdMsg[key] = (byCmdMsg[key] ?? 0) + 1;
	}
	console.error('[sweep] failure breakdown:');
	for (const [k, n] of Object.entries(byCmdMsg).sort((a, b) => b[1] - a[1])) {
		console.error(`  ${n}\t${k}`);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
