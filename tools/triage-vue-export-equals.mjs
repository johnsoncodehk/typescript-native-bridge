#!/usr/bin/env node
/**
 * Compare vue module export enumeration via checker API (stock vs TNB).
 * GODEBUG=asyncpreemptoff=1 node tools/triage-vue-export-equals.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = process.env.TYPESCRIPT_PATH
	?? path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const testWorkspace = path.join(volarRoot, 'test-workspace/tsconfigProject');
const configPath = path.join(testWorkspace, 'tsconfig.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-vue-exports-'));
const probeFile = path.join(tmpDir, 'probe.ts');
fs.writeFileSync(probeFile, `import * as vue from 'vue';\nexport { vue };\n`);

const parsed = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		getCurrentDirectory: () => testWorkspace,
		onUnRecoverableConfigFileDiagnostic: d => {
			throw new Error(ts.formatDiagnostic(d, {
				getCanonicalFileName: f => f,
				getCurrentDirectory: () => testWorkspace,
				getNewLine: () => '\n',
			}));
		},
	},
);

const rootNames = [...parsed.fileNames, probeFile];
const program = ts.createProgram({
	rootNames,
	options: parsed.options,
	projectReferences: parsed.projectReferences,
});
const checker = program.getTypeChecker();

const probeSf = program.getSourceFile(probeFile);
const importDecl = probeSf.statements[0].moduleSpecifier;
const vueModSym = checker.getSymbolAtLocation(importDecl);
if (!vueModSym) {
	console.error('no vue module symbol');
	process.exit(1);
}

const names = [];
checker.forEachExportAndPropertyOfModule(vueModSym, (_s, k) => names.push(k));
names.sort();

const exportsArr = checker.getExportsOfModule(vueModSym) ?? [];
const exportNames = exportsArr.map(s => s.name ?? s.escapedName).filter(Boolean).sort();

console.log('typescript:', tsPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('forEachExportAndPropertyOfModule count:', names.length);
console.log('getExportsOfModule count:', exportNames.length);
console.log('has defineComponent:', names.includes('defineComponent'));
console.log('has Fragment:', names.includes('Fragment'));
console.log('has withScopeId:', names.includes('withScopeId'));
console.log('has BaseTransition:', names.includes('BaseTransition'));
console.log('sample named exports:', exportNames.slice(0, 8));
console.log('sample all exports:', names.filter(n => ['defineComponent', 'h', 'ref', 'BaseTransition', 'Fragment', 'withScopeId', 'default', 'export='].includes(n)));

// Resolve export= path diagnostics
try {
	const resolved = checker.resolveExternalModuleSymbol?.(vueModSym);
	console.log('resolveExternalModuleSymbol changed:', resolved !== vueModSym, 'resolved name:', resolved?.name ?? resolved?.escapedName);
	if (resolved && resolved !== vueModSym) {
		const t = checker.getTypeOfSymbol(resolved);
		const props = checker.getPropertiesOfType?.(t) ?? [];
		console.log('export= type properties count:', props.length);
		console.log('export= props sample:', props.slice(0, 5).map(p => p.name ?? p.escapedName));
	}
} catch (err) {
	console.log('resolveExternalModuleSymbol error:', err?.message ?? err);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
