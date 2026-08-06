#!/usr/bin/env node
/**
 * Completion replacement-span parity for the issue #55 edit sequence.
 *
 * Two composite projects include the same source file + declaration file.
 * Delete a line, retype it one character at a time, complete after the
 * identifier. The optionalReplacementSpan must stay within the typed line —
 * a cross-line span means the serving project computed positions against
 * stale source text (reported on bridge.10 as 4:18 → 5:23).
 *
 * Self-contained: creates the project under os.tmpdir(), drives the local
 * lib/tsserver.js over stdio, asserts the span. @types/node is best-effort
 * (the span logic is token-position based, independent of the symbol set).
 *
 * Usage: node tools/triage-completion-span-i55.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsserver = path.join(root, 'lib', 'tsserver.js');

const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`  • ${msg}`); };

// ── Project layout (issue #55) ──────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-i55-'));
const mk = (rel, content) => { const p = path.join(tmpDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
mk('tsconfig.json', JSON.stringify({
	references: [{ path: './first/tsconfig.json' }, { path: './.secondary/tsconfig.json' }],
	files: [],
}));
mk('first/tsconfig.json', JSON.stringify({
	compilerOptions: { composite: true, types: ['node'] },
	include: ['../repro.ts', '../.secondary/empty.d.ts'],
}));
mk('.secondary/tsconfig.json', JSON.stringify({
	compilerOptions: { composite: true, types: ['node'] },
	include: ['../repro.ts', './empty.d.ts'],
}));
mk('.secondary/empty.d.ts', 'export {};\n');
const original = `import { Buffer } from "node:buffer";

export function encode(value: string) {
  const actual = Buffer.from(value);

  return actual.toString("base64url");
}
`;
mk('repro.ts', original);

// Best-effort @types/node (network; failure is not fatal — the span assertion
// is token-position based).
try {
	fs.mkdirSync(path.join(tmpDir, 'node_modules'));
	execFileSync('npm', ['install', '--no-save', '@types/node@26.1.1', '--silent'], { cwd: tmpDir, stdio: 'ignore', timeout: 120_000 });
} catch {
	/* optional */
}

// ── Drive tsserver (issue's exact sequence) ────────────────────────────────
const mainFile = path.join(tmpDir, 'repro.ts');
const child = spawn(process.execPath, [tsserver, '--noGetErrOnBackgroundUpdate'], {
	cwd: tmpDir,
	env: process.env,
	stdio: ['pipe', 'pipe', 'pipe'],
});
let seq = 0;
let stdout = Buffer.alloc(0);
let stderr = '';
const pending = new Map();
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (stderr += c));
child.stdout.on('data', (c) => {
	stdout = Buffer.concat([stdout, c]);
	for (;;) {
		const headerEnd = stdout.indexOf('\r\n\r\n');
		if (headerEnd < 0) return;
		const m = /Content-Length: (\d+)/i.exec(stdout.subarray(0, headerEnd).toString('ascii'));
		if (!m) return;
		const len = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (stdout.length < bodyStart + len) return;
		const msg = JSON.parse(stdout.subarray(bodyStart, bodyStart + len).toString('utf8'));
		stdout = stdout.subarray(bodyStart + len);
		if (msg.type === 'response') pending.get(msg.request_seq)?.(msg);
	}
});
const request = (command, args) => new Promise((resolve, reject) => {
	const s = ++seq;
	child.stdin.write(JSON.stringify({ seq: s, type: 'request', command, arguments: args }) + '\n');
	const timer = setTimeout(() => { pending.delete(s); reject(new Error(`${command} timed out`)); }, 30_000);
	pending.set(s, (r) => { clearTimeout(timer); pending.delete(s); resolve(r); });
});

const line = 4;
const typed = '  const actual = B';
try {
	await request('configure', {
		hostInfo: 'tnb-i55-fixture',
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
			includePackageJsonAutoImports: 'auto',
		},
	});
	await request('open', { file: mainFile, fileContent: original, projectRootPath: tmpDir });
	const projectInfo = await request('projectInfo', { file: mainFile, needFileNameList: false });

	await request('change', { file: mainFile, line, offset: 1, endLine: line + 1, endOffset: 1, insertString: '' });
	let offset = 1;
	for (const char of typed) {
		await request('change', { file: mainFile, line, offset, endLine: line, endOffset: offset, insertString: char });
		offset += char.length;
	}
	const response = await request('completionInfo', {
		file: mainFile, line, offset, triggerKind: 1,
		includeExternalModuleExports: true, includeInsertTextCompletions: true,
	});

	const span = response.body?.optionalReplacementSpan;
	const serving = projectInfo.body?.configFileName;
	console.log(`serving=${serving ?? 'n/a'} entries=${response.body?.entries?.length ?? 0} span=${span ? `${span.start.line}:${span.start.offset} → ${span.end.line}:${span.end.offset}` : 'none'}`);

	if (!span) {
		fail('completion returned no optionalReplacementSpan');
	}
	else if (span.end.line !== span.start.line) {
		fail(`optionalReplacementSpan crosses lines: ${span.start.line}:${span.start.offset} → ${span.end.line}:${span.end.offset} (expected same-line 4:18 → 4:19)`);
	}
	else if (span.start.line !== line) {
		fail(`optionalReplacementSpan on wrong line: ${span.start.line} (expected ${line})`);
	}
	else if (span.start.offset !== 18 || span.end.offset !== 19) {
		fail(`optionalReplacementSpan mismatch: ${span.start.line}:${span.start.offset} → ${span.end.line}:${span.end.offset} (expected 4:18 → 4:19)`);
	}
	else {
		console.log(`check:completion-span-i55 ok (${serving ?? 'n/a'})`);
	}
	if (stderr) console.error(stderr.slice(0, 600));
}
catch (e) {
	fail(`fixture error: ${e.message}`);
}
finally {
	child.stdin.end();
	await new Promise((r) => child.once('exit', r));
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (errors.length) {
	console.error('\ncheck:completion-span-i55 failed:\n');
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}
