#!/usr/bin/env node
/**
 * Witness f2hl-export-star: documentHighlights on an import reached through
 * `export *`. Stock keeps the binder's ExportSpecifier.symbol while walking the
 * re-export; TNB's RemoteNode-backed declaration lacked that field, so FAR
 * aborted and the IDE saw no highlights.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-f2hl-export-star-'));
const pkg = path.join(fixture, 'node_modules/tnb-fixture-pkg');
const shared = path.join(fixture, 'node_modules/tnb-fixture-shared');
fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
fs.mkdirSync(path.join(shared, 'dist'), { recursive: true });

fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
	name: 'tnb-fixture-pkg', version: '0.0.0', types: './dist/index.d.ts',
}));
fs.writeFileSync(path.join(pkg, 'dist/index.d.ts'), 'export * from "tnb-fixture-shared";\n');
fs.writeFileSync(path.join(shared, 'package.json'), JSON.stringify({
	name: 'tnb-fixture-shared', version: '0.0.0', types: './dist/index.d.ts',
}));
fs.writeFileSync(path.join(shared, 'dist/index.d.ts'), 'declare const starExportTarget: () => void;\nexport { starExportTarget };\n');
fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true },
}));

const file = path.join(fixture, 'main.ts');
const text = 'import { starExportTarget } from "tnb-fixture-pkg";\nstarExportTarget();\n';
fs.writeFileSync(file, text);

const positions = [text.indexOf('starExportTarget'), text.indexOf('starExportTarget', 10)];

async function run(tsserverPath, env) {
	return withTsserver({
		tsserverPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
		env,
		volarRoot,
		deadlineMs: 120_000,
	}, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file, fileContent: text, projectRootPath: fixture }],
		});
		return Promise.all(positions.map(async position => {
			const highlights = await send('documentHighlights', {
				file, line: 1, offset: position + 1, filesToSearch: [file],
			});
			return [...new Set((highlights?.body ?? []).flatMap(item =>
				item.highlightSpans.map(span =>
					`${span.start.line}:${span.start.offset}:${span.end.offset - span.start.offset}`),
			))].sort();
		}));
	});
}

console.log('=== WITNESS f2hl-export-star (highlights through `export *`) ===');
const tnb = await run(tnbPath, tnbHarnessEnv());
const stock = await run(stockPath, process.env);
const match = JSON.stringify(tnb) === JSON.stringify(stock);
if (!match) {
	console.log(`TNB   ${JSON.stringify(tnb)}`);
	console.log(`STOCK ${JSON.stringify(stock)}`);
}
console.log(match ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(match ? 0 : 1);
