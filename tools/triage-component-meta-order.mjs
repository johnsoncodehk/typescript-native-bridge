#!/usr/bin/env node
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = process.env.TYPESCRIPT_PATH ?? path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);
const { createChecker, createCheckerByJson } = await import(pathToFileURL(path.join(volarRoot, 'packages/component-meta/index.js')).href);

const comp = path.join(volarRoot, 'test-workspace/component-meta/reference-type-model/component.vue');
const tsconfig = path.join(volarRoot, 'test-workspace/component-meta/tsconfig.json');
const metaRoot = path.join(volarRoot, 'test-workspace/component-meta');
const checkerOptions = { schema: { ignore: ['MyIgnoredNestedProps'] }, printer: { newLine: 1 } };

for (const [label, checker] of [
	['w/ tsconfig', createChecker(tsconfig, checkerOptions)],
	['w/o tsconfig', createCheckerByJson(metaRoot, { extends: '../tsconfig.base.json', include: ['**/*'] }, checkerOptions)],
]) {
	const meta = checker.getComponentMeta(comp);
	const p = meta.props.find(x => x.name === 'barModifiers');
	const engine = require.resolve('typescript/package.json').includes('typescript-native-bridge') ? 'TNB' : 'stock';
	console.log(`\n=== ${label} (${engine}) ===`);
	console.log('type:', p?.type);
	console.log('schema.type:', p?.schema?.type);
	console.log('schema.schema:', JSON.stringify(p?.schema?.schema));
}
