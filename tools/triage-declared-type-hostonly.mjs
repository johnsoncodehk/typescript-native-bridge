#!/usr/bin/env node
/**
 * getDeclaredTypeOfSymbol must never return undefined.
 *
 * Stock's getDeclaredTypeOfSymbol is `tryGetDeclaredTypeOfSymbol(symbol) ||
 * errorType`, so a symbol with no resolvable declared type (e.g. a host-bound
 * volar virtual-doc SymbolObject with no tsgo counterpart) still yields the
 * error type. The type-tree plugin (`@ts-type-explorer`) does
 * `'intrinsicName' in type` on the result, so an undefined here crashes the
 * whole tsserver.
 *
 * Usage: node tools/triage-declared-type-hostonly.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const typescriptPath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js'));
const ts = require(typescriptPath);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-declared-type-'));

function write(relativePath, content) {
	const fileName = path.join(fixture, relativePath);
	fs.writeFileSync(fileName, content);
	return fileName;
}

write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['main.ts'] }));
const mainFile = write('main.ts', [
	'export const value = 1;',
	'export class Foo {}',
	'export interface Bar {}',
	'export type Baz = { x: number };',
].join('\n') + '\n');

const logger = {
	hasLevel: () => false,
	loggingEnabled: () => false,
	write: () => {},
	writeLogFile: () => {},
	info: () => {},
	msg: () => {},
	verbose: () => {},
	startGroup: () => {},
	endGroup: () => {},
	getLevel: () => 0,
};

const service = new ts.server.ProjectService({
	host: {
		getCurrentDirectory: () => fixture,
		getExecutingFilePath: () => path.join(path.dirname(typescriptPath), 'tsserver.js'),
		getNodeMajorVersion: () => process.versions.node.split('.')[0],
		getScriptSnapshot: fileName => fs.existsSync(fileName)
			? ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'))
			: undefined,
		getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		getNewLine: () => '\n',
		watchFile: () => ts.Noop,
		watchDirectory: () => ts.Noop,
	},
	logger,
	cancellationToken: ts.server.nullCancellationToken,
	useSingleInferredProject: false,
	useInferredProjectPerProjectRoot: false,
});

try {
	service.openClientFile(mainFile, fs.readFileSync(mainFile, 'utf8'), ts.ScriptKind.TS);
	const [project] = [...service.configuredProjects.values()];
	const languageService = project.getLanguageService();
	const program = languageService.getProgram();
	const checker = program.getTypeChecker();

	// Sanity: a real, tsgo-backed symbol resolves to a concrete type.
	const sf = program.getSourceFile(mainFile);
	const valueNode = sf.statements[0].declarationList.declarations[0].name;
	const realSymbol = checker.getSymbolAtLocation(valueNode);
	if (!realSymbol) throw new Error('real symbol missing');
	const realDeclared = checker.getDeclaredTypeOfSymbol(realSymbol);
	if (realDeclared === undefined || realDeclared === null) {
		throw new Error('real symbol leaked undefined from getDeclaredTypeOfSymbol');
	}

	// Host-bound class/interface/type-alias: the declaration exists in the
	// tsgo program but the symbol is a host binder SymbolObject (node.symbol,
	// not from checker.getSymbolAtLocation).  The fix ensures that when
	// resolveRpcSymbol / tsgoSymbolForHostDeclaration falls back to the
	// binder-set .symbol on the owning declaration node, getDeclaredTypeOfSymbol
	// returns the real declared type instead of errorType.
	const classDecl = sf.statements[1]; // export class Foo {}
	const ifaceDecl = sf.statements[2]; // export interface Bar {}
	const typeDecl = sf.statements[3];  // export type Baz = ...
	for (const [label, decl] of [['class', classDecl], ['interface', ifaceDecl], ['type-alias', typeDecl]]) {
		const hostSym = decl.symbol;
		if (!hostSym) throw new Error(`host binder symbol missing for ${label}`);
		const dt = checker.getDeclaredTypeOfSymbol(hostSym);
		if (dt === undefined || dt === null) {
			throw new Error(`getDeclaredTypeOfSymbol returned ${dt} for host-bound ${label} symbol`);
		}
		if (typeof dt.getFlags !== 'function' && typeof dt.flags !== 'number') {
			throw new Error(`getDeclaredTypeOfSymbol returned non-Type for ${label}: ${typeof dt}`);
		}
	}

	// Host-only symbol: no declarations / valueDeclaration to map to a tsgo
	// counterpart. The type-tree plugin hands exactly this shape back into
	// getDeclaredTypeOfSymbol after getSymbolAtLocation on a host-bound file.
	const hostOnlySymbol = {
		escapedName: '__tnbHostOnly',
		flags: 0,
		declarations: undefined,
		valueDeclaration: undefined,
	};
	const declared = checker.getDeclaredTypeOfSymbol(hostOnlySymbol);
	if (declared === undefined || declared === null) {
		throw new Error('getDeclaredTypeOfSymbol leaked undefined for a host-only symbol');
	}
	if (typeof declared.getFlags !== 'function' && typeof declared.flags !== 'number') {
		throw new Error(`getDeclaredTypeOfSymbol returned non-Type: ${typeof declared}`);
	}

	console.log(`check:declared-type-hostonly ok (real=${realDeclared.flags}, hostOnly=${declared.flags})`);
}
finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
