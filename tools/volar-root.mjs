/**
 * Resolve volar/vue checkout for local triage harnesses.
 * Override with VOLAR_ROOT when the repo is not a sibling of typescript-native-bridge.
 */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');

/** @returns {string} Absolute path to volar/vue root */
export function resolveVolarRoot() {
	if (process.env.VOLAR_ROOT) {
		return path.resolve(process.env.VOLAR_ROOT);
	}
	const candidates = [
		path.resolve(repoRoot, '../volar/vue'),
		path.resolve(repoRoot, '../../volar/vue'),
	];
	for (const candidate of candidates) {
		try {
			accessSync(path.join(candidate, 'package.json'), constants.R_OK);
			return candidate;
		} catch {
			// try next layout
		}
	}
	return candidates[0];
}
