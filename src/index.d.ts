// Type-level: this module is structurally `typeof typescript`. The runtime
// overlays tsgo's enums/guards/walkers and adds a NAPI-backed `createProgram`,
// but the static shape is compatible with the real `typescript` types — so
// consumers (tsslint, vue-tsc) that alias `typescript` → this package keep
// their existing type-checking unchanged.

import ts = require('typescript');

declare const facade: typeof ts & {
	/** NAPI-backed createProgram returning a tsgo program wrapped as ts.Program. */
	createProgram(
		rootNames: string[] | readonly string[],
		options: ts.CompilerOptions & { cwd?: string },
		host?: ts.CompilerHost,
		oldProgram?: ts.Program,
	): ts.Program;
	/** Resolve the bridge.dylib path this package will load (throws if absent). */
	resolveBridgeLib(): string;
	readonly __tsNativeBridge__: true;
};

export = facade;
