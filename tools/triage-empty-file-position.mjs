#!/usr/bin/env node
/**
 * Issue #72 witness: an empty file reached through the project service came
 * back with pos/end = -1 — factory.createSourceFile's "synthesized node"
 * marker, which createSkeletonSourceFile never overwrites. The host-snapshot
 * path refused zero-length text (`if (!text.length) return undefined`) and
 * fell through to that skeleton, so `getStart()` on the file failed stock's
 * own assertHasRealPosition and @typescript-eslint/typescript-estree could not
 * convert the program at all (0:0 Parsing error, file never linted). Every
 * other path — createProgram, createWatchProgram, createLanguageService —
 * already returned the parser's (0, 0).
 *
 * The probe drives an in-process tsserver ProjectService (the entry point
 * typescript-estree uses for parserOptions.projectService / `project: true`)
 * over both engines and pins the whole file metadata shape, not just the two
 * numbers: an empty file must be indistinguishable from its stock twin.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 *
 * Usage: node tools/triage-empty-file-position.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const tss = require2(stockTsPath); // stock

const logger = {
	hasLevel: () => false,
	loggingEnabled: () => false,
	write: () => {},
	writeLogFile: () => {},
	info: () => {},
	msg: () => {},
	verbose: () => {},
	startGroup: () => {},
	endGroup: () => {},
	getLevel: () => 0,
};

// One fixture directory per engine: the project service keys projects by
// config path, so a shared directory would hand the second engine the first
// one's cached project.
function makeFixture(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tnb-emptyfile-${tag}-`));
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
		include: ['*.ts'],
		compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', types: [], noEmit: true },
	}));
	fs.writeFileSync(path.join(dir, 'empty.ts'), '');
	fs.writeFileSync(path.join(dir, 'newline.ts'), '\n');
	return dir;
}

function probe(engine, dir) {
	// `ts.sys` is the host the reporters' scripts pass (a real-filesystem
	// project service with no script snapshots). A snapshot-serving host takes
	// a different materialization path that never reaches the synthetic
	// skeleton, so it cannot see this defect.
	const service = new engine.server.ProjectService({
		host: engine.sys,
		logger,
		cancellationToken: engine.server.nullCancellationToken,
		useSingleInferredProject: false,
		useInferredProjectPerProjectRoot: false,
	});

	const out = {};
	for (const name of ['empty.ts', 'newline.ts']) {
		const fileName = path.join(dir, name);
		service.setHostConfiguration({ preferences: { includePackageJsonAutoImports: 'off' } });
		service.openClientFile(fileName, fs.readFileSync(fileName, 'utf8'), undefined, dir);
		const info = service.getScriptInfo(fileName);
		const program = service.getDefaultProjectForFile(info.fileName, true).getLanguageService(true).getProgram();
		const sf = program.getSourceFile(fileName);
		// Every position read is wrapped: pre-fix these throw stock's
		// assertHasRealPosition, and an uncaught throw here would read as a
		// harness crash rather than a recorded drift.
		const read = fn => {
			try { return fn(); }
			catch (error) { return `threw: ${error.message}`; }
		};
		out[name] = {
			pos: sf.pos,
			end: sf.end,
			start: read(() => sf.getStart()),
			fullStart: read(() => sf.getFullStart()),
			textLength: sf.text.length,
			statementCount: sf.statements.length,
			eofPos: sf.endOfFileToken.pos,
			eofEnd: sf.endOfFileToken.end,
		};
		service.closeClientFile(fileName);
	}
	return out;
}

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const tnb = probe(tsb, makeFixture('tnb'));
const stk = probe(tss, makeFixture('stock'));

// Stock is the oracle for the whole record; the empty file's own values are
// pinned literally as well, so a stock change cannot silently relax the gate.
for (const name of ['empty.ts', 'newline.ts']) {
	const a = tnb[name], b = stk[name];
	check(JSON.stringify(a) === JSON.stringify(b),
		`${name}: metadata drift vs stock\n    tnb   = ${JSON.stringify(a)}\n    stock = ${JSON.stringify(b)}`);
}
check(tnb['empty.ts'].pos === 0 && tnb['empty.ts'].end === 0 && tnb['empty.ts'].start === 0,
	`empty.ts: expected the parser's (0, 0) with a real getStart(), got ${JSON.stringify(tnb['empty.ts'])}`);
check(tnb['empty.ts'].pos !== -1 && tnb['empty.ts'].end !== -1,
	'empty.ts: still carries the -1 synthesized-node position');
check(tnb['newline.ts'].pos === 0 && tnb['newline.ts'].end === 1,
	`newline.ts: expected (0, 1), got ${JSON.stringify(tnb['newline.ts'])}`);

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`ok empty-file-position: #72 repro via project service, empty.ts/newline.ts metadata equal to stock (fork ${tsb.version})`);
process.exit(0);
