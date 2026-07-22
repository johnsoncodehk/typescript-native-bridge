#!/usr/bin/env node
/**
 * Empty-string literal values across the arena transport (issue #16).
 * Go's string intern maps "" to the absent id; the JS arena decoder must still
 * surface "" for a valueKind-tagged slot (literal type .value) and for present
 * strArray elements (template literal type .texts). Exercises the watch/builder
 * program path, which is where parserOptions.project consumers (typescript-estree)
 * hit the arena decoder.
 *
 * Usage: node tools/triage-empty-literal.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('../lib/typescript.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-empty-lit-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', types: [], skipLibCheck: true },
	include: ['*.ts'],
}));
const srcText = `declare const foo: Record<string, () => void>;
export const handler = foo[''];
export declare const lead: \`\${string}b\`;
export declare const trail: \`a\${string}\`;
`;
fs.writeFileSync(path.join(dir, 'src.ts'), srcText);

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
const sf = program.getSourceFile(path.join(dir, 'src.ts'));

const failures = [];
const visit = node => {
	if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === '') {
		const t = checker.getTypeAtLocation(node.argumentExpression);
		if (!t.isStringLiteral() || t.value !== '') failures.push(`empty literal: flags=${t.flags} isStringLiteral=${t.isStringLiteral?.()} value=${JSON.stringify(t.value)}`);
	}
	if (ts.isVariableDeclaration(node) && (node.name.text === 'lead' || node.name.text === 'trail')) {
		const t = checker.getTypeAtLocation(node.name);
		const want = node.name.text === 'lead' ? ['', 'b'] : ['a', ''];
		if (!Array.isArray(t.texts) || t.texts.length !== 2 || t.texts[0] !== want[0] || t.texts[1] !== want[1]) {
			failures.push(`${node.name.text} template texts: got ${JSON.stringify(t.texts)}, want ${JSON.stringify(want)}`);
		}
	}
	ts.forEachChild(node, visit);
};
visit(sf);
watch.close?.();

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok empty literal value + template texts (watch/builder arena path)');
