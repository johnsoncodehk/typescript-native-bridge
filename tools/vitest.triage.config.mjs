import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const require = createRequire(path.join(volarRoot, 'package.json'));
const { defineConfig } = require('vitest/config');

const lsTests = path.join(volarRoot, 'packages/language-server/tests');

export default defineConfig({
	test: {
		root: volarRoot,
		include: [
			path.join(lsTests, 'completions.spec.ts'),
			path.join(lsTests, 'definitions.spec.ts'),
		],
		fileParallelism: false,
		isolate: false,
		setupFiles: [path.resolve(__dirname, 'triage-setup.mjs')],
	},
});
