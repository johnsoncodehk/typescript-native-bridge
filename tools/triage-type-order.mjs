#!/usr/bin/env node
/**
 * Dump union member order + typeToString for component-meta failures.
 * Usage: GODEBUG=asyncpreemptoff=1 node tools/triage-type-order.mjs
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = process.env.TYPESCRIPT_PATH
	?? path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

function dumpUnion(label, type, checker) {
	if (!type || !checker.isUnionType(type)) {
		console.log(`${label}: not a union`);
		return;
	}
	const members = type.types ?? type.getTypes?.() ?? [];
	const names = members.map(t => checker.typeToString(t));
	console.log(`${label}: count=${members.length}`);
	console.log('  typeToString:', checker.typeToString(type));
	console.log('  members:', names.join(' | '));
}

async function runCase(name, vueRel, propName) {
	const comp = path.join(volarRoot, vueRel);
	const cfgDir = path.dirname(comp);
	const cfg = path.join(cfgDir, 'tsconfig.json');
	const parsed = ts.getParsedCommandLineOfConfigFile(cfg, {}, {
		...ts.sys,
		getCurrentDirectory: () => cfgDir,
		onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
			getCanonicalFileName: f => f,
			getCurrentDirectory: () => cfgDir,
			getNewLine: () => '\n',
		})); },
	});
	const program = ts.createProgram({ rootNames: [...parsed.fileNames, comp], options: parsed.options });
	const checker = program.getTypeChecker();
	const sf = program.getSourceFile(comp);
	if (!sf?.symbol) {
		console.log(name, ': no module symbol');
		return;
	}
	const mod = checker.getModuleSymbolForSourceFile?.(sf) ?? checker.getMergedSymbol(sf.symbol);
	const exports = checker.getExportsOfModule(mod);
	let targetSym;
	for (const sym of exports) {
		if (sym.name === 'default' || sym.escapedName === 'default') {
			targetSym = sym;
			break;
		}
	}
	if (!targetSym) {
		console.log(name, ': no default export');
		return;
	}
	const t = checker.getTypeOfSymbolAtLocation(targetSym, sf);
	const props = checker.getPropertiesOfType(t);
	const prop = props.find(p => p.name === propName);
	if (!prop) {
		console.log(name, ': prop not found', propName, 'have', props.map(p => p.name).slice(0, 20));
		return;
	}
	const pt = checker.getTypeOfSymbol(prop);
	console.log(`\n=== ${name} / ${propName} ===`);
	console.log('prop type:', checker.typeToString(pt));
	dumpUnion('prop type union', pt, checker);
}

console.log('typescript:', require.resolve('typescript/package.json').includes('typescript-native-bridge') ? 'TNB' : 'stock');

await runCase('reference-type-model', 'test-workspace/component-meta/reference-type-model/component.vue', 'barModifiers');
await runCase('reference-type-props', 'test-workspace/component-meta/reference-type-props/component.vue', 'nestedOptional');
