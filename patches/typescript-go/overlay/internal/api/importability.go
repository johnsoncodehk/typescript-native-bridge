package api

import (
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// isModuleImportableFrom mirrors stock services/exportInfoMap isImportable for
// external modules (path reachability). Package.json dependency filtering and
// ambient-module package.json rules stay on the JS side.
func isModuleImportableFrom(
	importingSourceFile *ast.SourceFile,
	moduleFile *ast.SourceFile,
	program *compiler.Program,
) bool {
	if importingSourceFile == nil {
		return true
	}
	if moduleFile == nil {
		// Ambient modules: defer to JS (node: prefix + package.json filter).
		return true
	}
	if importingSourceFile == moduleFile {
		return false
	}
	fromPath := importingSourceFile.FileName()
	toPath := moduleFile.FileName()
	useCaseSensitive := program.UseCaseSensitiveFileNames()
	globalCache := program.GetGlobalTypingsCacheLocation()
	return isImportablePath(fromPath, toPath, useCaseSensitive, globalCache)
}

// isImportablePath mirrors stock exportInfoMap isImportablePath.
func isImportablePath(
	fromPath string,
	toPath string,
	useCaseSensitiveFileNames bool,
	globalCachePath string,
) bool {
	canonicalFrom := tspath.GetCanonicalFileName(fromPath, useCaseSensitiveFileNames)
	var canonicalGlobal string
	if globalCachePath != "" {
		canonicalGlobal = tspath.GetCanonicalFileName(globalCachePath, useCaseSensitiveFileNames)
	}
	foundNodeModules := false
	reachable := tspath.ForEachAncestorDirectoryStoppingAtGlobalCache(
		globalCachePath,
		toPath,
		func(ancestor string) (bool, bool) {
			if tspath.GetBaseFileName(ancestor) != "node_modules" {
				return false, false
			}
			foundNodeModules = true
			toNodeModulesParent := tspath.GetDirectoryPath(tspath.GetCanonicalFileName(ancestor, useCaseSensitiveFileNames))
			if strings.HasPrefix(canonicalFrom, toNodeModulesParent) ||
				(canonicalGlobal != "" && strings.HasPrefix(canonicalGlobal, toNodeModulesParent)) {
				return true, true
			}
			return false, false
		},
	)
	return !foundNodeModules || reachable
}
