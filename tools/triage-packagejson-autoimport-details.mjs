#!/usr/bin/env node
/**
 * Witness: package-json auto-imports keep stock provenance through details.
 * The provider entry (`ufo`) carries the flag on entry AND data; a subpath
 * already in the host program (`ufo/host`) does not. Details round-trips data
 * alone, so the data flag is what selects the resolver's program.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsserverPath = path.join(repoRoot, 'lib', 'tsserver.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-packagejson-autoimport-'));
const pkg = path.join(root, 'node_modules/ufo');
const main = path.join(root, 'main.ts');
const host = path.join(root, 'host.ts');
const content = 'joinURL;\n';
const preferences = { includePackageJsonAutoImports: 'on' };

fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
fs.writeFileSync(main, content);
fs.writeFileSync(host, 'import { parsePath } from "ufo/host";\nparsePath;\n');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { ufo: '*' } }));
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
	include: ['*.ts'],
}));
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
	name: 'ufo',
	exports: {
		'.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
		'./host': { types: './dist/host.d.ts', import: './dist/host.mjs' },
	},
}));
fs.writeFileSync(path.join(pkg, 'dist/index.d.ts'), 'export declare function joinURL(...paths: string[]): string;\n');
fs.writeFileSync(path.join(pkg, 'dist/index.mjs'), 'export function joinURL() {}\n');
fs.writeFileSync(path.join(pkg, 'dist/host.d.ts'), 'export declare function parsePath(path: string): string;\nexport declare function joinURL(path: string): string;\n');
fs.writeFileSync(path.join(pkg, 'dist/host.mjs'), 'export function parsePath() {}\nexport function joinURL() {}\n');

try {
	const result = await withTsserver({
		tsserverPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
		env: tnbHarnessEnv(),
	}, async ({ send }) => {
		await send('configure', { preferences });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: main, fileContent: content, projectRootPath: root }] });
		const completion = await send('completionInfo', {
			file: main,
			line: 1,
			offset: 8,
			includeExternalModuleExports: true,
		});
		const bySource = new Map((completion.body?.entries ?? [])
			.filter(item => item.name === 'joinURL')
			.map(item => [item.source, item]));
		const expected = new Map([
			['ufo', true],
			['ufo/host', false],
		]);
		if (bySource.size !== expected.size || ![...expected.keys()].every(source => bySource.has(source))) {
			throw new Error(`expected joinURL from ${[...expected.keys()].join(' + ')}, got ${[...bySource.keys()].join(' + ')}`);
		}

		const results = [];
		for (const [source, expectedFlag] of expected) {
			const item = bySource.get(source);
			if (Boolean(item.isPackageJsonImport) !== expectedFlag || Boolean(item.data?.isPackageJsonImport) !== expectedFlag) {
				throw new Error(`${source}: flags=[${Boolean(item.isPackageJsonImport)}, ${Boolean(item.data?.isPackageJsonImport)}], want [${expectedFlag}, ${expectedFlag}]`);
			}
			if (expectedFlag && !item.data?.tnbCompletionData) throw new Error(`${source}: lost native completion resolve data`);

			const details = await send('completionEntryDetails', {
				file: main,
				line: 1,
				offset: 8,
				includeExternalModuleExports: true,
				entryNames: [{ name: item.name, source: item.source, data: item.data }],
				preferences,
			});
			if (!details.success) throw new Error(details.message || `${source}: completionEntryDetails failed`);
			const edit = details.body?.[0]?.codeActions?.flatMap(action => action.changes ?? [])
				.filter(change => change.fileName === main)
				.flatMap(change => change.textChanges ?? [])
				.find(change => change.newText.includes(`from "${source}"`));
			if (!edit) throw new Error(`${source}: completionEntryDetails returned no import edit`);
			results.push({ source, edit: edit.newText });
		}
		return results;
	});
	console.log(`ok package-json auto-import completion details: ${JSON.stringify(result)}`);
}
finally {
	fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
