package api

import (
	"context"
	"slices"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
)

// ExportKind mirrors stock services/exportInfoMap ExportKind for auto-import populate.
const (
	ExportKindNamed        int32 = 0
	ExportKindDefault      int32 = 1
	ExportKindExportEquals int32 = 2
)

// GetModuleExportMapParams are parameters for the getModuleExportMap method.
type GetModuleExportMapParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
}

// ModuleExportMapResponse is the batch auto-import export index for a program.
type ModuleExportMapResponse struct {
	Modules []*ModuleExportMapModule `json:"modules"`
}

// ModuleExportMapModule is one importable external/ambient module and its exports.
type ModuleExportMapModule struct {
	ModuleFileName string                        `json:"moduleFileName,omitempty"`
	ModuleName     string                        `json:"moduleName"`
	ModuleSymbol   *LightSymbolResponse          `json:"moduleSymbol"`
	DefaultExport  *ModuleExportMapDefaultExport `json:"defaultExport,omitempty"`
	NamedExports   []*ModuleExportMapNamedExport `json:"namedExports"`
}

// ModuleExportMapDefaultExport is the default-like export of a module, if any.
type ModuleExportMapDefaultExport struct {
	Symbol      *LightSymbolResponse `json:"symbol"`
	TableKey    string               `json:"tableKey"`
	ExportKind  int32                `json:"exportKind"`
	TargetFlags uint32               `json:"targetFlags"`
}

// ModuleExportMapNamedExport is one named export entry.
type ModuleExportMapNamedExport struct {
	Symbol      *LightSymbolResponse `json:"symbol"`
	Key         string               `json:"key"`
	TargetFlags uint32               `json:"targetFlags"`
}

func isImportableExportSymbol(c *checker.Checker, symbol *ast.Symbol) bool {
	if symbol == nil {
		return false
	}
	return !c.IsUndefinedSymbol(symbol) &&
		!c.IsUnknownSymbol(symbol) &&
		!checker.IsKnownSymbol(symbol) &&
		!checker.IsPrivateIdentifierSymbol(symbol)
}

func getDefaultLikeExportInfo(c *checker.Checker, moduleSymbol *ast.Symbol) (*ast.Symbol, int32, string) {
	exportEquals := c.ResolveExternalModuleSymbol(moduleSymbol)
	if exportEquals != moduleSymbol {
		if defaultExport := c.TryGetMemberInModuleExports(ast.InternalSymbolNameDefault, exportEquals); defaultExport != nil {
			return defaultExport, ExportKindDefault, ast.InternalSymbolNameDefault
		}
		return exportEquals, ExportKindExportEquals, ast.InternalSymbolNameExportEquals
	}
	if defaultExport := c.TryGetMemberInModuleExports(ast.InternalSymbolNameDefault, moduleSymbol); defaultExport != nil {
		return defaultExport, ExportKindDefault, ast.InternalSymbolNameDefault
	}
	return nil, 0, ""
}

func computeModuleExportMap(ctx context.Context, program *compiler.Program, sd *snapshotData, project ProjectID) (*ModuleExportMapResponse, error) {
	chk, done := program.GetTypeChecker(ctx)
	defer done()

	resp := &ModuleExportMapResponse{}
	seenModules := make(map[*ast.Symbol]bool)

	addModule := func(moduleSymbol *ast.Symbol, moduleFile *ast.SourceFile) {
		if moduleSymbol == nil || seenModules[moduleSymbol] {
			return
		}
		seenModules[moduleSymbol] = true

		// Path/package.json importability is enforced on the JS side (stock
		// forEachExternalModule + isImportablePath). Go-side pre-filter was
		// stricter and dropped pnpm-resolved modules from the batch map.

		mod := &ModuleExportMapModule{
			ModuleName:   moduleSymbol.Name,
			ModuleSymbol: sd.newLightSymbolResponse(moduleSymbol, project),
		}
		if moduleFile != nil {
			mod.ModuleFileName = moduleFile.FileName()
		}

		var defaultSymbol *ast.Symbol
		if sym, kind, tableKey := getDefaultLikeExportInfo(chk, moduleSymbol); sym != nil && isImportableExportSymbol(chk, sym) {
			defaultSymbol = sym
			target := chk.SkipAlias(sym)
			flags := uint32(0)
			if target != nil {
				flags = uint32(target.Flags)
			}
			mod.DefaultExport = &ModuleExportMapDefaultExport{
				Symbol:      sd.newLightSymbolResponse(sym, project),
				TableKey:    tableKey,
				ExportKind:  kind,
				TargetFlags: flags,
			}
		}

		seenKeys := make(map[string]bool)
		chk.ForEachExportAndPropertyOfModule(moduleSymbol, func(exported *ast.Symbol, key string) {
			if exported == defaultSymbol {
				return
			}
			if !isImportableExportSymbol(chk, exported) || seenKeys[key] {
				return
			}
			seenKeys[key] = true
			target := chk.SkipAlias(exported)
			flags := uint32(0)
			if target != nil {
				flags = uint32(target.Flags)
			}
			mod.NamedExports = append(mod.NamedExports, &ModuleExportMapNamedExport{
				Symbol:      sd.newLightSymbolResponse(exported, project),
				Key:         key,
				TargetFlags: flags,
			})
		})

		// getExportsOfModule / resolveStructuredTypeMembers iterate Go maps —
		// random order per process. JS-side exportInfoMap dedup is
		// order-sensitive; sort so runs are reproducible.
		slices.SortStableFunc(mod.NamedExports, func(a, b *ModuleExportMapNamedExport) int {
			return strings.Compare(a.Key, b.Key)
		})

		if mod.DefaultExport != nil || len(mod.NamedExports) > 0 {
			resp.Modules = append(resp.Modules, mod)
		}
	}

	// GetAmbientModules iterates the globals hash map — order is randomized per
	// process. Stock (JS Map) is insertion-ordered, and the JS-side exportInfoMap
	// dedup is order-sensitive, so a nondeterministic module order makes whole
	// entry groups appear/disappear across runs. Sort for determinism.
	ambients := slices.Clone(chk.GetAmbientModules())
	slices.SortStableFunc(ambients, func(a, b *ast.Symbol) int {
		return strings.Compare(a.Name, b.Name)
	})
	for _, ambient := range ambients {
		if ambient == nil || ambient.Name == "" {
			continue
		}
		// Wildcard ambient modules are handled per stock forEachExternalModule.
		if containsWildcard(ambient.Name) {
			continue
		}
		addModule(ambient, nil)
	}

	for _, sf := range program.SourceFiles() {
		if sf == nil || !ast.IsExternalOrCommonJSModule(sf) {
			continue
		}
		moduleSymbol := sf.Symbol
		if moduleSymbol != nil {
			moduleSymbol = chk.GetMergedSymbol(moduleSymbol)
		}
		if moduleSymbol == nil {
			continue
		}
		addModule(moduleSymbol, sf)
	}

	return resp, nil
}

type moduleExportMapMemoEntry struct {
	resp *ModuleExportMapResponse
	blob []byte
}

// moduleExportMap returns the per-program export index with its binary codec
// memoized alongside (same invalidation rule as builderGraphMemo: the map is a
// pure function of the immutable program).
func (sd *snapshotData) moduleExportMap(ctx context.Context, program *compiler.Program, project ProjectID) (*moduleExportMapMemoEntry, error) {
	sd.moduleExportMapMemoMu.Lock()
	entry, ok := sd.moduleExportMapMemo[program]
	sd.moduleExportMapMemoMu.Unlock()
	if ok {
		return entry, nil
	}

	resp, err := computeModuleExportMap(ctx, program, sd, project)
	if err != nil {
		return nil, err
	}
	entry = &moduleExportMapMemoEntry{resp: resp, blob: encodeModuleExportMapBlob(resp)}

	sd.moduleExportMapMemoMu.Lock()
	if sd.moduleExportMapMemo == nil {
		sd.moduleExportMapMemo = make(map[*compiler.Program]*moduleExportMapMemoEntry)
	}
	sd.moduleExportMapMemo[program] = entry
	sd.moduleExportMapMemoMu.Unlock()
	return entry, nil
}

func containsWildcard(name string) bool {
	for i := 0; i < len(name); i++ {
		if name[i] == '*' {
			return true
		}
	}
	return false
}
