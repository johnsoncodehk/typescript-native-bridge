#!/usr/bin/env node
/**
 * updateSnapshot openFilesWithContent with a Windows drive-letter absolute
 * path (D:/...) must file the overlay at that path, not at cwd + "/" + path.
 *
 * Pre-fix (volar win32 CI): handleUpdateSnapshot's absolute check was
 * `strings.HasPrefix(fileName, "/")` — a drive-letter path "fails" it, so the
 * cwd got prepended and every Volar .vue overlay landed on a garbage path
 * while the real file kept its raw disk text ("is not a module",
 * getConstructSignatures/getCallSignatures → 0 in component-meta). On POSIX
 * hosts absolute paths start with "/" so the bug never fired.
 *
 * Usage: node tools/triage-win-drive-overlay.mjs [bridge.node path]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const addon = require2(process.argv[2] ?? path.join(repoRoot, 'native', 'bridge.node'));
process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-win-drive-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['**/*'] }));

const h = addon.newSession(dir);
if (!h) { console.error('newSession failed'); process.exit(1); }
const H = BigInt(h);
const call = (method, params) => {
	const r = addon.call(H, method, params == null ? null : JSON.stringify(params));
	return typeof r === 'string' ? JSON.parse(r) : r;
};
call('initialize', null);
const snap = call('updateSnapshot', {
	openProjects: [path.join(dir, 'tsconfig.json')],
	openFilesWithContent: [{ fileName: 'D:/tnb-win-drive/component.ts', content: 'export const Foo = 1;\n', scriptKind: 3 }],
});
// A drive-letter path has no containing tsconfig here, so it lands in the
// inferred project — what matters is that its name stays intact (no cwd
// prepend). Pre-fix it surfaced as `${cwd}/D:/tnb-win-drive/component.ts`.
const allNames = (snap.projects ?? []).flatMap(p => p.rootFiles ?? []);
const garbage = allNames.filter(n => n.includes(dir));
const wanted = allNames.filter(n => /^\w:\/tnb-win-drive\/component\.ts$/i.test(n) || n === 'd:/tnb-win-drive/component.ts');
const failures = [];
if (garbage.length) failures.push(`overlay filed under prepended cwd: ${JSON.stringify(garbage)}`);
if (!wanted.length) failures.push(`drive-letter overlay name mangled or missing: ${JSON.stringify(allNames)}`);
if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok drive-letter absolute overlay path stays intact (no cwd prepend)');
