#!/usr/bin/env node
/** Family-1 witness: tnb-empty-display */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(toolsDir, 'triage-f1-run-case.mjs'), "tnb-empty-display"], { stdio: 'inherit' });
process.exit(r.status ?? 1);
