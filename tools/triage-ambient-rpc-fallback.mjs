#!/usr/bin/env node
/**
 * T4 witness: getAmbientModuleBatch prefers Checker.getAmbientModules and
 * falls back to getModuleExportMap when the RPC method throws.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

const npPath = path.join(repoRoot, 'vendor/native-preview/dist/api/sync/api.js');
if (!fs.existsSync(npPath)) {
	console.error(JSON.stringify({ ok: false, error: `native-preview not built: ${npPath}` }));
	process.exit(1);
}

const np = require(npPath);
let fallbackCalls = 0;
let ambientRpcCalls = 0;
const origAmbient = np.Checker.prototype.getAmbientModules;
const origExportMap = np.Checker.prototype.getModuleExportMap;

np.Checker.prototype.getAmbientModules = function patchedGetAmbientModules() {
	ambientRpcCalls++;
	throw new Error('T4 witness: forced getAmbientModules throw');
};
np.Checker.prototype.getModuleExportMap = function patchedGetModuleExportMap(...args) {
	fallbackCalls++;
	return origExportMap.apply(this, args);
};

const ts = require(path.join(repoRoot, 'lib/typescript.js'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ambient-fallback-'));
const ambientName = 'tnb-ambient-witness';
const ambientDts = path.join(tmpDir, 'ambient.d.ts');
const testFile = path.join(tmpDir, 'app.ts');
const tsconfig = path.join(tmpDir, 'tsconfig.json');

fs.writeFileSync(ambientDts, `declare module "${ambientName}" {\n  export const value: number;\n}\n`);
fs.writeFileSync(testFile, `import { value } from "${ambientName}";\nexport { value };\n`);
fs.writeFileSync(tsconfig, JSON.stringify({
	include: ['*.ts', '*.d.ts'],
	compilerOptions: { strict: true, moduleResolution: 'node10', types: [] },
}, null, 2));

let threw = true;
let ambientHit = false;
let ambientModuleCount = 0;
let tryFindHit = false;

try {
	const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
		...ts.sys,
		getCurrentDirectory: () => tmpDir,
		onUnRecoverableConfigFileDiagnostic: d => {
			throw new Error(ts.formatDiagnostic(d, {
				getCanonicalFileName: f => f,
				getCurrentDirectory: () => tmpDir,
				getNewLine: () => '\n',
			}));
		},
	});
	const rootNames = [...new Set([...parsed.fileNames, testFile, ambientDts])];
	const program = ts.createProgram({
		rootNames,
		options: { ...parsed.options, configFilePath: tsconfig },
	});
	const checker = program.getTypeChecker();
	const ambientModules = checker.getAmbientModules();
	ambientModuleCount = ambientModules.length;
	const names = ambientModules.map(sym => ts.unescapeLeadingUnderscores(sym.name));
	ambientHit = names.some(n => n === `"${ambientName}"` || n === ambientName);
	const found = checker.tryFindAmbientModule(ambientName);
	tryFindHit = !!found;
	threw = false;
} catch (e) {
	console.error(JSON.stringify({
		ok: false,
		threw: true,
		error: e?.message ?? String(e),
		ambientRpcCalls,
		fallbackCalls,
	}, null, 2));
	process.exit(1);
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

const result = {
	ok: !threw && fallbackCalls > 0 && ambientHit && tryFindHit,
	threw,
	ambientRpcCalls,
	fallbackCalls,
	ambientModuleCount,
	ambientHit,
	tryFindHit,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
