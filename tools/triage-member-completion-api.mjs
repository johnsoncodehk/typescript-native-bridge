/** Program API: which checker call hangs for `foo.` member completion? */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-api-'));
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
const fooPos = content.indexOf('foo');

function timed(label, fn) {
	const t0 = Date.now();
	try {
		const r = fn();
		console.log(`${label}: ${Date.now() - t0}ms ok=${r !== undefined}`);
		return r;
	} catch (e) {
		console.log(`${label}: ${Date.now() - t0}ms ERR ${e.message}`);
	}
}

const fooNode = ts.getTokenAtPosition(sf, fooPos);
const dotNode = ts.getTokenAtPosition(sf, dotPos);
console.log('foo token:', ts.SyntaxKind[fooNode.kind], fooNode.getText(sf));
console.log('dot token:', ts.SyntaxKind[dotNode.kind], dotNode.getText(sf));

const type = timed('getTypeAtLocation(foo)', () => checker.getTypeAtLocation(fooNode));
if (type) {
	timed('type.getApparentProperties()', () => type.getApparentProperties());
	timed('getPropertiesOfType', () => checker.getPropertiesOfType(type));
	timed('getSignaturesOfType(call)', () => checker.getSignaturesOfType(type, ts.SignatureKind.Call));
	timed('type.getCallSignatures()', () => type.getCallSignatures());
	timed('type.getStringIndexType()', () => type.getStringIndexType());
}

timed('getCompletionsAtPosition', () => ts.getCompletionsAtPosition(sf, dotPos, undefined, undefined, undefined, checker));

fs.rmSync(tmpDir, { recursive: true, force: true });
