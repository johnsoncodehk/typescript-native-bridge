#!/usr/bin/env node
/** Run batch populate diag for empty.vue or css.ts via tsserver verbose log. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const fixture = process.argv[2] ?? 'empty.vue';
const volarRoot = resolveVolarRoot();
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const logFile = `/tmp/tnb-importability-batch-${fixture.replace(/[^\w.]/g, '_')}.log`;
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const fixtures = {
	'empty.vue': {
		file: path.join(volarRoot, 'test-workspace/tsconfigProject/empty.vue'),
		root: path.join(volarRoot, 'test-workspace'),
		content: `<template></template>`,
		pos: 0,
		useCompletions: true,
	},
	'css.ts': {
		file: path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts'),
		root: volarRoot,
		content: fs.readFileSync(path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts'), 'utf8'),
		pos: null,
		useCompletions: false,
	},
};
const fx = fixtures[fixture];
if (!fx) throw new Error(`unknown fixture ${fixture}`);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
];

try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ }

await withTsserver({ tsserverPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
	await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: fx.file, fileContent: fx.content, projectRootPath: fx.root }] });
	if (fx.useCompletions) {
		await send('completions', { file: fx.file, position: fx.pos });
	} else {
		const offset = fx.content.length;
		const line = fx.content.slice(0, offset).split('\n').length;
		const col = offset - fx.content.lastIndexOf('\n', offset - 1);
		await send('completionInfo', { file: fx.file, line, offset: col, includeExternalModuleExports: true, includeInsertTextCompletions: true });
	}
});

const log = fs.readFileSync(logFile, 'utf8');
const line = log.split('\n').find(l => l.includes('batchPopulateDiag:'));
if (!line) { console.log('no batchPopulateDiag in', logFile); process.exit(1); }
const diag = JSON.parse(line.slice(line.indexOf('batchPopulateDiag:') + 'batchPopulateDiag:'.length).trim());

const received = diag.filter(d => d.blocked === 'received');
const processed = diag.filter(d => d.blocked !== 'received');
console.log('fixture:', fx.file);
console.log('batch.modules received:', received.length);
console.log('populate loop processed:', processed.length);

const BLACKLIST = ['@vue/compiler-sfc', '@vue/reactivity', 'alien-signals'];
function pkgRoot(s) {
	const m = String(s).match(/^(@[^/]+\/[^/]+|[^./@][^/]*)/);
	return m ? m[1] : s;
}
for (const pkg of BLACKLIST) {
	const recv = received.filter(d => pkgRoot(d.specifier).startsWith(pkg) || pkgRoot(d.rawModule ?? '').startsWith(pkg));
	const blocked = processed.filter(d => d.blocked === 'transitiveOnlyBlacklist' && (d.specifier.includes(pkg) || (d.rawModule ?? '').includes(pkg)));
	const expRecv = recv.reduce((a, r) => a + r.named + (r.default ? 1 : 0), 0);
	const expBlk = blocked.reduce((a, r) => a + r.named + (r.default ? 1 : 0), 0);
	console.log(`${pkg}: received modules=${recv.length} exports=${expRecv}; blacklist-blocked exports=${expBlk}`);
}

const otherTransitive = processed.filter(d => d.blocked === 'transitiveOnlyBlacklist' && !BLACKLIST.some(p => d.specifier.includes(p)));
console.log('other blacklist blocks:', otherTransitive.map(d => `${d.specifier}(${d.named + (d.default?1:0)})`).join(', ') || 'none');

fs.writeFileSync(`/tmp/tnb-importability-batch-diag-${fixture}.json`, JSON.stringify({ received, processed }, null, 2));
console.log('written:', `/tmp/tnb-importability-batch-diag-${fixture}.json`);
