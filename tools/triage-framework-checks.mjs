#!/usr/bin/env node
/**
 * Framework checker compatibility witness: svelte-check / astro-check / glint
 * against the TNB fork vs stock typescript. Each case builds a minimal project
 * in a cache dir (deps installed once, then reused), runs the tool with TNB
 * and with stock typescript@6.0.3 (packed on demand), and asserts the
 * invariants for the failure modes that were fixed:
 *   - glint: must NOT be fail-silent (virtual App.gts→App.ts via readFile
 *     override reaches tsgo; was: 0 errors where stock reports them)
 *   - svelte: must NOT report the svelteHTML false positive (ambient shim
 *     d.ts reach tsgo via updateSnapshot additionalFiles)
 *   - astro: full text parity with stock (volar-based, control case)
 *   - astro7: astro@7 cross-directory typed-Props shape — no TS2304 'Fragment'
 *     / TS2708 namespace-'Astro' false positives (#38: plugin ambient roots
 *     must survive snapshot rebuilds), then full parity with stock
 * Usage: node tools/triage-framework-checks.mjs [svelte|astro|astro7|glint...]
 * Exit: 0 = PASS, 1 = FAIL. Network required on first run (npm installs).
 *
 * v5 classification: the glint/svelte invariants are diagnostic-SET
 * semantics (bridge-contract surface, stock-gated). The astro full-text
 * parity covers diagnostic content (codes/spans — contract) but would also
 * trip on engine-owned presentation (tsgo's own diagnostic text/code
 * choices, e.g. the TS6196 class); such a failure is a KNOWN registration
 * (pristine tsgo reference), not a revert-to-stock patch.
 */
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = process.env.TNB_FW_CACHE ?? '/tmp/tnb-fw-fixtures';
const stockDir = path.join(cacheRoot, 'stock-ts');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const TSCONFIG_BASE = {
	compilerOptions: {
		target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
		strict: true, noEmit: true, skipLibCheck: true, types: [],
	},
};

const CASES = {
	glint: {
		deps: {
			'@glint/core': '^1.5.0',
			'@glint/environment-ember-loose': '^1.5.0',
			'@glint/environment-ember-template-imports': '^1.5.0',
			'@glint/template': '^1.5.0',
		},
		files: {
			'tsconfig.json': JSON.stringify({ ...TSCONFIG_BASE, include: ['src/**/*.ts', 'src/**/*.gts'], glint: { environment: ['ember-loose', 'ember-template-imports'] } }, null, 2),
			'src/util.ts': 'export function double(n: number): number { return n * 2; }\n',
			'src/App.gts': `import Component from '@glimmer/component';
import { double } from './util';
interface Args { count: number }
const wrong: string = double(1);
export default class App extends Component<{ Args: Args }> {
  <template><p>{{double @count}}</p></template>
}
`,
		},
		run: (dir) => execFileSync('npx', ['glint'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		check(out) {
			const t = stripAnsi(out);
			if (!/error TS2322[^\n]*Type 'number' is not assignable to type 'string'/.test(t)) {
				return 'FAIL-silent: deliberate TS2322 on src/App.gts missing';
			}
			return undefined;
		},
	},
	svelte: {
		deps: { svelte: '^5.0.0', 'svelte-check': '^4.0.0', tslib: '^2.6.0' },
		files: {
			'tsconfig.json': JSON.stringify({ ...TSCONFIG_BASE, compilerOptions: { ...TSCONFIG_BASE.compilerOptions, allowJs: true, checkJs: true }, include: ['src/**/*.svelte', 'src/**/*.ts'] }, null, 2),
			'src/util.ts': 'export function double(n: number): number { return n * 2; }\n',
			'src/App.svelte': `<script lang="ts">
  import { double } from './util';
  let { count }: { count: number } = $props();
  const wrong: string = double(count);
</script>
<p>{double(count)}</p>
`,
			// #46 coverage: patterns that make svelte2tsx emit __sveltets_2_*
			// helper references — component render (ensureComponent), {#each}
			// (ensureArray), {#snippet}/{@render} (ensureSnippet). They resolve
			// only while the svelte2tsx shim roots survive snapshot rebuilds.
			'src/Child.svelte': `<script lang="ts">
  let { label }: { label: string } = $props();
</script>
<span>{label}</span>
`,
			'src/Parent.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let items: string[] = ['a', 'b'];
</script>
<Child label={42} />
{#each items as item}
  <p>{item}</p>
{/each}
`,
			'src/Snippets.svelte': `<script lang="ts">
  let { name }: { name: string } = $props();
</script>
{#snippet row(text: string)}
  <p>{text}: {name}</p>
{/snippet}
{@render row('hello')}
`,
		},
		run: (dir) => execFileSync('npx', ['svelte-check', '--tsconfig', './tsconfig.json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		check(out) {
			const t = stripAnsi(out);
			if (t.includes("Cannot find name 'svelteHTML'")) return 'false positive: svelteHTML unresolved';
			if (/Cannot find name '__sveltets_2_/.test(t)) return 'false positive: __sveltets_2_* shim helpers unresolved (#46)';
			if (!/found 2 errors/.test(t)) return `expected exactly 2 errors, got: ${t.split('\n').pop()}`;
			return undefined;
		},
	},
	astro: {
		deps: { astro: '^5.0.0', '@astrojs/check': '^0.9.0' },
		files: {
			'tsconfig.json': JSON.stringify({ extends: 'astro/tsconfigs/strict', compilerOptions: { noEmit: true }, include: ['.astro/types.d.ts', 'src/**/*'] }, null, 2),
			'src/util.ts': 'export function double(n: number): number { return n * 2; }\n',
			'src/App.astro': `---
import { double } from './util';
interface Props { count: number }
const { count } = Astro.props;
const wrong: string = double(count);
---
<p>{double(count)}</p>
`,
		},
		run: (dir) => execFileSync('npx', ['astro', 'check'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		check(out, outStock) {
			const norm = (s) => stripAnsi(s)
				.replace(/[^\n]*TNB ACTIVE[^\n]*\n?/g, '') // TNB banner line
				.replace(/\d{2}:\d{2}:\d{2}/g, 'TT:TT:TT')
				.replace(/\d+(?:\.\d+)?m?s\b/g, 'Xms');
			const a = norm(out).trim(), b = norm(outStock).trim();
			if (a !== b) return `output mismatch vs stock:\n--- tnb ---\n${a}\n--- stock ---\n${b}`;
			return undefined;
		},
	},
	astro7: {
		deps: { astro: '7.1.4', '@astrojs/check': '0.9.10' },
		files: {
			'tsconfig.json': JSON.stringify({ extends: 'astro/tsconfigs/strictest', compilerOptions: { noEmit: true }, include: ['.astro/types.d.ts', 'src/**/*'] }, null, 2),
			// #38 coverage: a typed-Props .astro outside `include`, pulled in via
			// a relative import, plus global `Astro` in value position and
			// `<Fragment>` — all resolve only while astro's plugin-injected
			// ambient roots (additionalFiles) survive snapshot rebuilds. On
			// bridge.7 the first rebuild dropped them: TS2304 'Fragment' +
			// TS2708 namespace-'Astro'-as-value on this file.
			'src/page.astro': `---
import Widget from '../packages/ui/Widget.astro';
const base = Astro.site;
const target = new URL(base ?? '/x', Astro.url);
---
<Widget title="hi" />
<Fragment set:html={target} />
`,
			'packages/ui/Widget.astro': `---
interface Props { title: string }
const { title } = Astro.props;
---
<div>{title}</div>
`,
		},
		run: (dir) => execFileSync('npx', ['astro', 'check'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		check(out, outStock) {
			const t = stripAnsi(out);
			if (/ts\(2304\):\s*Cannot find name 'Fragment'/.test(t)) return "false positive: global Fragment unresolved (#38 — plugin ambient roots dropped on snapshot rebuild)";
			if (/ts\(2708\):\s*Cannot use namespace 'Astro' as a value/.test(t)) return "false positive: global Astro value-side unresolved (#38)";
			const norm = (s) => stripAnsi(s)
				.replace(/[^\n]*TNB ACTIVE[^\n]*\n?/g, '') // TNB banner line
				.replace(/\d{2}:\d{2}:\d{2}/g, 'TT:TT:TT')
				.replace(/\d+(?:\.\d+)?m?s\b/g, 'Xms');
			const a = norm(out).trim(), b = norm(outStock).trim();
			if (a !== b) return `output mismatch vs stock:\n--- tnb ---\n${a}\n--- stock ---\n${b}`;
			return undefined;
		},
	},
};

function ensureStock() {
	if (fs.existsSync(path.join(stockDir, 'package', 'lib', 'typescript.js'))) return;
	fs.mkdirSync(stockDir, { recursive: true });
	execSync('npm pack typescript@6.0.3 --silent', { cwd: stockDir, stdio: 'ignore' });
	execSync('tar -xzf typescript-6.0.3.tgz', { cwd: stockDir, stdio: 'ignore' });
}

function ensureCase(name, def) {
	const dir = path.join(cacheRoot, name);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	for (const [rel, content] of Object.entries(def.files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
	const pkg = {
		name: `tnb-fw-${name}`, private: true, type: 'module',
		dependencies: { ...def.deps, typescript: `file:${repoRoot}` },
	};
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
	if (!fs.existsSync(path.join(dir, 'node_modules'))) {
		console.log(`[${name}] installing deps (first run)…`);
		execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: 'inherit' });
	}
	return dir;
}

function runCase(name, def) {
	const dir = ensureCase(name, def);
	const tsLink = path.join(dir, 'node_modules', 'typescript');
	const linkTo = (target) => { fs.rmSync(tsLink, { force: true, recursive: true }); fs.symlinkSync(target, tsLink); };
	linkTo(repoRoot);
	let outTnb;
	try { outTnb = def.run(dir); } catch (e) { outTnb = (e.stdout ?? '') + (e.stderr ?? ''); }
	linkTo(path.join(stockDir, 'package'));
	let outStock;
	try { outStock = def.run(dir); } catch (e) { outStock = (e.stdout ?? '') + (e.stderr ?? ''); }
	linkTo(repoRoot);
	const problem = def.check(outTnb, outStock);
	if (problem) {
		console.error(`[${name}] FAIL: ${problem}`);
		return false;
	}
	console.log(`[${name}] ok`);
	return true;
}

ensureStock();
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(CASES);
let ok = true;
for (const name of names) {
	const def = CASES[name];
	if (!def) { console.error(`unknown case: ${name}`); ok = false; continue; }
	try { ok = runCase(name, def) && ok; }
	catch (e) { console.error(`[${name}] FAIL: ${e.message}`); ok = false; }
}
console.log(ok ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(ok ? 0 : 1);
