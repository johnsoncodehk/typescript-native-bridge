#!/usr/bin/env node
/**
 * Go-to-definition through a declaration map must not crash the request.
 *
 * Stock's SourceFileLike contract is getPositionOfLineAndCharacter(line,
 * character, allowEdits?) — allowEdits=true clamps out-of-range coordinates
 * instead of asserting (scanner.ts). The documentPositionMapper that remaps
 * definitions through d.ts.map files (session mapDefinitionInfoLocations →
 * tryGetSourcePosition) decodes EVERY mapping in the map with allowEdits=true,
 * and real packages ship maps with generated coordinates past the line end
 * (unified@11.0.5 index.d.ts.map has one: generated 846:313 on a 301-char
 * line). TNB's host-side SourceFile skeletons dropped the allowEdits argument,
 * so stock's clamping call took the strict path, hit Debug.assert, and the
 * whole `definition` request failed (success:false) — goto definition on an
 * import of any such package resolved to nothing while quickinfo still worked.
 *
 * Fixture: unified@11.0.5 (pinned, installed per run) — the reported
 * reproduction. Its index.d.ts.map carries a stale generated coordinate
 * (846:313 on a 301-char line); the mapper decodes EVERY mapping with
 * allowEdits=true, so decoding against the un-materialized light stub is the
 * exact crash path. Dual-engine protocol check: the definition (and
 * definitionAndBoundSpan) from the import specifier must succeed and match
 * stock, landing inside the package's .js body via the map.
 *
 * Stock side: STOCK_TSSERVER_PATH (CI), else /tmp/stock-ts-p3/package/lib/tsserver.js.
 *
 * Usage: node tools/triage-gtd-declmap-allowedits.mjs
 * Exit 0 = parity, 1 = regression.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import ChildProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

// ── Fixture: pinned unified@11.0.5, the reported reproduction ──
// unified ships `"exports": "./index.js"` (no types condition) and an
// index.d.ts.map with a stale generated coordinate (846:313 on a 301-char
// line). That resolution shape is what leaves lib/index.d.ts un-materialized
// in the program at definition time, so the session's remap decodes the map
// against the light stub — every synthesized stand-in package materialized
// fully and could not reach the defect. Installed once per run, pinned.
const UNIFIED_VERSION = '11.0.5';

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-gtd-declmap-'));
	const src = path.join(dir, 'src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
		name: 'consumer', private: true, type: 'module',
		dependencies: { unified: UNIFIED_VERSION },
	}));
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', types: [], skipLibCheck: true },
		include: ['src'],
	}));
	const consumer = "import { unified } from 'unified';\nconst p = unified().use(function() { return ''; });\nexport { p };\n";
	fs.writeFileSync(path.join(src, 'index.ts'), consumer);
	const install = ChildProcess.spawnSync('npm', [
		'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
		`unified@${UNIFIED_VERSION}`,
	], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
	if (install.status !== 0 || !fs.existsSync(path.join(dir, 'node_modules', 'unified', 'lib', 'index.d.ts'))) {
		console.error(`fixture setup failed: npm install unified@${UNIFIED_VERSION}\n${install.stderr ?? ''}${install.stdout ?? ''}`);
		process.exit(2);
	}
	return { dir, file: path.join(src, 'index.ts'), consumer };
}

// Inside the `value` import specifier (line 1, col 10).
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
	&& tnb.def.defs.every(d => d.file.includes('unified/lib/index.js'));

console.log(`TNB  : ${sig(tnb)}`);
console.log(`STOCK: ${sig(stock)}`);
console.log(`verdict: ${parity ? 'PARITY' : 'DIFF'}`);
if (tnb.def.message) console.log(`TNB definition message: ${tnb.def.message}`);
process.exit(parity ? 0 : 1);
