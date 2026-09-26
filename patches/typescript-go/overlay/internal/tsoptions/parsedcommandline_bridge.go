package tsoptions

// TNB additions to package tsoptions, kept out of parsedcommandline.go so its in-place patch
// carries only edits to upstream code.

import (
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tspath"
)

func (p *ParsedCommandLine) ExtraFileExtensions() []FileExtensionInfo {
	if p == nil {
		return nil
	}
	return p.extraFileExtensions
}

// GetScriptKindForFileName returns the script kind for a file name, consulting
// built-in extension rules first, then extra file extensions from tsconfig/API.
func GetScriptKindForFileName(fileName string, extraFileExtensions []FileExtensionInfo) core.ScriptKind {
	if sk := core.GetScriptKindFromFileName(fileName); sk != core.ScriptKindUnknown {
		return sk
	}
	ext := tspath.TryGetExtensionFromPath(fileName)
	if ext == "" {
		return core.ScriptKindUnknown
	}
	for _, info := range extraFileExtensions {
		if info.Extension == ext {
			return info.ScriptKind
		}
	}
	return core.ScriptKindUnknown
}

// WithCompilerOptions returns a copy of this command line with the compiler
// options replaced, preserving config metadata (ConfigFile, project references,
// extra file extensions, literal file names). Fork-added: used by the API
// bridge to layer command-line-only flags (e.g. --build, which in `tsc -b`
// arrives via the CLI and never appears in the tsconfig this project was
// parsed from) on top of the parsed config.
func (p *ParsedCommandLine) WithCompilerOptions(options *core.CompilerOptions) *ParsedCommandLine {
	parsedConfig := *p.ParsedConfig
	parsedConfig.CompilerOptions = options
	return &ParsedCommandLine{
		ParsedConfig:        &parsedConfig,
		ConfigFile:          p.ConfigFile,
		Errors:              p.Errors,
		Raw:                 p.Raw,
		CompileOnSave:       p.CompileOnSave,
		comparePathsOptions: p.comparePathsOptions,
		wildcardDirectories: p.wildcardDirectories,
		includeGlobs:        p.includeGlobs,
		extraFileExtensions: p.extraFileExtensions,
		literalFileNamesLen: p.literalFileNamesLen,
	}
}

// WithAppendedFileNames returns a copy of this command line with extra root file
// names appended, preserving config metadata (ConfigFile, project references,
// extra file extensions, literal file names). Fork-added: used by the project
// layer to mirror API hosts whose script file list extends the tsconfig root set
// (e.g. a .tsx root shadowed by a same-name .ts via wildcard extension priority).
func (p *ParsedCommandLine) WithAppendedFileNames(extraFileNames []string) *ParsedCommandLine {
	parsedConfig := *p.ParsedConfig
	fileNames := make([]string, 0, len(p.ParsedConfig.FileNames)+len(extraFileNames))
	fileNames = append(fileNames, p.ParsedConfig.FileNames...)
	fileNames = append(fileNames, extraFileNames...)
	parsedConfig.FileNames = fileNames
	return &ParsedCommandLine{
		ParsedConfig:        &parsedConfig,
		ConfigFile:          p.ConfigFile,
		Errors:              p.Errors,
		Raw:                 p.Raw,
		CompileOnSave:       p.CompileOnSave,
		comparePathsOptions: p.comparePathsOptions,
		wildcardDirectories: p.wildcardDirectories,
		includeGlobs:        p.includeGlobs,
		extraFileExtensions: p.extraFileExtensions,
		literalFileNamesLen: p.literalFileNamesLen,
	}
}
