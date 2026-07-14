/**
 * Representative positions for each family-1 secondary displayPattern cluster.
 * Prefer pure .ts when the cluster has a ts tip; else test-workspace .vue.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tw, twFile } from './triage-f1-qi-common.mjs';

const minDir = '/tmp/tnb-f1-min';
fs.mkdirSync(minDir, { recursive: true });

const whitespaceTs = path.join(minDir, 'whitespace.ts');
fs.writeFileSync(
	whitespaceTs,
	`type BaseRow = { value: string; };\nconst x: BaseRow = { value: "a" };\n`,
);

const modulePathTs = path.join(minDir, 'module-path.ts');
fs.writeFileSync(modulePathTs, `import { ref } from "vue";\n const r = ref(1);\n`);

const literalTs = path.join(minDir, 'literal.ts');
fs.writeFileSync(
	literalTs,
	`const StringEmpty = { type: String, default: '' as const };\n`,
);

/** @type {Record<string, { title: string, file: string, line: number, offset: number, vue?: boolean, projectRoot?: string, note?: string }[]>} */
export const CASES = {
	'module-path-display': [
		{
			title: 'ts:import-vue-specifier',
			file: twFile('component-meta/component-name-description/component-ts.ts'),
			line: 1,
			offset: 34,
			vue: true,
			note: 'module "ABS.../vue" vs module "vue"',
		},
		{
			title: 'min-ts:import-vue',
			file: modulePathTs,
			line: 1,
			offset: 22,
			vue: false,
			projectRoot: minDir,
			note: 'isolated /tmp — may MATCH if package name resolves short',
		},
	],
	'whitespace-only': [
		{
			title: 'min-ts:type-literal',
			file: whitespaceTs,
			line: 1,
			offset: 6,
			vue: false,
			projectRoot: minDir,
			note: 'SingleLine emit vs multiline type literal',
		},
		{
			title: 'vue:#4577-BaseRow',
			file: twFile('component-meta/#4577/main.vue'),
			line: 10,
			offset: 46,
			vue: true,
		},
	],
	'truncation-ellipsis-density': [
		{
			title: 'ts:defineComponent-alias',
			file: twFile('component-meta/component-name-description/component-ts.ts'),
			line: 1,
			offset: 10,
			vue: true,
		},
	],
	'type-parameter-enclosing': [
		{
			title: 'vue:#4577-Row',
			file: twFile('component-meta/#4577/main.vue'),
			line: 10,
			offset: 34,
			vue: true,
		},
		{
			title: 'vue:events-T',
			file: twFile('tsc/events/main.vue'),
			line: 50,
			offset: 43,
			vue: true,
		},
	],
	'binding-signature-deep': [
		{
			title: 'vue:generic-default-slot',
			file: twFile('component-meta/generic/component.vue'),
			line: 5,
			offset: 15,
			vue: true,
		},
	],
	'binding-signature-shape': [
		{
			title: 'ts:non-component-default',
			file: twFile('component-meta/non-component/component.ts'),
			line: 1,
			offset: 1,
			vue: true,
		},
	],
	'quoted-property-name': [
		{
			title: 'vue:generic-title-prop',
			file: twFile('component-meta/generic/main.vue'),
			line: 9,
			offset: 25,
			vue: true,
			note: "title? vs 'title'?",
		},
	],
	'generic-args-print': [
		{
			title: 'vue:exactType',
			file: twFile('tsc/#1855/main.vue'),
			line: 2,
			offset: 10,
			vue: true,
		},
	],
	'union-intersection-print': [
		{
			title: 'vue:ref-import',
			file: twFile('component-meta/generic/main.vue'),
			line: 2,
			offset: 10,
			vue: true,
		},
	],
	'alias-expand-vs-compact': [
		{
			title: 'ts:default-export-any-vs-DefineComponent',
			file: twFile('component-meta/component-name-description/component-ts.ts'),
			line: 6,
			offset: 1,
			vue: true,
		},
	],
	'volar-synthetic:other': [
		{
			title: 'vue:withDefaults',
			file: twFile('component-meta/reference-type-props/component-non-ascii.vue'),
			line: 2,
			offset: 1,
			vue: true,
		},
	],
	'volar-synthetic:setup-args': [
		{
			title: 'vue:#3257-components',
			file: twFile('tsc/#3257/main.vue'),
			line: 6,
			offset: 2,
			vue: true,
		},
	],
	'deep-rewrite': [
		{
			title: 'vue:Event-vs-var-Event',
			file: twFile('component-meta/reference-type-exposed/component.vue'),
			line: 6,
			offset: 23,
			vue: true,
		},
	],
	'near-equal-residual': [
		{
			title: 'vue:#3340-FooBar',
			file: twFile('tsc/#3340/main.vue'),
			line: 2,
			offset: 8,
			vue: true,
		},
	],
	'literal-quote-style': [
		{
			title: 'ts:my-props-StringEmpty',
			file: twFile('component-meta/reference-type-props/my-props.ts'),
			line: 114,
			offset: 14,
			vue: true,
		},
		{
			title: 'min-ts:default-empty',
			file: literalTs,
			line: 1,
			offset: 7,
			vue: false,
			projectRoot: minDir,
		},
	],
	'decl-header-print': [
		{
			title: 'ts:MyType-namespace',
			file: twFile('component-meta/reference-type-props/my-props.ts'),
			line: 23,
			offset: 14,
			vue: true,
			note: 'type MyType vs type MyNamespace.MyType',
		},
	],
	'medium-rewrite': [
		{
			title: 'vue:#5106-useAttrs',
			file: twFile('tsc/#5106/main.vue'),
			line: 4,
			offset: 10,
			vue: true,
		},
	],
	'tnb-empty-display': [
		{
			title: 'vue:#5067-T',
			file: twFile('tsc/#5067/comp.vue'),
			line: 6,
			offset: 11,
			vue: true,
		},
	],
	'truncated-or-partial': [
		{
			title: 'vue:defineProps-long',
			file: twFile('component-meta/reference-type-props/component-js-setup.vue'),
			line: 4,
			offset: 1,
			vue: true,
			note: 'nav JSON stock side was truncated; live witness gets full strings',
		},
	],
	'import-path:vue-qualifier': [
		{
			title: 'from-cluster-rep',
			// filled at runtime from summary if present; fallback to a known vue file
			file: twFile('component-meta/#4577/main.vue'),
			line: 10,
			offset: 34,
			vue: true,
			note: 'only ~2 remain after reclass; may overlap type-parameter',
		},
	],
	'success-mismatch': [
		{
			title: 'tnb-fail:#4682-created-T',
			file: twFile('tsc/#4682/main.vue'),
			line: 15,
			offset: 23,
			vue: true,
		},
		{
			title: 'tnb-fail:#4682-mounted-T',
			file: twFile('tsc/#4682/main.vue'),
			line: 19,
			offset: 23,
			vue: true,
		},
		{
			title: 'tnb-fail:#4682-vFunction1-T',
			file: twFile('tsc/#4682/main.vue'),
			line: 24,
			offset: 69,
			vue: true,
		},
		{
			title: 'stock-fail:#4899-vue-module',
			file: twFile('tsc/#4899/main.vue'),
			line: 4,
			offset: 25,
			vue: true,
		},
		{
			title: 'stock-fail:#4899-script-start',
			file: twFile('tsc/#4899/main.vue'),
			line: 6,
			offset: 5,
			vue: true,
		},
		{
			title: 'stock-fail:#4899-script-mid',
			file: twFile('tsc/#4899/main.vue'),
			line: 6,
			offset: 8,
			vue: true,
		},
	],
};

export function slugToFile(slug) {
	return `triage-f1-${slug.replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/:/g, '-')}.mjs`;
}
