#!/usr/bin/env node
/**
 * Point volar/vue node_modules/typescript at this repo (TNB).
 * Usage: node tools/link-volar.mjs [VOLAR_ROOT]
 */
import { accessSync, constants, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const volarRoot = process.argv[2] ? path.resolve(process.argv[2]) : resolveVolarRoot();
const tnb = repoRoot;
const tsSlot = path.join(volarRoot, 'node_modules/.pnpm/typescript@6.0.3/node_modules/typescript');
const tsTop = path.join(volarRoot, 'node_modules/typescript');

accessSync(path.join(volarRoot, 'package.json'), constants.R_OK);
accessSync(path.join(tnb, 'lib/typescript.js'), constants.R_OK);

rmSync(tsSlot, { recursive: true, force: true });
symlinkSync(tnb, tsSlot);
rmSync(tsTop, { recursive: true, force: true });
symlinkSync('.pnpm/typescript@6.0.3/node_modules/typescript', tsTop);

console.log(`link-volar: ${tsSlot} -> ${tnb}`);
console.log(`verify: ${path.join(tnb, 'lib/tsserver.js')}`);
