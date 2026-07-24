#!/usr/bin/env node
/**
 * RemoteNode jsDoc must accept stock's lazy-init assignment (`node.jsDoc ??= []`).
 * Stock nodes are plain objects with a writable jsDoc field; the vendored
 * RemoteNode exposed a getter-only accessor, so services/jsDoc's
 * `node.jsDoc ?? (node.jsDoc = [])` threw "only a getter" (tsdown d.ts emit).
 * The patched accessor caches the assigned value and still falls back to the
 * computed getter when nothing was assigned.
 *
 * Usage: node tools/triage-jsdoc-assignment.mjs
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const { RemoteNode } = require(path.join(repoRoot, 'vendor', 'native-preview', 'dist', 'api', 'node', 'node.js'));
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));
const { SyntaxKind } = require(path.join(repoRoot, 'vendor', 'native-preview', 'dist', 'ast', 'index.js')); // vendored enum, NOT the fork's remapped one

// The accessor patch installs lazily with the bridge session hooks, so
// engage the bridge once (watch/builder program) before checking the
// descriptor.
import * as fs from 'node:fs';
import * as os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-jsdoc-wit-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
fs.writeFileSync(path.join(dir, 'a.ts'), 'export const x: number = 1;\n');
const NOOP = () => {};
const host = ts.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, ts.sys, ts.createAbstractBuilder, NOOP, NOOP);
host.watchFile = () => ({ close: NOOP });
host.watchDirectory = () => ({ close: NOOP });
host.setTimeout = undefined; host.clearTimeout = undefined;
let builder; host.afterProgramCreate = b => { builder = b; };
const watch = ts.createWatchProgram(host);
(builder ?? watch.getProgram()).getProgram().getTypeChecker();
watch.close?.();

const desc = Object.getOwnPropertyDescriptor(RemoteNode.prototype, 'jsDoc');
const failures = [];
if (typeof desc?.set !== 'function') {
	failures.push('RemoteNode.prototype.jsDoc has no setter');
}

if (failures.length === 0) {
	// Getter-only RemoteNode with no JSDoc children: assignment must stick.
	const bare = Object.create(RemoteNode.prototype);
	bare.hasChildren = () => false;
	try {
		bare.jsDoc ?? (bare.jsDoc = []);
		if (!Array.isArray(bare.jsDoc) || bare.jsDoc.length !== 0) failures.push(`assigned value not cached: ${JSON.stringify(bare.jsDoc)}`);
		bare.jsDoc.push({ fakeTag: true });
		if (bare.jsDoc.length !== 1) failures.push('pushes into the cached array are lost');
	} catch (e) {
		failures.push(`assignment threw: ${e.message}`);
	}

	// Unassigned node: the computed getter must still answer from children.
	const jdChild = { _rawKind: SyntaxKind.JSDoc, next: undefined };
	const withDoc = Object.create(RemoteNode.prototype);
	withDoc.hasChildren = () => true;
	withDoc.getOrCreateChildAtNodeIndex = () => jdChild;
	const computed = withDoc.jsDoc;
	if (!Array.isArray(computed) || computed[0] !== jdChild) failures.push('computed getter broken after the patch');
}

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok RemoteNode jsDoc accepts lazy-init assignment (computed getter preserved)');
