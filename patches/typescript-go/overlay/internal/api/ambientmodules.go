package api

import (
	"context"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
)

// GetAmbientModulesParams are parameters for the getAmbientModules method.
type GetAmbientModulesParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
}

// AmbientModulesResponse is the lightweight ambient-module index for a program.
type AmbientModulesResponse struct {
	Modules []*AmbientModuleResponse `json:"modules"`
}

// AmbientModuleResponse contains only the fields needed by checker
// getAmbientModules and tryFindAmbientModule.
type AmbientModuleResponse struct {
	ModuleName   string               `json:"moduleName"`
	ModuleSymbol *LightSymbolResponse `json:"moduleSymbol"`
}

// computeAmbientModules enumerates ambient modules without constructing a full
// type checker. Builder/referenced-files callers only need merged declaration
// sets (to detect cross-file ambient edges); paying NewChecker here dominated
// Elk cold builds (~700ms) even after stripping export-map work.
func computeAmbientModules(ctx context.Context, program *compiler.Program, sd *snapshotData, project ProjectID) (*AmbientModulesResponse, error) {
	_ = ctx
	program.BindSourceFiles()

	byName := make(map[string]*ast.Symbol)
	for _, file := range program.SourceFiles() {
		if file == nil || ast.IsExternalOrCommonJSModule(file) {
			continue
		}
		for _, symbol := range file.Locals {
			if symbol == nil || symbol.Name == "" || !ast.IsAmbientModuleSymbolName(symbol.Name) {
				continue
			}
			if containsWildcard(symbol.Name) {
				continue
			}
			mergeAmbientModule(byName, symbol)
		}
	}

	resp := &AmbientModulesResponse{}
	seen := make(map[*ast.Symbol]bool)
	addModule := func(moduleSymbol *ast.Symbol) {
		if moduleSymbol == nil || moduleSymbol.Name == "" || seen[moduleSymbol] {
			return
		}
		seen[moduleSymbol] = true
		resp.Modules = append(resp.Modules, &AmbientModuleResponse{
			ModuleName:   moduleSymbol.Name,
			ModuleSymbol: sd.newLightSymbolResponse(moduleSymbol, project),
		})
	}

	for _, ambient := range byName {
		addModule(ambient)

		// Preserve the node: alias coverage of the previous export-map-backed
		// ambient index without computing any exports.
		raw := strings.Trim(ambient.Name, `"`)
		var altName string
		if strings.HasPrefix(raw, "node:") {
			altName = `"` + strings.TrimPrefix(raw, "node:") + `"`
		} else {
			altName = `"node:` + raw + `"`
		}
		if altName != ambient.Name {
			addModule(byName[altName])
		}
	}

	return resp, nil
}

func mergeAmbientModule(byName map[string]*ast.Symbol, symbol *ast.Symbol) {
	existing := byName[symbol.Name]
	if existing == nil {
		byName[symbol.Name] = symbol
		return
	}
	if existing == symbol {
		return
	}

	// Never mutate binder symbols: synthesize a transient merge for the ambient
	// index so later NewChecker can merge originals independently.
	if existing.Flags&ast.SymbolFlagsTransient == 0 {
		merged := &ast.Symbol{
			Flags:            existing.Flags | ast.SymbolFlagsTransient | symbol.Flags,
			Name:             existing.Name,
			Declarations:     append([]*ast.Node{}, existing.Declarations...),
			ValueDeclaration: existing.ValueDeclaration,
			Members:          existing.Members,
			Exports:          existing.Exports,
			Parent:           existing.Parent,
			ExportSymbol:     existing.ExportSymbol,
		}
		merged.Declarations = append(merged.Declarations, symbol.Declarations...)
		if merged.ValueDeclaration == nil {
			merged.ValueDeclaration = symbol.ValueDeclaration
		}
		byName[symbol.Name] = merged
		return
	}

	existing.Flags |= symbol.Flags
	existing.Declarations = append(existing.Declarations, symbol.Declarations...)
	if existing.ValueDeclaration == nil {
		existing.ValueDeclaration = symbol.ValueDeclaration
	}
}
