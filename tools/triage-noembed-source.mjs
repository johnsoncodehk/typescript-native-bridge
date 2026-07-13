#!/usr/bin/env node
// Witness: noembed single source of truth — checker reads TNB_LIB_PATH disk content.
// (a) With TNB_LIB_PATH=<libcopy> (marker appended to lib.es5.d.ts): quickinfo + definition → libcopy
// (b) Without override (default packageRoot/lib): marker unresolved
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const packageLib = path.join(repoRoot, 'lib');

const MARKER = '__TNB_NOEMBED_WITNESS';
const MARKER_DECL = `declare const ${MARKER}: number;`;

function copyDirSync(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, ent.name);
		const d = path.join(dest, ent.name);
		if (ent.isDirectory()) copyDirSync(s, d);
		else fs.copyFileSync(s, d);
	}
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-noembed-'));
const libcopy = path.join(tmpRoot, 'libcopy');
const projDir = path.join(tmpRoot, 'proj');
fs.mkdirSync(projDir, { recursive: true });

copyDirSync(packageLib, libcopy);
const es5Path = path.join(libcopy, 'lib.es5.d.ts');
if (!fs.existsSync(es5Path)) {
	console.error(`missing ${es5Path}`);
	process.exit(1);
}
fs.appendFileSync(es5Path, `\n${MARKER_DECL}\n`);

const aTs = path.join(projDir, 'a.ts');
const aContent = `const x: typeof ${MARKER} = ${MARKER};\n`;
fs.writeFileSync(aTs, aContent);
fs.writeFileSync(path.join(projDir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, lib: ['es5'], noEmit: true },
	files: ['a.ts'],
}, null, 2));

const markerOffset = aContent.indexOf(MARKER) + 1; // 1-based-ish for line/col helper
function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
const pos = offsetToLineCol(aContent, aContent.indexOf(MARKER));

const harnessArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];

async function run(label, envExtra) {
	return withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv(envExtra) }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: aTs, fileContent: aContent, projectRootPath: projDir }],
		});
		const qi = await send('quickinfo', { file: aTs, line: pos.line, offset: pos.offset });
		const def = await send('definition', { file: aTs, line: pos.line, offset: pos.offset });
		const diags = await send('semanticDiagnosticsSync', { file: aTs });
		return {
			label,
			quickinfo: { success: qi?.success, displayString: qi?.body?.displayString },
			definition: { success: def?.success, defs: def?.body ?? [] },
			diags: diags?.body ?? [],
		};
	});
}

const injected = await run('injected', { TNB_LIB_PATH: libcopy });
// Control: force empty so JS loadBridgeDeps falls back to packageRoot/lib (no marker).
const control = await run('control', { TNB_LIB_PATH: '' });

const injDisplay = String(injected.quickinfo.displayString ?? '');
const injDefFile = String(injected.definition.defs?.[0]?.file ?? '');
const injEs5Abs = path.resolve(es5Path);
const injDefAbs = injDefFile ? path.resolve(injDefFile) : '';

const markerOk = injDisplay.includes(MARKER) && injDisplay.includes('number');
const defOk = injDefAbs === injEs5Abs
	&& !injDefFile.includes('bundled://')
	&& !injDefAbs.startsWith(path.resolve(packageLib) + path.sep);
const controlUnresolved = !String(control.quickinfo.displayString ?? '').includes(MARKER)
	|| control.quickinfo.displayString == null
	|| control.diags.some(d => String(d?.text ?? d?.messageText ?? '').includes(MARKER)
		|| String(d?.code) === '2304');

// Broader control: either empty/failed quickinfo OR diagnostics mentioning cannot find name
const ctrlDisplay = control.quickinfo.displayString;
const ctrlHasMarker = typeof ctrlDisplay === 'string' && ctrlDisplay.includes(MARKER);
const ctrlDiagUnresolved = (control.diags ?? []).some(d => {
	const t = typeof d?.messageText === 'string' ? d.messageText
		: (d?.messageText?.messageText ?? d?.text ?? '');
	return /cannot find name|找不到名稱/i.test(String(t)) || String(d?.code) === '2304';
});
const controlOk = !ctrlHasMarker || ctrlDiagUnresolved;
// Prefer: no successful typed quickinfo for the marker
const controlOkStrict = !ctrlHasMarker;

console.log(`tmpRoot=${tmpRoot}`);
console.log(`libcopy=${libcopy}`);
console.log(`packageLib=${packageLib}`);
console.log(`\n=== injected (TNB_LIB_PATH=libcopy) ===`);
console.log(`quickinfo: success=${injected.quickinfo.success} display=${JSON.stringify(injDisplay)}`);
console.log(`definition: success=${injected.definition.success} count=${injected.definition.defs.length}`);
for (const d of injected.definition.defs) console.log(`  -> ${d.file}:${d.start?.line}:${d.start?.offset}`);
console.log(`\n=== control (TNB_LIB_PATH unset → packageRoot/lib) ===`);
console.log(`quickinfo: success=${control.quickinfo.success} display=${JSON.stringify(ctrlDisplay)}`);
console.log(`definition: success=${control.definition.success} count=${control.definition.defs.length}`);
for (const d of control.definition.defs) console.log(`  -> ${d.file}`);
console.log(`diags: ${JSON.stringify((control.diags ?? []).map(d => ({ code: d.code, text: d.messageText ?? d.text })))}`);

const checks = {
	marker_quickinfo: markerOk,
	definition_libcopy: defOk,
	control_unresolved: controlOkStrict,
};
console.log(`\nchecks: ${JSON.stringify(checks)}`);
const pass = markerOk && defOk && controlOkStrict;
console.log(`\nverdict: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
