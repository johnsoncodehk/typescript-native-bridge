#!/usr/bin/env node
/**
 * Compare projectInfo + testFn for #5847 with/without projectRootPath and configure.
 */
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
const tsContent = `export function testFn() { console.log('testFn'); }`;
const vueContent = `
<script setup></script>

<template>{{ testFn| }}</template>
`;
const offset = vueContent.indexOf('|');
const vueFileContent = vueContent.slice(0, offset) + vueContent.slice(offset + 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function summarizeTestFn(testFn) {
	if (!testFn) return null;
	return {
		kind: testFn.kind,
		kindModifiers: testFn.kindModifiers,
		sortText: testFn.sortText,
		source: testFn.source,
		hasAction: testFn.hasAction,
		isFromUncheckedFile: testFn.isFromUncheckedFile,
	};
}

async function runCase(label, { withRoot, withConfigure, seqOpen }) {
	return withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
		if (withConfigure) {
			await send('configure', {
				preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
			});
		}
		const mkOpen = (file, content) => ({
			file,
			fileContent: content,
			...(withRoot ? { projectRootPath: testWorkspacePath } : {}),
		});
		if (seqOpen) {
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [mkOpen(fixtureTs, tsContent)] });
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [mkOpen(fixtureVue, vueFileContent)] });
		}
		else {
			await send('updateOpen', {
				changedFiles: [], closedFiles: [],
				openFiles: [mkOpen(fixtureTs, tsContent), mkOpen(fixtureVue, vueFileContent)],
			});
		}
		const pi = await send('projectInfo', { file: fixtureVue, needFileNameList: false });
		const comp = await send('completions', { file: fixtureVue, position: offset });
		const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
		const testFn = entries.find(e => e.name === 'testFn');
		return {
			label,
			success: comp?.success,
			projectName: pi?.body?.projectName,
			projectKind: pi?.body?.projectKind,
			fileNames: pi?.body?.fileNames?.length,
			testFn: summarizeTestFn(testFn),
		};
	});
}

const cases = [
	['vitest', { withRoot: false, withConfigure: false, seqOpen: true }],
	['+root', { withRoot: true, withConfigure: false, seqOpen: true }],
	['+cfg', { withRoot: false, withConfigure: true, seqOpen: true }],
	['harness', { withRoot: true, withConfigure: true, seqOpen: false }],
];

for (const [label, opts] of cases) {
	const r = await runCase(label, opts);
	console.log(JSON.stringify(r));
}
