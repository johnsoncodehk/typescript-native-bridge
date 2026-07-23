#!/usr/bin/env node
/**
 * Boolean literal types must carry stock's intrinsicName ('true'/'false').
 * Stock models boolean literals as IntrinsicType (intrinsicName set, no
 * value); tsgo models them as LiteralType with a bool value, and the bridge
 * only filled IntrinsicName for TypeFlagsIntrinsic — so `false`'s
 * intrinsicName crossed as null (issue #22). The fix fills it in the
 * Freshable branch of newTypeResponse; arena reads the same TypeResponse
 * field (arena.go off+88), so JSON and arena transports stay aligned.
 *
 * Usage: node tools/triage-bool-literal-intrinsic.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require2(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-bool-intr-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler' },
	include: ['a.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), `declare const fLit: false;
declare const tLit: true;
declare const sLit: "text";
declare const nLit: 42;
`);

const NOOP = () => {};
const host = ts.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, ts.sys, ts.createAbstractBuilder, NOOP, NOOP);
host.watchFile = () => ({ close: NOOP });
host.watchDirectory = () => ({ close: NOOP });
host.setTimeout = undefined;
host.clearTimeout = undefined;
let builder;
host.afterProgramCreate = b => { builder = b; };
const watch = ts.createWatchProgram(host);
const program = (builder ?? watch.getProgram()).getProgram();
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path.join(dir, 'a.ts'));

const failures = [];
for (const st of sf.statements) {
	const name = st.declarationList.declarations[0].name.text;
	const t = checker.getTypeAtLocation(st.declarationList.declarations[0].name);
	const want = { fLit: 'false', tLit: 'true', sLit: undefined, nLit: undefined }[name];
	if (t.intrinsicName !== want) {
		failures.push(`${name}: intrinsicName=${JSON.stringify(t.intrinsicName)}, want ${JSON.stringify(want)}`);
	}
}
watch.close?.();
if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log("ok boolean literal intrinsicName is 'true'/'false' (stock parity); string/number literals stay undefined");
