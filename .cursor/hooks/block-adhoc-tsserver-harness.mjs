#!/usr/bin/env node
/**
 * beforeShellExecution: deny-by-default for tsserver/harness probe commands.
 *
 * Any command that mentions harness machinery (withTsserver, launchServer,
 * tsserver-harness, ...) or runs ad-hoc `node -e` touching harness paths is
 * DENIED unless every segment of the command matches the whitelist below.
 * There is deliberately no FORCE/SKIP bypass.
 *
 * Whitelist: node tools/triage-*.mjs, node tools/kill-leaked-harness.mjs,
 * node tools/tsserver-harness.mjs, build commands, and read-only text tools.
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input.command ?? '');

const HARNESS_MARKERS =
	/withTsserver|resolveVolarRoot|tsserver-harness|launchServer|disableAutomaticTypingAcquisition|@vue\/typescript-plugin|server-harness/i;

const AD_HOC_NODE = /\bnode(?:\.exe)?\s+[^|;&]*(?:\s-e\s|--eval\b|--input-type=module)/i;
const AD_HOC_HARNESS_PATHS = /tsserver|server-harness|volar|launchServer|withTsserver/i;

const suspicious =
	HARNESS_MARKERS.test(command) ||
	(AD_HOC_NODE.test(command) && AD_HOC_HARNESS_PATHS.test(command));

if (!suspicious) {
	allow();
}

// Deny-by-default: every segment of a suspicious command must be whitelisted.
const ALLOWED_SEGMENT = [
	// Sanctioned harness entrypoints (fixed scripts, no ad-hoc eval).
	/^node\s+(?:\.\/)?tools\/triage-[\w.-]+\.mjs(?:\s|$)/,
	/^node\s+(?:\.\/)?tools\/kill-leaked-harness\.mjs(?:\s|$)/,
	/^node\s+(?:\.\/)?tools\/tsserver-harness\.mjs(?:\s|$)/,
	// Build commands.
	/^node\s+(?:\.\/)?tools\/(?:patch-lib-shims\.js|link-volar\.mjs)(?:\s|$)/,
	/^npm\s+run\s+[\w:.-]+(?:\s|$)/,
	/^npx\s+hereby\b/,
	// Read-only / cleanup tools that may mention harness strings.
	/^(?:rg|grep|cat|head|tail|ls|wc|sed|awk|diff|sort|uniq|cut|tr|jq|echo|printf|pgrep|pkill|kill|git|cd|sleep|true|test|\[)\b/,
];

const segments = command
	.split(/&&|\|\||[|;\n]/)
	.map(s => s.trim())
	// Strip leading env assignments (FOO=bar cmd ...).
	.map(s => s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''))
	.filter(Boolean);

const ok =
	segments.length > 0 &&
	segments.every(seg => ALLOWED_SEGMENT.some(re => re.test(seg)));

if (ok) {
	allow();
}

process.stdout.write(JSON.stringify({
	permission: 'deny',
	user_message: '已拦截疑似 ad-hoc tsserver/harness 命令(deny-by-default,防止 tsserver 进程泄漏)。请把探针写成 tools/triage-*.mjs 并通过 withTsserver(tools/tsserver-harness.mjs)运行。',
	agent_message: 'Blocked: suspicious tsserver/harness command. Ad-hoc `node -e` probes and direct launchServer calls are forbidden. Write the probe as a file `tools/triage-<name>.mjs` using `withTsserver` from tools/tsserver-harness.mjs, then run `node tools/triage-<name>.mjs`. Allowed commands: node tools/triage-*.mjs, node tools/kill-leaked-harness.mjs, build commands, read-only text tools.',
}));
process.exit(0);

function allow() {
	process.stdout.write(JSON.stringify({ permission: 'allow' }));
	process.exit(0);
}
