#!/usr/bin/env node
/** Dump template-scope properties for _failed_directives/main.vue */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const ts = require(process.env.TYPESCRIPT_PATH ?? path.join(volarRoot, 'node_modules/typescript'));
const vuePath = path.join(volarRoot, 'test-workspace/tsc/_failed_directives/main.vue');
const cfg = path.join(volarRoot, 'test-workspace/tsc/tsconfig.json');

const parsed = ts.getParsedCommandLineOfConfigFile(cfg, {}, {
	...ts.sys,
	getCurrentDirectory: () => path.dirname(cfg),
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
		getCanonicalFileName: f => f,
		getCurrentDirectory: () => path.dirname(cfg),
		getNewLine: () => '\n',
	})); },
});
const program = ts.createProgram({ rootNames: [...parsed.fileNames, vuePath], options: parsed.options });
const sf = program.getSourceFile(vuePath);
const checker = program.getTypeChecker();
const pos = sf.getText().indexOf('notExist');
const node = ts.getTokenAtPosition(sf, pos);
const type = checker.getContextualType(node) ?? checker.getTypeAtLocation(node.parent);
const props = type ? checker.getPropertiesOfType(type).map(p => p.name).sort() : [];
console.log('engine:', require.resolve('typescript/package.json').includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('typeToString:', type ? checker.typeToString(type) : 'none');
console.log('properties:', props.join(', '));
console.log('has exist:', props.includes('exist'));
console.log('has Comp:', props.includes('Comp'));
