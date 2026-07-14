#!/usr/bin/env node
/** Family-1 witness: alias-expand-vs-compact */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(toolsDir, 'triage-f1-run-case.mjs'), "alias-expand-vs-compact"], { stdio: 'inherit' });
process.exit(r.status ?? 1);
