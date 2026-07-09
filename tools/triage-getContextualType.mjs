/** Isolate getContextualType hang for `foo.|` */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ctx-'));
const testFile = path.join(tmpDir, 'app.ts');
const content = 'const foo = 1;\nfoo.\n';
fs.writeFileSync(testFile, content);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

const cfg = ts.parseConfigFileTextToJson('tsconfig.json', fs.readFileSync(path.join(tmpDir, 'tsconfig.json'), 'utf8'));
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, tmpDir);
const program = ts.createProgram({ rootNames: [testFile], options: parsed.options });
const sf = program.getSourceFile(testFile);
const checker = program.getTypeChecker();
const dotPos = content.indexOf('foo.') + 4;

const current = ts.getTokenAtPosition(sf, dotPos);
const prev = current.kind === ts.SyntaxKind.EndOfFileToken
	? ts.getTokenAtPosition(sf, dotPos - 1)
	: current;
console.log('pos', dotPos, 'current', ts.SyntaxKind[current.kind], 'prev', ts.SyntaxKind[prev.kind], prev.getText(sf));

function timed(label, fn, timeoutMs = 10000) {
	return Promise.race([
		Promise.resolve().then(fn),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
	]).then(r => { console.log(`${label}: ok`); return r; }, e => console.log(`${label}: ${e.message}`));
}

await timed('getContextualType(prev, IgnoreNodeInferences)', () => checker.getContextualType(prev, ts.ContextFlags.IgnoreNodeInferences));
await timed('getContextualType(prev)', () => checker.getContextualType(prev));
await timed('getContextualType(parent PAE)', () => {
	const p = prev.parent;
	if (p) return checker.getContextualType(p);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
