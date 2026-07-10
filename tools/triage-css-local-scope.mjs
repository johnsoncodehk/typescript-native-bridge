#!/usr/bin/env node
/**
 * Compare stock vs TNB scope/completion for local `css` namespace alias at css.ts EOF.
 *
 * Usage:
 *   node tools/triage-css-local-scope.mjs
 *   node tools/triage-css-local-scope.mjs --harness
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = new Set(process.argv.slice(2));
const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const pos = content.length;
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const line = content.slice(0, pos).split('\n').length;
const col = pos - content.lastIndexOf('\n', pos - 1);

function probeScope(label, tsPath) {
	const ts = require(tsPath);
	const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
		...ts.sys,
		getCurrentDirectory: () => volarRoot,
		onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); },
	});
	const host = {
		getCompilationSettings: () => parsed.options,
		getCurrentDirectory: () => volarRoot,
		getScriptFileNames: () => [...new Set([...parsed.fileNames, cssTs])],
		getProjectVersion: () => '1',
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		getCanonicalFileName: f => f,
		useCaseSensitiveFileNames: () => true,
		getDefaultLibFileName: o => ts.getDefaultLibFileName(o),
		getScriptVersion: () => '1',
		getScriptSnapshot: f => {
			const text = f === cssTs ? content : ts.sys.readFile(f);
			return text != null ? ts.ScriptSnapshot.fromString(text) : undefined;
		},
	};
	const ls = ts.createLanguageService(host);
	const program = ls.getProgram();
	const sf = program.getSourceFile(cssTs);
	const checker = program.getTypeChecker();
	const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;
	const syms = checker.getSymbolsInScope(sf, meaning);
	const css = syms.find(s => s.name === 'css');
	console.log(`\n${label} getSymbolsInScope css=${css ? 'yes' : 'NO'} total=${syms.length}`);
	if (css) {
		const aliased = checker.getAliasedSymbol(css);
		const combined = ts.getCombinedLocalAndExportSymbolFlags(aliased);
		console.log(`  flags=0x${(css.flags >>> 0).toString(16)} aliased=0x${(aliased.flags >>> 0).toString(16)} combinedValue=${!!(combined & ts.SymbolFlags.Value)}`);
		console.log(`  inFile=${css.declarations?.some(d => d.getSourceFile() === sf)} objectRegistry=${!!css.objectRegistry}`);
	}
}

async function probeHarness(label, tsserverPath, env) {
	return withTsserver({
		tsserverPath,
		args: [
			'--disableAutomaticTypingAcquisition',
			'--globalPlugins', '@vue/typescript-plugin',
			'--pluginProbeLocations', path.join(volarRoot, 'packages/language-server'),
			'--suppressDiagnosticEvents',
		],
		env,
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: cssTs, fileContent: content, projectRootPath: volarRoot }],
		});
		const comp = await send('completionInfo', {
			file: cssTs,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		const entries = comp?.body?.entries ?? [];
		const css = entries.find(e => e.name === 'css');
		const local = entries.filter(e => !e.source);
		console.log(`\n${label} completion css=${css ? 'yes' : 'NO'} local=${local.length} total=${entries.length}`);
		if (css) {
			console.log(`  source=${css.source ?? '(local)'} sortText=${css.sortText} kind=${css.kind}`);
		}
	});
}

console.log('css.ts:', cssTs);

const tnbPkg = path.join(volarRoot, 'node_modules/typescript');
probeScope('TNB-LS', tnbPkg);

const stockPkg = process.env.STOCK_TSSERVER_PATH?.replace(/\/lib\/tsserver\.js$/, '') ?? '/tmp/stock-ts-p3/package';
if (fs.existsSync(path.join(stockPkg, 'typescript.js')) || fs.existsSync(path.join(stockPkg, 'lib/tsserver.js'))) {
	try {
		probeScope('STOCK-LS', stockPkg);
	} catch (e) {
		console.error('STOCK-LS failed:', e.message);
	}
}

if (args.has('--harness') || args.size === 0) {
	const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
	await probeHarness('TNB-harness', tnbPath, tnbHarnessEnv());
	const stockPath = '/tmp/stock-ts-p3/package/lib/tsserver.js';
	if (fs.existsSync(stockPath)) {
		await probeHarness('STOCK-harness', stockPath, process.env);
	}
}
