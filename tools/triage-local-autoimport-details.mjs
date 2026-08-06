#!/usr/bin/env node
/**
 * Issue #58: a project-local auto-import completion must resolve to an import
 * edit when its entry data is sent back through completionEntryDetails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsserverPath = path.join(repoRoot, 'lib', 'tsserver.js');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-local-autoimport-'));
const main = path.join(fixture, 'server', 'utils', 'main.ts');
const model = path.join(fixture, 'server', 'models', 'model.ts');

fs.mkdirSync(path.dirname(main), { recursive: true });
fs.mkdirSync(path.dirname(model), { recursive: true });
fs.mkdirSync(path.join(fixture, '.config'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './.config/tsconfig.app.json' }] }));
fs.writeFileSync(path.join(fixture, '.config', 'tsconfig.app.json'), JSON.stringify({
	compilerOptions: {
		module: 'preserve',
		moduleResolution: 'bundler',
		paths: { '#server/*': ['../server/*'] },
	},
	include: ['../server/**/*.ts'],
}));
fs.writeFileSync(main, 'ReadRecordModel;\n');
fs.writeFileSync(model, 'export const ReadRecordModel = {};\n');

try {
	const result = await withTsserver({
		tsserverPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
		env: tnbHarnessEnv(),
	}, async ({ send }) => {
		const preferences = {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
			importModuleSpecifierPreference: 'relative',
		};
		await send('configure', {
			preferences,
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: main, fileContent: 'ReadRecordModel;\n', projectRootPath: fixture }],
		});

		const completion = await send('completionInfo', {
			file: main,
			line: 1,
			offset: 16,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		const entry = completion.body?.entries?.find(candidate => candidate.name === 'ReadRecordModel');
		if (!entry?.source) throw new Error('completionInfo did not return a sourced ReadRecordModel entry');
		if (!entry.data?.tnbCompletionData) throw new Error('completionInfo did not preserve native completion resolve data');

		const details = await send('completionEntryDetails', {
			file: main,
			line: 1,
			offset: 16,
			entryNames: [{ name: entry.name, source: entry.source, data: entry.data }],
			preferences,
		});
		if (!details.success) throw new Error(details.message || 'completionEntryDetails failed');
		const changes = details.body?.[0]?.codeActions?.flatMap(action => action.changes ?? []) ?? [];
		const importEdit = changes
			.filter(change => change.fileName === main)
			.flatMap(change => change.textChanges ?? [])
			.find(change => change.newText.includes('ReadRecordModel') && change.newText.includes(entry.source));
		if (!importEdit) throw new Error(`completionEntryDetails returned no ${entry.source} import edit`);
		return { source: entry.source, edit: importEdit.newText };
	});
	console.log(`ok native auto-import completion details: ${JSON.stringify(result)}`);
}
finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
process.exit(0);
