// Instrumented copy of volar server.ts for triage (logs res.message on updateOpen failure).
import { launchServer } from '@typescript/server-harness';
import { ConfigurationRequest, PublishDiagnosticsNotification, type ConfigurationParams, type TextDocument } from '@volar/language-server';
import type { LanguageServerHandle } from '@volar/test-utils';
import { startLanguageServer } from '@volar/test-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URI } from 'vscode-uri';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const tsserverPath = process.env.TSSERVER_PATH
	?? path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const languageServerEntry = path.join(volarRoot, 'packages/language-server/index.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

let serverHandle: LanguageServerHandle | undefined;
let tsserver: import('@typescript/server-harness').Server;
let seq = 1;

export const testWorkspacePath = path.join(volarRoot, 'test-workspace');

export async function getLanguageServer(): Promise<{
	vueserver: LanguageServerHandle;
	tsserver: import('@typescript/server-harness').Server;
	nextSeq: () => number;
	open: (uri: string, languageId: string, content: string) => Promise<TextDocument>;
	close: (uri: string) => Promise<void>;
}> {
	if (!serverHandle) {
		tsserver = launchServer(
			tsserverPath,
			[
				'--disableAutomaticTypingAcquisition',
				'--globalPlugins',
				'@vue/typescript-plugin',
				'--pluginProbeLocations',
				pluginProbe,
				'--suppressDiagnosticEvents',
			],
		);

		tsserver.on('exit', code => console.log(code ? `Exited with code ${code}` : `Terminated`));

		await tsserver.message({
			seq: seq++,
			command: 'configure',
			arguments: {
				preferences: {
					includeCompletionsForModuleExports: true,
					includeCompletionsWithInsertText: true,
				},
			},
		});

		serverHandle = startLanguageServer(
			languageServerEntry,
			testWorkspacePath,
		);
		serverHandle.connection.onNotification(PublishDiagnosticsNotification.method, () => {});
		serverHandle.connection.onRequest(ConfigurationRequest.method, (params: ConfigurationParams) => {
			return params.items.map(({ section }) => {
				if (section?.startsWith('vue.inlayHints.')) {
					return true;
				}
				return null;
			});
		});
		serverHandle.connection.onNotification('tsserver/request', ([id, command, args]) => {
			tsserver.message({
				seq: seq++,
				command: command,
				arguments: args,
			}).then(
				res => serverHandle!.connection.sendNotification('tsserver/response', [id, res?.body]),
				err => {
					console.error('[triage] tsserver/request error', command, err);
					serverHandle!.connection.sendNotification('tsserver/response', [id, undefined]);
				},
			);
		});

		await serverHandle.initialize(
			URI.file(testWorkspacePath).toString(),
			{},
			{
				workspace: {
					configuration: true,
				},
			},
		);
	}
	return {
		vueserver: serverHandle,
		tsserver: tsserver,
		nextSeq: () => seq++,
		open: async (uri, languageId, content) => {
			if (uri.startsWith('file://')) {
				const res = await tsserver.message({
					seq: seq++,
					type: 'request',
					command: 'updateOpen',
					arguments: {
						changedFiles: [],
						closedFiles: [],
						openFiles: [
							{
								file: URI.parse(uri).fsPath,
								fileContent: content,
							},
						],
					},
				});
				if (!res.success) {
					console.error('[triage] updateOpen failed', {
						success: res.success,
						message: res.message,
						body: res.body,
						file: URI.parse(uri).fsPath,
					});
					throw new Error(res.message || String(res.body));
				}
			}
			return await serverHandle!.openInMemoryDocument(uri, languageId, content);
		},
		close: async uri => {
			if (uri.startsWith('file://')) {
				const res = await tsserver.message({
					seq: seq++,
					type: 'request',
					command: 'updateOpen',
					arguments: {
						changedFiles: [],
						closedFiles: [URI.parse(uri).fsPath],
						openFiles: [],
					},
				});
				if (!res.success) {
					console.error('[triage] updateOpen close failed', res.message, res.body);
					throw new Error(res.message || String(res.body));
				}
			}
			await serverHandle!.closeTextDocument(uri);
		},
	};
}
