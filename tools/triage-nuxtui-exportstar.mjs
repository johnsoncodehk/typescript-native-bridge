#!/usr/bin/env node
/**
 * Witness for issue #26: `import type { TableColumn } from '<pkg>'` must not
 * report TS2614 when the package's d.ts chain reaches a `.vue` specifier that
 * has an on-disk `X.d.vue.ts` declaration next to the SFC (the @nuxt/ui
 * pattern: dist ships `Table.vue` + `Table.vue.d.ts` + `Table.d.vue.ts`).
 *
 * Stock order for `./X.vue`: `X.d.vue.ts` first (a Volar host substitutes the
 * SFC at that same probe when no declaration exists), then `X.vue.ts/.tsx/
 * .d.ts`. The bridge resolver must not let the literal SFC win — its virtual
 * TS has only a default export, which erases every named type and surfaces
 * TS2614 at the import site.
 *
 * A `.vue` root with plain-TS content registers `.vue` as an extra extension
 * with tsgo (what Volar does via extraFileExtensions) without needing a vue
 * toolchain; `X.d.vue.ts` vs `X.vue.d.ts` carry different `TableColumn`
 * shapes so the assertion also proves which declaration won.
 *
 * Exit 0: resolution matches stock. Exit 1: divergence (TS2614 or wrong winner).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(repoRoot, 'bin', 'tsc');
const fixture = '/tmp/tnb-triage-nuxtui-exportstar';
const pkg = path.join(fixture, 'node_modules', 'fake-nuxt-ui');

function write(rel, content) {
	const file = path.join(fixture, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

fs.rmSync(fixture, { recursive: true, force: true });

write('node_modules/fake-nuxt-ui/package.json', JSON.stringify({
	name: 'fake-nuxt-ui',
	version: '1.0.0',
	type: 'module',
	exports: { '.': { types: './dist/module.d.mts', import: './dist/module.mjs' } },
}, null, 2));

// Same shape as @nuxt/ui dist/module.d.mts: named types arrive only through
// the export* chain; the module itself adds a default export.
write('node_modules/fake-nuxt-ui/dist/module.d.mts', `
export * from './runtime/types/index.js';
declare const _default: { plugin: true };
export { _default as default };
`);

write('node_modules/fake-nuxt-ui/dist/runtime/types/index.d.ts', `
export * from '../components/Table.vue';
`);

// The SFC on disk next to its declarations. Content is plain TS — under
// vue-tsc this file's virtual TS likewise exports only the default component.
write('node_modules/fake-nuxt-ui/dist/runtime/components/Table.vue', `
declare const component: { sfc: true };
export default component;
`);

// Arbitrary-extensions declaration — stock's first probe and the winner there.
write('node_modules/fake-nuxt-ui/dist/runtime/components/Table.d.vue.ts', `
export type TableColumn = { marker: 'from-d-vue-ts' };
declare const component: { sfc: true };
export default component;
`);

// Classic appended declaration — a different shape so a wrong winner fails
// the consumer's assignment instead of passing silently.
write('node_modules/fake-nuxt-ui/dist/runtime/components/Table.vue.d.ts', `
export type TableColumn = { marker: 'from-vue-d-ts' };
declare const component: { sfc: true };
export default component;
`);

write('main.ts', `
import type { TableColumn } from 'fake-nuxt-ui';
export const col: TableColumn = { marker: 'from-d-vue-ts' };
`);

// Registers ".vue" as a host extra extension with tsgo (Volar's role). Plain
// TS content keeps the raw parse clean; only the extension matters here.
write('Component.vue', `
export default {};
`);

write('tsconfig.json', JSON.stringify({
	compilerOptions: {
		target: 'esnext',
		module: 'esnext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	},
	files: ['main.ts', 'Component.vue'],
}, null, 2));

let out = '';
let code = 0;
try {
	out = execFileSync(process.execPath, [tsc, '-p', path.join(fixture, 'tsconfig.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
	code = e.status ?? 1;
	out = String(e.stdout ?? '') + String(e.stderr ?? '');
}

const diags = out.split('\n').filter((l) => /error TS/.test(l));
const ts2614 = diags.filter((l) => l.includes('TS2614'));

console.log('=== WITNESS issue-26 nuxtui export* over .vue ===');
console.log(`tsc exit=${code} diagnostics=${diags.length}`);
if (ts2614.length) {
	console.log('FAIL: TS2614 — literal Table.vue (default-only SFC) won over Table.d.vue.ts:');
	for (const l of ts2614) console.log('  ' + l.trim());
	process.exit(1);
}
if (code !== 0 || diags.length) {
	console.log('FAIL: unexpected diagnostics (wrong declaration winner or unrelated breakage):');
	for (const l of diags) console.log('  ' + l.trim());
	process.exit(1);
}
console.log('PASS: TableColumn resolved through Table.d.vue.ts, no TS2614');
