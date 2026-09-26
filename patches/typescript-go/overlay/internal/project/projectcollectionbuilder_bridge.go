package project

// TNB additions to package project, kept out of projectcollectionbuilder.go so its in-place patch
// carries only edits to upstream code.

import (
	"slices"

	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/project/dirty"
	"github.com/microsoft/typescript-go/internal/project/logging"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// resolveWireOptionPaths normalizes the path-valued compiler options a client
// may legitimately send in relative form (a hand-rolled LanguageService host
// passes tsconfig text values verbatim — e.g. tsBuildInfoFile "./.tsbuildinfo")
// against the config directory, mirroring what Go's own tsconfig parse does
// with IsFilePath options (normalizeNonListOptionValue). Stock parseCommandLine
// output is already absolute and passes through unchanged. Field list mirrors
// the IsFilePath declarations in tsoptions (scalar + list-element paths);
// mapRoot/sourceRoot stay verbatim, as in both parsers.
func resolveWireOptionPaths(options *core.CompilerOptions, configFileName string) *core.CompilerOptions {
	configDir := tspath.GetDirectoryPath(configFileName)
	abs := func(value string) string {
		if value == "" {
			return value
		}
		return tspath.GetNormalizedAbsolutePath(value, configDir)
	}
	absAll := func(values []string) []string {
		if values == nil {
			return nil
		}
		out := make([]string, len(values))
		for i, v := range values {
			out[i] = abs(v)
		}
		return out
	}
	options.ConfigFilePath = tspath.GetNormalizedAbsolutePath(configFileName, configDir)
	options.OutDir = abs(options.OutDir)
	options.RootDir = abs(options.RootDir)
	options.DeclarationDir = abs(options.DeclarationDir)
	options.OutFile = abs(options.OutFile)
	options.TsBuildInfoFile = abs(options.TsBuildInfoFile)
	options.BaseUrl = abs(options.BaseUrl)
	options.PathsBasePath = abs(options.PathsBasePath)
	options.TypeRoots = absAll(options.TypeRoots)
	options.RootDirs = absAll(options.RootDirs)
	return options
}

// updateAPIRootFiles computes, for each API-opened configured project, the set
// of API-opened files that should be added as extra program roots because the
// tsconfig's file list misses them, and rebuilds programs whose set changed.
// A file qualifies when its nearest config file is an API-opened project with a
// non-empty root set (solution-style configs are skipped) and the project's
// program does not already contain it. Previously added roots are kept while
// the file stays API-open so the set is stable across snapshots; closing the
// file removes it.
func (b *ProjectCollectionBuilder) updateAPIRootFiles(logger *logging.LogTree) {
	desired := make(map[tspath.Path][]string)
	// API-supplied extra roots (additionalFiles): host-computed root files the
	// tsconfig expansion misses (e.g. LanguageService getScriptFileNames shim
	// d.ts). Added regardless of the default-project search's node_modules
	// boundary — the client asserted them as program roots explicitly.
	for configPath, files := range b.apiState.additionalFiles {
		if _, isAPIOpen := b.apiState.openProjects[configPath]; !isAPIOpen {
			continue
		}
		entry, ok := b.configuredProjects.Load(configPath)
		if !ok || entry.Value() == nil {
			continue
		}
		project := entry.Value()
		if project.CommandLine == nil || len(project.CommandLine.FileNames()) == 0 {
			continue
		}
		for _, f := range files {
			// Keep while API-open: a file already added as an extra root must
			// stay in desired or the setAPIRootFiles replacement below drops it
			// on the very next snapshot (svelte2tsx shim d.ts, #5847). Skip
			// only when the program covers the file without an extra root
			// (tsconfig expansion or a normal dependency edge).
			if project.containsFile(b.toPath(f)) && !slices.Contains(project.apiRootFiles, f) {
				continue
			}
			desired[configPath] = append(desired[configPath], f)
		}
	}
	if len(b.apiState.openProjects) > 0 {
		for path, file := range b.apiState.openFiles {
			configFileName := b.configFileRegistryBuilder.getConfigFileNameForFile(file.fileName, path, logger)
			if configFileName == "" {
				continue
			}
			configPath := b.toPath(configFileName)
			if _, isAPIOpen := b.apiState.openProjects[configPath]; !isAPIOpen {
				continue
			}
			entry, ok := b.configuredProjects.Load(configPath)
			if !ok || entry.Value() == nil {
				continue
			}
			project := entry.Value()
			if project.CommandLine == nil || len(project.CommandLine.FileNames()) == 0 {
				continue
			}
			if slices.Contains(project.apiRootFiles, file.fileName) || !project.containsFile(path) {
				desired[configPath] = append(desired[configPath], file.fileName)
			}
		}
	}
	b.configuredProjects.Range(func(entry *dirty.SyncMapEntry[tspath.Path, *Project]) bool {
		want := desired[entry.Key()]
		slices.Sort(want)
		if slices.Equal(entry.Value().apiRootFiles, want) {
			return true
		}
		if logger != nil {
			logger.Logf("Updating API root files for project %s: %v", entry.Key(), want)
		}
		entry.Change(func(p *Project) {
			p.setAPIRootFiles(want)
		})
		b.updateProgram(entry, logger)
		return true
	})
}
