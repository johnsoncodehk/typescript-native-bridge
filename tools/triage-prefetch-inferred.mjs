#!/usr/bin/env node
/**
 * updateSnapshot with prefetchDiagnostics must not panic when the session's
 * project collection also holds a non-configured (inferred) project.
 *
 * Pre-fix (CI win32 leg, volar #component-meta run): handleUpdateSnapshot's
 * prefetch loop called proj.ConfigFilePath() on EVERY project in the
 * collection — including inferred ones — and panicked
 * ("ConfigFilePath called on non-configured project", session.go:1523),
 * killing the whole bridge session mid-run. The loop now skips
 * non-configured projects; an orphan open file (no containing tsconfig) is
 * what puts an inferred project into the collection.
 *
 * Usage: node tools/triage-prefetch-inferred.mjs [bridge.node path]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const addon = require2(process.argv[2] ?? path.join(repoRoot, 'native', 'bridge.node'));
process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-prefetch-inferred-'));
for (const proj of ['a', 'b']) {
	fs.mkdirSync(path.join(dir, proj), { recursive: true });
	fs.writeFileSync(
		path.join(dir, proj, 'tsconfig.json'),
		JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }),
	);
	fs.writeFileSync(path.join(dir, proj, 'index.ts'), `export const ${proj} = 1;\n`);
}
// Orphan: outside every tsconfig — lands in the inferred project when opened.
fs.writeFileSync(path.join(dir, 'orphan.ts'), 'export const orphan = 1;\n');

const h = addon.newSession(dir);
if (!h) { console.error('newSession failed'); process.exit(1); }
const H = BigInt(h);
const call = (method, params) => {
	const r = addon.call(H, method, params == null ? null : JSON.stringify(params));
	return typeof r === 'string' ? JSON.parse(r) : r;
};
call('initialize', null);

// The panic path: prefetch over a collection that already holds the inferred
// project. Pre-fix the Go runtime panics here and the process never returns.
call('updateSnapshot', {
	openProjects: [path.join(dir, 'a', 'tsconfig.json')],
	openFiles: [path.join(dir, 'orphan.ts')],
	prefetchDiagnostics: true,
});
call('updateSnapshot', {
	openProjects: [path.join(dir, 'a', 'tsconfig.json'), path.join(dir, 'b', 'tsconfig.json')],
	prefetchDiagnostics: true,
});
console.log('ok prefetchDiagnostics skips non-configured (inferred) projects');
