#!/usr/bin/env node
/**
 * Type prototype parity after an open-file snapshot refresh.
 *
 * Drives an in-process tsserver ProjectService through the issue #57
 * navigation sequence. Opening a declaration target advances the bridge
 * snapshot; wire Type methods from the replacement project must still route
 * to the same checker as direct TypeChecker calls.
 *
 * Usage: node tools/triage-prototype-refresh.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const typescriptPath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js'));
const ts = require(typescriptPath);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-prototype-refresh-'));

function write(relativePath, content) {
	const fileName = path.join(fixture, relativePath);
	fs.writeFileSync(fileName, content);
	return fileName;
}

write('tsconfig.json', JSON.stringify({
	compilerOptions: { strict: true },
	include: ['main.ts', 'handler.ts'],
}));
write('handler.ts', `export interface TestEvent {
  value: string;
}

export interface Handler {
  (event: TestEvent): void;
}

export declare function defineHandler(handler: Handler): void;
`);
const externalText = 'export declare function external(): void;\n';
const externalFile = write('external.d.ts', externalText);
const mainText = `import { external } from "./external";
import { defineHandler } from "./handler";

const sample = { value: "x", count: 1 };

defineHandler((event) => {
  external();
  console.log(event.value, sample.count);
});
`;
const mainFile = write('main.ts', mainText);

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

function findNodes(sourceFile) {
	let arrow;
	let sample;
	sourceFile.forEachChild(function visit(node) {
		if (ts.isArrowFunction(node)) arrow = node;
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sample') sample = node;
		node.forEachChild(visit);
	});
	if (!arrow || !sample) throw new Error('fixture nodes were not found');
	return { arrow, sample };
}

function probe(languageService) {
	const program = languageService.getProgram();
	const checker = program.getTypeChecker();
	const nodes = findNodes(program.getSourceFile(mainFile));
	const callable = checker.getContextualType(nodes.arrow);
	const object = checker.getTypeAtLocation(nodes.sample.name);
	return {
		callType: callable.getCallSignatures().length,
		callChecker: checker.getSignaturesOfType(callable, ts.SignatureKind.Call).length,
		propertiesType: object.getProperties().map(symbol => symbol.name).sort(),
		propertiesChecker: checker.getPropertiesOfType(object).map(symbol => symbol.name).sort(),
	};
}

function assertParity(phase, result) {
	const expectedProperties = ['count', 'value'];
	const callsMatch = result.callType === 1 && result.callChecker === 1;
	const propertiesMatch = JSON.stringify(result.propertiesType) === JSON.stringify(expectedProperties)
		&& JSON.stringify(result.propertiesChecker) === JSON.stringify(expectedProperties);
	if (!callsMatch || !propertiesMatch) {
		throw new Error(`${phase}: ${JSON.stringify(result)}; expected call signatures 1/1 and properties ${JSON.stringify(expectedProperties)} from both APIs`);
	}
}

function navigate(languageService, position) {
	const result = languageService.getDefinitionAndBoundSpan(mainFile, position);
	if (!result?.definitions?.length) {
		throw new Error(`definition missing at ${position}`);
	}
	const program = languageService.getProgram();
	for (const definition of result.definitions) {
		program.getSourceFile(definition.fileName);
	}
	return result;
}

try {
	service.openClientFile(mainFile, mainText, ts.ScriptKind.TS);
	const configuredProjects = [...service.configuredProjects.values()];
	if (configuredProjects.length !== 1) {
		throw new Error(`expected one configured project, got ${configuredProjects.length}`);
	}
	const [project] = configuredProjects;
	const languageService = project.getLanguageService();
	const eventPosition = mainText.indexOf('event');
	const externalPosition = mainText.lastIndexOf('external');

	navigate(languageService, eventPosition);
	const before = probe(languageService);
	assertParity('before refresh', before);

	const externalDefinition = navigate(languageService, externalPosition);
	if (!externalDefinition?.definitions?.some(definition => definition.fileName === externalFile)) {
		throw new Error(`definition target missing: ${JSON.stringify(externalDefinition?.definitions ?? [])}`);
	}
	service.openClientFile(externalFile, externalText, ts.ScriptKind.TS);
	navigate(languageService, eventPosition);

	const after = probe(languageService);
	assertParity('after refresh', after);
	console.log(`check:prototype-refresh ok (${JSON.stringify({ before, after })})`);
}
finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
