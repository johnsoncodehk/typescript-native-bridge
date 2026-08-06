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
const main = path.join(fixture, 'src', 'main.ts');
const model = path.join(fixture, 'src', 'model.ts');

fs.mkdirSync(path.dirname(main), { recursive: true });
fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ include: ['./src/*.ts'] }));
fs.writeFileSync(main, 'ReadRecordModel;\n');
fs.writeFileSync(model, 'export const ReadRecordModel = {};\n');

try {
	const result = await withTsserver({
		tsserverPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
		env: tnbHarnessEnv(),
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
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
		const entry = completion.body?.entries?.find(candidate => candidate.name === 'ReadRecordModel' && candidate.source === './model');
		if (!entry) throw new Error('completionInfo did not return ReadRecordModel from ./model');

		const details = await send('completionEntryDetails', {
			file: main,
			line: 1,
			offset: 16,
			entryNames: [{ name: entry.name, source: entry.source, data: entry.data }],
		});
		if (!details.success) throw new Error(details.message || 'completionEntryDetails failed');
		const changes = details.body?.[0]?.codeActions?.flatMap(action => action.changes ?? []) ?? [];
		const importEdit = changes
			.filter(change => change.fileName === main)
			.flatMap(change => change.textChanges ?? [])
			.find(change => change.newText.includes('ReadRecordModel') && change.newText.includes('./model'));
		if (!importEdit) throw new Error('completionEntryDetails returned no ./model import edit');
		return { data: entry.data, edit: importEdit.newText };
	});
	console.log(`ok project-local auto-import details: ${JSON.stringify(result)}`);
}
finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
process.exit(0);
