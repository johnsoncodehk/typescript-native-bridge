package api

import (
	"context"
	"slices"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/modulespecifiers"
)

// ModuleSpecifiersBatchPreferences mirrors JS UserPreferences fields used for
// auto-import module specifier generation.
type ModuleSpecifiersBatchPreferences struct {
	ImportModuleSpecifierPreference   string   `json:"importModuleSpecifierPreference,omitempty"`
	ImportModuleSpecifierEnding       string   `json:"importModuleSpecifierEnding,omitempty"`
	AutoImportSpecifierExcludeRegexes []string `json:"autoImportSpecifierExcludeRegexes,omitempty"`
}

// GetModuleSpecifiersBatchParams are parameters for getModuleSpecifiersBatch.
type GetModuleSpecifiersBatchParams struct {
	Snapshot      SnapshotID                        `json:"snapshot"`
	Project       ProjectID                         `json:"project"`
	File          *DocumentIdentifier               `json:"file"`
	ModuleSymbols []SymbolID                        `json:"moduleSymbols"`
	Preferences   *ModuleSpecifiersBatchPreferences `json:"preferences,omitempty"`
}

// ModuleSpecifiersBatchEntry is one module's auto-import specifier candidates.
type ModuleSpecifiersBatchEntry struct {
	ModuleSymbol     SymbolID `json:"moduleSymbol"`
	Kind             string   `json:"kind,omitempty"`
	ModuleSpecifiers []string `json:"moduleSpecifiers"`
}

// ModuleSpecifiersBatchResponse is the batch auto-import specifier result.
type ModuleSpecifiersBatchResponse struct {
	Results []*ModuleSpecifiersBatchEntry `json:"results"`
}

func toModuleSpecifiersUserPreferences(p *ModuleSpecifiersBatchPreferences) modulespecifiers.UserPreferences {
	if p == nil {
		return modulespecifiers.UserPreferences{}
	}
	return modulespecifiers.UserPreferences{
		ImportModuleSpecifierPreference:   modulespecifiers.ImportModuleSpecifierPreference(p.ImportModuleSpecifierPreference),
		ImportModuleSpecifierEnding:       modulespecifiers.ImportModuleSpecifierEndingPreference(p.ImportModuleSpecifierEnding),
		AutoImportSpecifierExcludeRegexes: p.AutoImportSpecifierExcludeRegexes,
	}
}

func resultKindWire(k modulespecifiers.ResultKind) string {
	switch k {
	case modulespecifiers.ResultKindAmbient:
		return "ambient"
	case modulespecifiers.ResultKindNodeModules:
		return "node_modules"
	case modulespecifiers.ResultKindPaths:
		return "paths"
	case modulespecifiers.ResultKindRedirect:
		return "redirect"
	case modulespecifiers.ResultKindRelative:
		return "relative"
	default:
		return ""
	}
}

func computeModuleSpecifiersBatch(
	ctx context.Context,
	program *compiler.Program,
	importingSourceFile *ast.SourceFile,
	moduleSymbolIDs []SymbolID,
	preferences modulespecifiers.UserPreferences,
	sd *snapshotData,
) (*ModuleSpecifiersBatchResponse, error) {
	chk, done := program.GetTypeChecker(ctx)
	defer done()

	resp := &ModuleSpecifiersBatchResponse{
		Results: make([]*ModuleSpecifiersBatchEntry, 0, len(moduleSymbolIDs)),
	}
	compilerOptions := program.Options()

	unique := slices.Clone(moduleSymbolIDs)
	slices.Sort(unique)
	unique = slices.Compact(unique)

	for _, symID := range unique {
		moduleSymbol, err := sd.resolveSymbolHandle(symID)
		if err != nil || moduleSymbol == nil {
			continue
		}
		specifiers, kind := modulespecifiers.GetModuleSpecifiersWithInfo(
			moduleSymbol,
			chk,
			compilerOptions,
			importingSourceFile,
			program,
			preferences,
			modulespecifiers.ModuleSpecifierOptions{},
			true, /* forAutoImport */
		)
		resp.Results = append(resp.Results, &ModuleSpecifiersBatchEntry{
			ModuleSymbol:     symID,
			Kind:             resultKindWire(kind),
			ModuleSpecifiers: specifiers,
		})
	}
	return resp, nil
}
