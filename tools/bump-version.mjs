#!/usr/bin/env node
/**
 * Bump package version. Format: <stock>-bridge.<N>.tsgo.<tsgo>
 *
 *   stock = typescript submodule package.json version (JS API/protocol base —
 *           must stay inside ecosystem peer ranges, e.g. typescript-eslint
 *           `>=4.8.4 <6.1.0`; also the number VS Code version-gates on)
 *   tsgo  = typescript-go submodule's nearest `typescript/v*` tag
 *
 * Rules:
 *   - stock or tsgo base changed vs current version → reset to `bridge.0`
 *   - otherwise                                    → `bridge.<N+1>`
 *
 * Usage: node tools/bump-version.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'package.json');
const VERSION_RE = /^(\d+\.\d+\.\d+)-bridge\.(\d+)\.tsgo\.(\d+\.\d+\.\d+)$/;

export function computeNext(current, stock, tsgo) {
	const m = VERSION_RE.exec(current);
	if (!m) throw new Error(`current version ${JSON.stringify(current)} does not match <stock>-bridge.<N>.tsgo.<tsgo>`);
	const [, curStock, n, curTsgo] = m;
	const next = curStock === stock && curTsgo === tsgo ? Number(n) + 1 : 0;
	return `${stock}-bridge.${next}.tsgo.${tsgo}`;
}

export function readStockVersion(repo = REPO) {
	const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'typescript/package.json'), 'utf8'));
	if (!pkg.version) throw new Error('typescript/package.json has no version field');
	return pkg.version;
}

export function readTsgoVersion(repo = REPO) {
	let tag;
	try {
		tag = execFileSync('git', ['describe', '--tags', '--match', 'typescript/v*', '--abbrev=0'], {
			cwd: path.join(repo, 'typescript-go'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} catch (e) {
		throw new Error(`cannot resolve typescript-go version tag (typescript/v*): ${e.stderr?.trim() || e.message}`);
	}
	const v = tag.replace(/^typescript\/v/, '');
	if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`unexpected typescript-go tag ${JSON.stringify(tag)}`);
	return v;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dryRun = process.argv.includes('--dry-run');
	const raw = fs.readFileSync(PKG, 'utf8');
	const current = JSON.parse(raw).version;
	const stock = readStockVersion();
	const tsgo = readTsgoVersion();
	const next = computeNext(current, stock, tsgo);
	console.log(`stock=${stock} tsgo=${tsgo}`);
	console.log(`${current} -> ${next}${dryRun ? ' (dry-run)' : ''}`);
	if (!dryRun) {
		if (next === current) { console.log('already up to date'); process.exit(0); }
		const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
		if (updated === raw) throw new Error('failed to locate version field in package.json');
		fs.writeFileSync(PKG, updated);
		execFileSync('npm', ['i'], { cwd: REPO, stdio: 'inherit' });
	}
}
