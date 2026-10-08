#!/usr/bin/env node
/**
 * Witness: package-json auto-imports keep `isPackageJsonImport` on completion
 * entry DATA, not just the entry. Details round-trips data alone; without the
 * flag its resolver checks the main program instead of the provider and fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsserverPath = path.join(repoRoot, 'lib', 'tsserver.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-packagejson-autoimport-'));
const pkg = path.join(root, 'node_modules', 'pathe');
const main = path.join(root, 'main.ts');
const content = 'join;\n';

fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(main, content);
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { pathe: '*' } }));
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' }, include: ['*.ts'] }));
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
	name: 'pathe', types: './index.d.ts',
}));
fs.writeFileSync(path.join(pkg, 'index.d.ts'), 'export declare function join(...paths: string[]): string;\n');

const preferences = { includePackageJsonAutoImports: 'on' };
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
			offset: 5,
			includeExternalModuleExports: true,
		});
		const entry = completion.body?.entries?.find(candidate => candidate.name === 'join');
		if (!entry?.source) throw new Error('completionInfo did not return a sourced join entry');
		if (!entry.data?.tnbCompletionData) throw new Error('completionInfo did not preserve native completion resolve data');
		if (!entry.data.isPackageJsonImport) throw new Error('completion entry data lost isPackageJsonImport');

		const details = await send('completionEntryDetails', {
			file: main,
			line: 1,
			offset: 5,
			includeExternalModuleExports: true,
			entryNames: [{ name: entry.name, source: entry.source, data: entry.data }],
			preferences,
		});
		if (!details.success) throw new Error(details.message || 'completionEntryDetails failed');
		const edit = details.body?.[0]?.codeActions?.flatMap(action => action.changes ?? [])
			.filter(change => change.fileName === main)
			.flatMap(change => change.textChanges ?? [])
			.find(change => change.newText.includes('join') && change.newText.includes('pathe'));
		if (!edit) throw new Error('completionEntryDetails returned no pathe import edit');
		return { source: entry.source, edit: edit.newText };
	});
	console.log(`ok package-json auto-import completion details: ${JSON.stringify(result)}`);
}
finally {
	fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
