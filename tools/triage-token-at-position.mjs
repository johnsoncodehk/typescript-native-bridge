/** Compare getTokenAtPosition: skeleton vs tsgo-backed SourceFile */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-tok-'));
const testFile = path.join(tmpDir, 'app.ts');
const tsconfig = path.join(tmpDir, 'tsconfig.json');
const content = 'const foo = 1;\nfoo.\n';
fs.writeFileSync(testFile, content);
fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }));

const stockSf = ts.createSourceFile(testFile, content, ts.ScriptTarget.Latest, true);
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => tmpDir,
	onUnRecoverableConfigFileDiagnostic: () => {},
});
const program = ts.createProgram({
	rootNames: [testFile],
	options: { ...parsed.options, configFilePath: tsconfig },
});
const tsgoSf = program.getSourceFile(testFile);
const dotPos = content.indexOf('foo.') + 4;

function show(label, sf) {
	for (const pos of [dotPos - 1, dotPos]) {
		const tok = ts.getTokenAtPosition(sf, pos);
		console.log(`${label} pos=${pos} char=${JSON.stringify(content[pos] ?? '')} -> ${ts.SyntaxKind[tok.kind]} ${JSON.stringify(tok.getText?.(sf) ?? '')}`);
	}
}
console.log('same object?', stockSf === tsgoSf);
show('stock', stockSf);
show('tsgo-program', tsgoSf);

fs.rmSync(tmpDir, { recursive: true, force: true });
