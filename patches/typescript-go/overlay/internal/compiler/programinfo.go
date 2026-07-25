package compiler

// Wire DTO builders for the bridge's program-info RPCs (TNB fork). The JS thin
// program materializes stock-shaped Program state (include reasons, resolution
// caches, missing paths, classifiable names) from these payloads; they are the
// only Go-side readers of the unexported processing state, keeping internal/api
// free of compiler-package internals.

import (
	"slices"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/collections"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/module"
)

// Stock FileIncludeKind numbering (typescript/src/compiler/types.ts). The wire
// contract speaks stock enum values so the JS side materializes reasons with
// no translation table. Go has no project-reference-redirect reason kinds —
// tsgo's include-reason model predates them — so Source/OutputFromProject-
// Reference never appear on the wire.
const (
	wireFileIncludeKindRootFile                   = 0
	wireFileIncludeKindImport                     = 3
	wireFileIncludeKindReferenceFile              = 4
	wireFileIncludeKindTypeReferenceDirective     = 5
	wireFileIncludeKindLibFile                    = 6
	wireFileIncludeKindLibReferenceDirective      = 7
	wireFileIncludeKindAutomaticTypeDirectiveFile = 8
)

// PackageIdWire mirrors stock's PackageId field names.
type PackageIdWire struct {
	Name             string `json:"name"`
	SubModuleName    string `json:"subModuleName,omitempty"`
	Version          string `json:"version,omitempty"`
	PeerDependencies string `json:"peerDependencies,omitempty"`
}

func packageIdWire(p module.PackageId) *PackageIdWire {
	if p.Name == "" {
		return nil
	}
	return &PackageIdWire{
		Name:             p.Name,
		SubModuleName:    p.SubModuleName,
		Version:          p.Version,
		PeerDependencies: p.PeerDependencies,
	}
}

// FileIncludeReasonWire is one stock-shaped FileIncludeReason. Index is a
// pointer so a legitimate 0 survives encoding (omitempty would drop it).
type FileIncludeReasonWire struct {
	Kind          int            `json:"kind"`
	File          string         `json:"file,omitempty"` // referencing file (referenced kinds)
	Index         *int           `json:"index,omitempty"`
	TypeReference string         `json:"typeReference,omitempty"`
	PackageId     *PackageIdWire `json:"packageId,omitempty"`
}

// FileIncludeReasonsForFileWire pairs one included file with its reasons.
type FileIncludeReasonsForFileWire struct {
	File    string                   `json:"file"`
	Reasons []*FileIncludeReasonWire `json:"reasons"`
}

// FileIncludeReasonsWire flattens includeProcessor.fileIncludeReasons.
// Synthetic import reasons (index < 0: importHelpers / jsx-runtime factories)
// are dropped — their index does not address file.imports on the JS side
// (stock appends synthetic literals to file.imports during program creation;
// neither the host-parsed nor the remote JS SourceFile carries them), so the
// stock reason consumers (explainFiles, FAR getReferencesForNonModule) could
// not locate them anyway.
func (p *Program) FileIncludeReasonsWire() []*FileIncludeReasonsForFileWire {
	out := make([]*FileIncludeReasonsForFileWire, 0, len(p.includeProcessor.fileIncludeReasons))
	for path, reasons := range p.includeProcessor.fileIncludeReasons {
		entry := &FileIncludeReasonsForFileWire{File: string(path)}
		for _, r := range reasons {
			w := &FileIncludeReasonWire{}
			switch r.kind {
			case fileIncludeKindImport:
				d := r.asReferencedFileData()
				if d.synthetic != nil {
					continue
				}
				w.Kind = wireFileIncludeKindImport
				w.File = string(d.file)
				w.Index = &d.index
			case fileIncludeKindReferenceFile:
				d := r.asReferencedFileData()
				w.Kind = wireFileIncludeKindReferenceFile
				w.File = string(d.file)
				w.Index = &d.index
			case fileIncludeKindTypeReferenceDirective:
				d := r.asReferencedFileData()
				w.Kind = wireFileIncludeKindTypeReferenceDirective
				w.File = string(d.file)
				w.Index = &d.index
			case fileIncludeKindLibReferenceDirective:
				d := r.asReferencedFileData()
				w.Kind = wireFileIncludeKindLibReferenceDirective
				w.File = string(d.file)
				w.Index = &d.index
			case fileIncludeKindRootFile:
				w.Kind = wireFileIncludeKindRootFile
				index := r.asIndex()
				w.Index = &index
			case fileIncludeKindLibFile:
				w.Kind = wireFileIncludeKindLibFile
				if index, ok := r.asLibFileIndex(); ok {
					w.Index = &index
				}
			case fileIncludeKindAutomaticTypeDirectiveFile:
				d := r.asAutomaticTypeDirectiveFileData()
				w.Kind = wireFileIncludeKindAutomaticTypeDirectiveFile
				w.TypeReference = d.typeReference
				w.PackageId = packageIdWire(d.packageId)
			default:
				continue
			}
			entry.Reasons = append(entry.Reasons, w)
		}
		if len(entry.Reasons) != 0 {
			out = append(out, entry)
		}
	}
	slices.SortFunc(out, func(a, b *FileIncludeReasonsForFileWire) int {
		return strings.Compare(a.File, b.File)
	})
	return out
}

// MissingFilePaths returns the paths that were referenced during program
// creation but not found — the watch layer installs file watchers on these so
// a later-created file invalidates the program (stock updateMissingFilePathsWatch).
func (p *Program) MissingFilePaths() []string {
	out := slices.Clone(p.missingFiles)
	slices.Sort(out)
	return out
}

// AggregateUsesUriStyleNodeCoreModules folds the per-file parse flags into
// stock's program-level tristate: true when any non-declaration, non-external
// file uses a node:-prefixed core-module specifier (sticky), else false when
// any uses an unprefixed core module, else undefined. Stock gates on
// currentNodeModulesDepth === 0; the sourceFilesFoundSearchingNodeModules set
// is the same population (depth increments exactly when a file is found by a
// node_modules search). p.usesUriStyleNodeCoreModules is never assigned in
// tsgo (per-file flags are the live state), so the aggregate is computed here.
func (p *Program) AggregateUsesUriStyleNodeCoreModules() core.Tristate {
	result := core.TSUnknown
	for _, file := range p.files {
		if file.IsDeclarationFile || p.sourceFilesFoundSearchingNodeModules.Has(file.Path()) {
			continue
		}
		switch file.UsesUriStyleNodeCoreModules {
		case core.TSTrue:
			return core.TSTrue
		case core.TSFalse:
			result = core.TSFalse
		}
	}
	return result
}

// ClassifiableNamesUnion is the union of every program file's binder-collected
// classifiable names (stock Program.getClassifiableNames). Lib files live
// outside p.files in tsgo but contribute to stock's set, so they are folded in
// from filesByPath.
func (p *Program) ClassifiableNamesUnion() []string {
	var set collections.Set[string]
	add := func(file *ast.SourceFile) {
		for name := range file.ClassifiableNames.Keys() {
			set.Add(name)
		}
	}
	for _, file := range p.files {
		add(file)
	}
	for _, file := range p.filesByPath {
		add(file)
	}
	out := make([]string, 0, set.Len())
	for name := range set.Keys() {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// ModuleResolutionWire is one stock-shaped ResolvedModuleWithFailedLookupLocations
// entry (failedLookupLocations is a JS-side constant — tsgo does not track them).
type ModuleResolutionWire struct {
	ModuleName               string         `json:"moduleName"`
	Mode                     int32          `json:"mode"` // core.ResolutionMode: 0 (none), 1 (CommonJS), 99 (ESNext)
	ResolvedFileName         string         `json:"resolvedFileName,omitempty"`
	OriginalPath             string         `json:"originalPath,omitempty"`
	Extension                string         `json:"extension,omitempty"`
	IsExternalLibraryImport  bool           `json:"isExternalLibraryImport,omitempty"`
	PackageId                *PackageIdWire `json:"packageId,omitempty"`
	ResolvedUsingTsExtension bool           `json:"resolvedUsingTsExtension,omitempty"`
	AlternateResult          string         `json:"alternateResult,omitempty"`
}

// FileModuleResolutionsWire pairs one file with its module resolution cache.
type FileModuleResolutionsWire struct {
	File        string                  `json:"file"`
	Resolutions []*ModuleResolutionWire `json:"resolutions"`
}

// TypeRefResolutionWire is one stock-shaped
// ResolvedTypeReferenceDirectiveWithFailedLookupLocations entry.
type TypeRefResolutionWire struct {
	Name                    string         `json:"name"`
	Mode                    int32          `json:"mode"`
	ResolvedFileName        string         `json:"resolvedFileName,omitempty"`
	OriginalPath            string         `json:"originalPath,omitempty"`
	Primary                 bool           `json:"primary"`
	IsExternalLibraryImport bool           `json:"isExternalLibraryImport,omitempty"`
	PackageId               *PackageIdWire `json:"packageId,omitempty"`
}

// FileTypeRefResolutionsWire pairs one file with its type-reference-directive
// resolution cache.
type FileTypeRefResolutionsWire struct {
	File        string                   `json:"file"`
	Resolutions []*TypeRefResolutionWire `json:"resolutions"`
}

// ResolutionsWire is the full program resolution state: per-file module and
// type-reference-directive caches plus the automatic (@types / types-list)
// directive resolutions, which tsgo stores under the synthetic inferred-types
// containing file.
type ResolutionsWire struct {
	Modules                           []*FileModuleResolutionsWire  `json:"modules"`
	TypeReferenceDirectives           []*FileTypeRefResolutionsWire `json:"typeReferenceDirectives"`
	AutomaticTypeDirectiveNames       []string                      `json:"automaticTypeDirectiveNames"`
	AutomaticTypeDirectiveResolutions []*TypeRefResolutionWire      `json:"automaticTypeDirectiveResolutions"`
}

func moduleResolutionWire(name string, mode core.ResolutionMode, r *module.ResolvedModule) *ModuleResolutionWire {
	w := &ModuleResolutionWire{ModuleName: name, Mode: int32(mode)}
	if r == nil {
		return w
	}
	w.ResolvedFileName = r.ResolvedFileName
	w.OriginalPath = r.OriginalPath
	w.Extension = r.Extension
	w.IsExternalLibraryImport = r.IsExternalLibraryImport
	w.PackageId = packageIdWire(r.PackageId)
	w.ResolvedUsingTsExtension = r.ResolvedUsingTsExtension
	w.AlternateResult = r.AlternateResult
	return w
}

func typeRefResolutionWire(name string, mode core.ResolutionMode, r *module.ResolvedTypeReferenceDirective) *TypeRefResolutionWire {
	w := &TypeRefResolutionWire{Name: name, Mode: int32(mode)}
	if r == nil {
		return w
	}
	w.ResolvedFileName = r.ResolvedFileName
	w.OriginalPath = r.OriginalPath
	w.Primary = r.Primary
	w.IsExternalLibraryImport = r.IsExternalLibraryImport
	w.PackageId = packageIdWire(r.PackageId)
	return w
}

// ResolutionsWire builds the program's full resolution payload. Unresolved
// entries ride along (stock caches failures too — JS maps them to
// { resolvedModule: undefined }).
func (p *Program) ResolutionsWire() *ResolutionsWire {
	wire := &ResolutionsWire{}
	for path, cache := range p.resolvedModules {
		if len(cache) == 0 {
			continue
		}
		entry := &FileModuleResolutionsWire{File: string(path)}
		for key, resolution := range cache {
			entry.Resolutions = append(entry.Resolutions, moduleResolutionWire(key.Name, key.Mode, resolution))
		}
		slices.SortFunc(entry.Resolutions, func(a, b *ModuleResolutionWire) int {
			if c := strings.Compare(a.ModuleName, b.ModuleName); c != 0 {
				return c
			}
			return int(a.Mode - b.Mode)
		})
		wire.Modules = append(wire.Modules, entry)
	}
	slices.SortFunc(wire.Modules, func(a, b *FileModuleResolutionsWire) int {
		return strings.Compare(a.File, b.File)
	})

	automaticTypeDirectiveNames := collections.Set[string]{}
	for path, cache := range p.typeResolutionsInFile {
		if len(cache) == 0 {
			continue
		}
		// Automatic type directives resolve against the synthetic inferred-types
		// containing file; stock keeps them in a separate program-level cache.
		if strings.HasSuffix(string(path), "/"+module.InferredTypesContainingFile) {
			for key, resolution := range cache {
				wire.AutomaticTypeDirectiveResolutions = append(wire.AutomaticTypeDirectiveResolutions, typeRefResolutionWire(key.Name, key.Mode, resolution))
				automaticTypeDirectiveNames.Add(key.Name)
			}
			continue
		}
		entry := &FileTypeRefResolutionsWire{File: string(path)}
		for key, resolution := range cache {
			entry.Resolutions = append(entry.Resolutions, typeRefResolutionWire(key.Name, key.Mode, resolution))
		}
		slices.SortFunc(entry.Resolutions, func(a, b *TypeRefResolutionWire) int {
			if c := strings.Compare(a.Name, b.Name); c != 0 {
				return c
			}
			return int(a.Mode - b.Mode)
		})
		wire.TypeReferenceDirectives = append(wire.TypeReferenceDirectives, entry)
	}
	slices.SortFunc(wire.TypeReferenceDirectives, func(a, b *FileTypeRefResolutionsWire) int {
		return strings.Compare(a.File, b.File)
	})
	slices.SortFunc(wire.AutomaticTypeDirectiveResolutions, func(a, b *TypeRefResolutionWire) int {
		return strings.Compare(a.Name, b.Name)
	})
	for name := range automaticTypeDirectiveNames.Keys() {
		wire.AutomaticTypeDirectiveNames = append(wire.AutomaticTypeDirectiveNames, name)
	}
	slices.Sort(wire.AutomaticTypeDirectiveNames)
	return wire
}
