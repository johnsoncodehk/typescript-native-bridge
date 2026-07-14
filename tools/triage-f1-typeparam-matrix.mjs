#!/usr/bin/env node
/**
 * Family-1 type-parameter / enclosing print matrix.
 * Probes stock vs TNB QI for: (a) typeof/indexed-access reuse in enclosing
 * signature, (b) call-style vs construct-style, (c) NamedTupleMember label →
 * type fallback, (d) plain type-param name in local generic.
 *
 * Fixture under /tmp. Dual-diff via withTsserver.
 * Usage: node tools/triage-f1-typeparam-matrix.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { printQiDiff, quickinfoBoth, twFile } from './triage-f1-qi-common.mjs';

const fixtureDir = '/tmp/tnb-f1-typeparam-matrix';
const fixtureFile = path.join(fixtureDir, 'matrix.ts');

const SRC = [
	'// (d) plain type-param hover',
	'function id<T>(x: T): T { return x; }',
	'',
	'// (a) typeof / indexed-access reuse in enclosing signature context',
	'declare function setup(): Promise<{ props: { n: number }; expose: () => void }>;',
	'type Props = NonNullable<Awaited<typeof setup>>["props"];',
	'function wrap<Row extends { id: string }>(__VLS_props: Props, __VLS_setup?: typeof setup): void {',
	'  void __VLS_props; void __VLS_setup;',
	'  const _row: Row = null as any;',
	'  void _row;',
	'}',
	'',
	'// (b) construct signature typed value — stock QI for type-param uses call style',
	'type Ctor = { new <U>(props: { value: U }): { $props: typeof props } };',
	'declare const C: Ctor;',
	'',
	'// (c) named tuple member — stock QI shows element type, empty kind',
	'type Tup = [value: string];',
	'declare const t: Tup;',
	'',
].join('\n');

function ensureFixture() {
	fs.mkdirSync(fixtureDir, { recursive: true });
	fs.writeFileSync(fixtureFile, SRC);
	fs.writeFileSync(
		path.join(fixtureDir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: { target: 'ES2020', module: 'ESNext', strict: true, noEmit: true },
			include: ['*.ts'],
		}, null, 2),
	);
}

function findIdent(content, ident, occurrence = 1) {
	let from = 0;
	for (let n = 0; n < occurrence; n++) {
		const idx = content.indexOf(ident, from);
		if (idx < 0) throw new Error(`ident ${ident} #${occurrence} not found`);
		const before = idx === 0 ? '' : content[idx - 1];
		const after = content[idx + ident.length] ?? '';
		if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) {
			from = idx + ident.length;
			n--;
			continue;
		}
		if (n === occurrence - 1) {
			let line = 1;
			let col = 1;
			for (let j = 0; j < idx; j++) {
				if (content[j] === '\n') {
					line++;
					col = 1;
				}
				else col++;
			}
			return { line, offset: col };
		}
		from = idx + ident.length;
	}
	throw new Error(`ident ${ident} #${occurrence} not found`);
}

ensureFixture();
const content = fs.readFileSync(fixtureFile, 'utf8');

const sites = [
	{
		id: 'd-plain-typeparam',
		title: '(d) plain type-param T in function id',
		...findIdent(content, 'T', 1),
		file: fixtureFile,
		content,
		projectRoot: fixtureDir,
		vue: false,
	},
	{
		id: 'a-enclosing-row',
		title: '(a) type-param Row — enclosing typeof/Props should stay compact',
		...findIdent(content, 'Row', 2), // use-site in const _row: Row
		file: fixtureFile,
		content,
		projectRoot: fixtureDir,
		vue: false,
		note: 'May still expand on pure .ts; vue:#4577 is the authoritative enclosing witness',
	},
	{
		id: 'c-named-tuple',
		title: '(c) NamedTupleMember label — stock type fallback "string"',
		...findIdent(content, 'value'),
		file: fixtureFile,
		content,
		projectRoot: fixtureDir,
		vue: false,
	},
	{
		id: 'vue-4577-row',
		title: '(vue) #4577 Row type-param enclosing',
		file: twFile('component-meta/#4577/main.vue'),
		line: 10,
		offset: 34,
		vue: true,
	},
	{
		id: 'vue-5067-T',
		title: '(vue) #5067 NamedTupleMember / type-param empty display',
		file: twFile('tsc/#5067/comp.vue'),
		line: 6,
		offset: 11,
		vue: true,
	},
	{
		id: 'vue-events-T',
		title: '(vue) events-T call-style enclosing',
		file: twFile('tsc/events/main.vue'),
		line: 50,
		offset: 43,
		vue: true,
	},
];

let match = 0;
let diff = 0;
for (const site of sites) {
	const r = await quickinfoBoth(site);
	const ok = printQiDiff(`${site.id} :: ${site.title}`, r);
	if (ok) match++;
	else diff++;
	if (site.note) console.log(`note: ${site.note}`);
}
console.log(`\n### typeparam-matrix TOTAL MATCH=${match} DIFF=${diff}/${sites.length}`);
process.exit(diff ? 1 : 0);
