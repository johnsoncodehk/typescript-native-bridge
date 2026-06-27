"use strict";
// Resolve @typescript/native-preview subpaths across export layouts:
//   legacy:  @typescript/native-preview/sync
//   current: @typescript/native-preview/unstable/sync

const SYNC_CANDIDATES = ["unstable/sync", "sync"];
const AST_CANDIDATES = ["unstable/ast", "ast"];
const AST_FACTORY_CANDIDATES = ["unstable/ast/factory", "ast/factory"];

let cached = null;

function resolveSubpath(candidates) {
	for (const sub of candidates) {
		try {
			require.resolve(`@typescript/native-preview/${sub}`);
			return sub;
		} catch {
			// try next
		}
	}
	throw new Error("@typescript/native-preview not installed or unsupported export layout");
}

function hasNativePreview() {
	try {
		resolveSubpath(SYNC_CANDIDATES);
		return true;
	} catch {
		return false;
	}
}

function loadTsgoModules() {
	if (cached) return cached;
	const syncSub = resolveSubpath(SYNC_CANDIDATES);
	const astSub = resolveSubpath(AST_CANDIDATES);
	const factorySub = resolveSubpath(AST_FACTORY_CANDIDATES);
	cached = {
		sync: require(`@typescript/native-preview/${syncSub}`),
		ast: require(`@typescript/native-preview/${astSub}`),
		astFactory: require(`@typescript/native-preview/${factorySub}`),
		layout: syncSub.startsWith("unstable/") ? "unstable" : "legacy",
	};
	return cached;
}

module.exports = { hasNativePreview, loadTsgoModules };
