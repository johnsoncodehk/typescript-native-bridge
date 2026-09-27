package outputpaths

import "github.com/microsoft/typescript-go/internal/tspath"

// Ledger(tsgo-extra-file-extensions) — README behavior table row.
// A source file only reaches emit with a non-script extension through a
// host-registered extraFileExtensions entry; stock names its declaration
// file.ext.d.ts (getDeclarationEmitExtensionForPath answers .d.ts for every
// extension but .mts/.cts/.json). tsgo's .d.ext.ts is the arbitrary-extension
// declaration a module import looks up, not an emit target.
func declarationEmitExtensionForPath(path string) string {
	if tspath.HasTSFileExtension(path) || tspath.HasJSFileExtension(path) || tspath.HasJSONFileExtension(path) {
		return tspath.GetDeclarationEmitExtensionForPath(path)
	}
	return tspath.ExtensionDts
}
