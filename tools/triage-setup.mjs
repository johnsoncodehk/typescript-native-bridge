import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const shimPath = path.resolve(__dirname, 'triage-server-shim.ts');
const serverTs = path.join(volarRoot, 'packages/language-server/tests/server.ts');

import { vi } from 'vitest';

vi.mock(serverTs, () => import(shimPath));
