#!/usr/bin/env node
/**
 * Go-to-definition through a declaration map must not crash the request.
 *
 * Stock's SourceFileLike contract is getPositionOfLineAndCharacter(line,
 * character, allowEdits?) — allowEdits=true clamps out-of-range coordinates
 * instead of asserting (scanner.ts). The documentPositionMapper that remaps
 * definitions through d.ts.map files (session mapDefinitionInfoLocations →
 * tryGetSourcePosition) decodes EVERY mapping in the map with allowEdits=true.
 * TNB's host-side SourceFile skeletons dropped the allowEdits argument, so
 * stock's clamping call took the strict path, hit Debug.assert, and the whole
 * `definition` request failed (success:false) — goto definition on an import
 * of any such package resolved to nothing while quickinfo still worked.
 *
 * Fixture: synthesized `fake-unified` package (installed in-place by this
 * script — no npm, no network). It reproduces the three conditions of the
 * reported reproduction (unified@11.0.5, whose index.d.ts.map carries a stale
 * generated coordinate 846:313 on a 301-char line):
 *   1. `"exports": "./index.js"` with no types condition — the resolution
 *      shape that leaves lib/index.d.ts un-materialized in the program at
 *      definition time, so the session's remap decodes the map against the
 *      light stub.
 *   2. index.d.ts.map with a mapping whose generated column (50) is past the
 *      end of the generated line it names — the allowEdits clamp path.
 *   3. `//# sourceMappingURL` in index.d.ts — what routes the session mapper
 *      through the declaration map.
 * Dual-engine protocol check: the definition (and definitionAndBoundSpan)
 * from the import specifier must succeed and match stock, landing inside the
 * package's .js body via the map.
 *
 * Stock side: STOCK_TSSERVER_PATH (CI), else /tmp/stock-ts-p3/package/lib/tsserver.js.
 *
 * Usage: node tools/triage-gtd-declmap-allowedits.mjs
 * Exit 0 = parity, 1 = regression.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

// index.js has 3 short lines; the map's single mapping sits on generated line
// 3 (the two leading ';' separators) at column 50, past that line's end.
// VLQ for absolute [col 49, source 0, line 0, col 0] is "iDAAA".
const mappings = ';;iDAAA';

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-gtd-declmap-'));
	const src = path.join(dir, 'src');
	const pkg = path.join(dir, 'node_modules', 'fake-unified');
	fs.mkdirSync(src, { recursive: true });
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
		name: 'consumer', private: true, type: 'module',
		dependencies: { 'fake-unified': '1.0.0' },
	}));
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', types: [], skipLibCheck: true },
		include: ['src'],
	}));
	fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
		name: 'fake-unified', version: '1.0.0', exports: './index.js',
	}));
	fs.writeFileSync(path.join(pkg, 'index.js'), 'export const bar = 1;\n\nexport const baz = 2;\n');
	fs.writeFileSync(path.join(pkg, 'index.d.ts'),
		'export declare function foo(): string;\n//# sourceMappingURL=index.d.ts.map\n');
	fs.writeFileSync(path.join(pkg, 'index.d.ts.map'), JSON.stringify({
		version: 3, file: 'index.js', sources: ['index.js'], names: [], mappings,
	}));
	const consumer = "import { foo } from 'fake-unified';\nexport const p = foo();\n";
	fs.writeFileSync(path.join(src, 'index.ts'), consumer);
	return { dir, file: path.join(src, 'index.ts'), consumer };
}

// Inside the `foo` import specifier (line 1, col 10).
const POS = { line: 1, offset: 10 };
const harnessArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];

// mkdtemp paths can surface as /var/... in one engine and the realpath
// /private/var/... in the other, and TNB canonicalizes payload paths to
// lowercase on case-insensitive hosts (CI is Linux, where none of this
// applies) — compare case-insensitively relative to the fixture dir.
function normDef(d) {
	const f = String(d.file ?? '');
	const i = f.toLowerCase().indexOf(`${fixtureReal.toLowerCase()}/`);
	return {
		file: i >= 0 ? f.slice(i + fixtureReal.length + 1) : f,
		line: d.start?.line, offset: d.start?.offset,
		endLine: d.end?.line, endOffset: d.end?.offset,
		kind: d.kind, name: d.name,
	};
}

async function run(label, tsserverPath, fixture) {
	return withTsserver({ tsserverPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: fixture.file, fileContent: fixture.consumer, projectRootPath: fixture.dir }],
		});
		const def = await send('definition', { file: fixture.file, ...POS });
		const defBound = await send('definitionAndBoundSpan', { file: fixture.file, ...POS });
		return {
			label,
			def: { success: def?.success === true, defs: (def?.body ?? []).map(normDef), message: def?.message?.split('\n')[0] },
			defBound: { success: defBound?.success === true, defs: (defBound?.body?.definitions ?? []).map(normDef) },
		};
	});
}

const fixture = makeFixture();
const fixtureReal = fs.realpathSync(fixture.dir);
const tnb = await run('TNB', tnbPath, fixture);
const stock = await run('STOCK', stockPath, fixture);
fs.rmSync(fixture.dir, { recursive: true, force: true });

const sig = (r) => JSON.stringify([r.def.success, r.def.defs, r.defBound.success, r.defBound.defs]);
const parity = tnb.def.success && tnb.defBound.success && sig(tnb) === sig(stock)
	// The navigation must land in the package body, not fall back to the specifier.
	&& tnb.def.defs.length > 0
	&& tnb.def.defs.every(d => d.file.includes('fake-unified/index.js'));

console.log(`TNB  : ${sig(tnb)}`);
console.log(`STOCK: ${sig(stock)}`);
console.log(`verdict: ${parity ? 'PARITY' : 'DIFF'}`);
if (tnb.def.message) console.log(`TNB definition message: ${tnb.def.message}`);
process.exit(parity ? 0 : 1);
