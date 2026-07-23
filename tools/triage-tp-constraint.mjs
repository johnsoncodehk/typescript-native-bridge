#!/usr/bin/env node
/**
 * Type-parameter constraints must resolve through the bridge (issue #23).
 *
 * The vendored TypeObject ships its own getConstraint() that only fetches
 * SubstitutionType.substConstraint, so on the tsgo path T.getConstraint()
 * returned undefined for type parameters, and the adapter's
 * getBaseConstraintOfType only handled TypeParameter — constraint-derived
 * indexed accesses never reduced, and type-aware lint rules
 * (no-base-to-string / restrict-template-expressions / no-unsafe-property-key)
 * false-positived on ordinary generic code. The adapter now routes both
 * through Go's getBaseConstraintOfType (stock semantics:
 * Type.getConstraint() === checker.getBaseConstraintOfType(type)).
 *
 * Exercises the watch/builder program path (typescript-estree flavor) where
 * the regression surfaced.
 *
 * Usage: node tools/triage-tp-constraint.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require2(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-tp-constraint-'));
const src = `export const withDirectTypeParam = <T extends string>(name: T) => \`prefix/\${name}\`;
const OBJ = {a: ['x'], b: ['y', 'z']} as const;
type Key = keyof typeof OBJ;
export const withDerivedType = <P extends Key>(lang: [P, (typeof OBJ)[P][number]]) => \`x/\${lang[1]}\`;
`;
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler' },
	include: ['a.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), src);

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

const ids = [];
(function visit(n) { if (ts.isIdentifier(n)) ids.push(n); ts.forEachChild(n, visit); })(sf);

const failures = [];
const nameUse = ids.find(n => n.text === 'name' && n.getStart(sf) > src.indexOf('prefix/'));
const tp = checker.getTypeAtLocation(nameUse);
const c = tp.getConstraint();
if (c?.intrinsicName !== 'string') {
	failures.push(`T.getConstraint() → ${c === undefined ? 'undefined' : JSON.stringify(c.intrinsicName ?? c.flags)}, want 'string'`);
}

const accesses = ids.filter(n => n.text === 'lang').map(n => n.parent).filter(p => p && ts.isElementAccessExpression(p));
const indexed = checker.getTypeAtLocation(accesses[accesses.length - 1]);
const base = checker.getBaseConstraintOfType(indexed);
if (!base?.types || base.types.length !== 3) {
	failures.push(`getBaseConstraintOfType((typeof OBJ)[P][number]) → ${base == null ? String(base) : `flags=${base.flags} types=${base.types?.length ?? '-'}`}, want a 3-member union`);
}

watch.close?.();
if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok type-parameter constraint resolves (getConstraint + getBaseConstraintOfType reduces derived indexed access)');
