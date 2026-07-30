package api

import (
	"context"
	"testing"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/ls/autoimport"
	"github.com/microsoft/typescript-go/internal/ls/lsconv"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/testutil/projecttestutil"
	"gotest.tools/v3/assert"
)

// Repro for volar #5847: an overlay content update via openFilesWithContent
// (the updateOpen-with-content flow) must invalidate the auto-import registry
// the same way a textDocument/didChange does. Before the fix, the registry
// kept the empty-era export set and completions never offered the new export.
func TestOverlayContentUpdateInvalidatesAutoImportRegistry(t *testing.T) {
	t.Parallel()
	if !bundled.Embedded {
		t.Skip("bundled files are not embedded")
	}
	const configFileName = "/home/projects/p/tsconfig.json"
	const fixtureName = "/home/projects/p/fixture.ts"
	const mainName = "/home/projects/p/main.ts"
	files := map[string]any{
		configFileName: `{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["**/*"] }`,
		fixtureName:    ``,
		mainName:       `testFn;`,
	}
	projectSession, _ := projecttestutil.Setup(files)
	defer projectSession.Close()
	session := NewSession(projectSession, nil)
	defer session.Close()
	ctx := context.Background()

	overlay := func(content string) *UpdateSnapshotResponse {
		resp, err := session.handleUpdateSnapshot(ctx, &UpdateSnapshotParams{
			OpenProjects: []OpenProjectParams{{DocumentIdentifier: DocumentIdentifier{FileName: configFileName}}},
			OpenFilesWithContent: []OpenFileWithContent{{
				FileName:   fixtureName,
				Content:    content,
				ScriptKind: int(core.ScriptKindTS),
			}},
		})
		assert.NilError(t, err)
		return resp
	}

	prefs := lsutil.NewDefaultUserPreferences()
	prefs.IncludeCompletionsForModuleExports = core.TSTrue

	// Era 1: fixture.ts is empty — build the registry for mainFile's project.
	overlay("")
	mainURI := lsconv.FileNameToDocumentURI(mainName)
	_, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot := projectSession.Snapshot()
	defaultProject := snapshot.GetDefaultProject(mainURI)
	assert.Assert(t, defaultProject != nil)
	projectPath := defaultProject.ConfigFilePath()
	assert.Assert(t, snapshot.AutoImportRegistry().IsPreparedForImportingFile(mainName, projectPath, prefs))

	// Era 2: same file, new content via the overlay channel (updateOpen-with-content shape).
	overlay("export function testFn() { console.log('testFn'); }\n")
	_, err = projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot = projectSession.Snapshot()
	registry := snapshot.AutoImportRegistry()
	assert.Assert(t, registry.IsPreparedForImportingFile(mainName, projectPath, prefs),
		"registry must re-prepare after the overlay content update")
	mainSF := defaultProject.GetProgram().GetSourceFile(mainName)
	view := autoimport.NewView(registry, mainSF, projectPath, defaultProject.GetProgram(), prefs.ModuleSpecifierPreferences())
	found := false
	for _, e := range view.Search("testFn", autoimport.QueryKindExactMatch) {
		if e.Name() == "testFn" {
			found = true
		}
	}
	assert.Assert(t, found, "auto-import registry must offer testFn after the overlay content update")
}

// Sanity: the same flow through a didChange whole-document edit (the `change`
// command path) already works and must keep working. A bare didOpen does not
// prepare the registry, so era 1 prepares it explicitly via
// GetCurrentLanguageServiceWithAutoImports; the era-2 edit must then
// invalidate the prepared state (checked after a plain flush, before any
// re-prepare) and the re-prepared registry must offer the new export.
func TestDidChangeWholeDocumentInvalidatesAutoImportRegistry(t *testing.T) {
	t.Parallel()
	if !bundled.Embedded {
		t.Skip("bundled files are not embedded")
	}
	const configFileName = "/home/projects/p/tsconfig.json"
	const fixtureName = "/home/projects/p/fixture.ts"
	const mainName = "/home/projects/p/main.ts"
	files := map[string]any{
		configFileName: `{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["**/*"] }`,
		fixtureName:    ``,
		mainName:       `testFn;`,
	}
	projectSession, _ := projecttestutil.Setup(files)
	defer projectSession.Close()
	ctx := context.Background()

	uri := lsconv.FileNameToDocumentURI(fixtureName)
	mainURI := lsconv.FileNameToDocumentURI(mainName)
	prefs := lsutil.NewDefaultUserPreferences()
	prefs.IncludeCompletionsForModuleExports = core.TSTrue

	projectSession.DidOpenFile(ctx, uri, 1, "", lsproto.LanguageKindTypeScript)
	// Era 1: prepare the registry against the empty fixture.
	_, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot := projectSession.Snapshot()
	defaultProject := snapshot.GetDefaultProject(mainURI)
	assert.Assert(t, defaultProject != nil)
	projectPath := defaultProject.ConfigFilePath()
	assert.Assert(t, snapshot.AutoImportRegistry().IsPreparedForImportingFile(mainName, projectPath, prefs))

	projectSession.DidChangeFile(ctx, uri, 2, []lsproto.TextDocumentContentChangePartialOrWholeDocument{
		{WholeDocument: &lsproto.TextDocumentContentChangeWholeDocument{Text: "export function testFn() { console.log('testFn'); }\n"}},
	})
	// Flush the pending edit without re-preparing; the registry must be stale.
	_, err = projectSession.GetLanguageService(ctx, mainURI)
	assert.NilError(t, err)
	assert.Assert(t, !projectSession.Snapshot().AutoImportRegistry().IsPreparedForImportingFile(mainName, projectPath, prefs),
		"registry must be invalidated by the didChange")

	// Era 2: re-prepare; the new export must be offered.
	_, err = projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot = projectSession.Snapshot()
	registry := snapshot.AutoImportRegistry()
	assert.Assert(t, registry.IsPreparedForImportingFile(mainName, projectPath, prefs))
	defaultProject = snapshot.GetDefaultProject(mainURI)
	mainSF := defaultProject.GetProgram().GetSourceFile(mainName)
	view := autoimport.NewView(registry, mainSF, projectPath, defaultProject.GetProgram(), prefs.ModuleSpecifierPreferences())
	found := false
	for _, e := range view.Search("testFn", autoimport.QueryKindExactMatch) {
		if e.Name() == "testFn" {
			found = true
		}
	}
	assert.Assert(t, found, "auto-import registry must offer testFn after didChange")
}

// volar #5847 bug 2: fixture.ts changes ON DISK without any host event (the
// "host==disk" channel — CLI tool or out-of-session editor write; no overlay
// push, no editContent delta, no forwarded watch event). The next snapshot
// build must detect the stale cached read (mtime pre-filter + content hash)
// and fold it into Changed, or the auto-import registry built from the empty
// era stays stale forever and completions never offer the new export.
func TestDiskWriteWithoutHostEventInvalidatesAutoImportRegistry(t *testing.T) {
	t.Parallel()
	if !bundled.Embedded {
		t.Skip("bundled files are not embedded")
	}
	const configFileName = "/home/projects/p/tsconfig.json"
	const fixtureName = "/home/projects/p/fixture.ts"
	const mainName = "/home/projects/p/main.ts"
	files := map[string]any{
		configFileName: `{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["**/*"] }`,
		fixtureName:    ``,
		mainName:       `testFn;`,
	}
	projectSession, _ := projecttestutil.Setup(files)
	defer projectSession.Close()
	ctx := context.Background()
	mainURI := lsconv.FileNameToDocumentURI(mainName)
	prefs := lsutil.NewDefaultUserPreferences()
	prefs.IncludeCompletionsForModuleExports = core.TSTrue

	// Era 1: prepare the registry against the empty fixture; testFn absent.
	_, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot := projectSession.Snapshot()
	defaultProject := snapshot.GetDefaultProject(mainURI)
	assert.Assert(t, defaultProject != nil)
	projectPath := defaultProject.ConfigFilePath()
	assert.Assert(t, snapshot.AutoImportRegistry().IsPreparedForImportingFile(mainName, projectPath, prefs))

	// Disk write with no host event of any kind.
	assert.NilError(t, projectSession.FS().WriteFile(fixtureName, "export function testFn() { console.log('testFn'); }\n"))

	// Era 2: the auto-imports request builds a fresh snapshot; the staleness
	// probe must fold the fixture into Changed so the registry re-prepares
	// with the new content.
	_, err = projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot = projectSession.Snapshot()
	registry := snapshot.AutoImportRegistry()
	assert.Assert(t, registry.IsPreparedForImportingFile(mainName, projectPath, prefs))
	defaultProject = snapshot.GetDefaultProject(mainURI)
	mainSF := defaultProject.GetProgram().GetSourceFile(mainName)
	view := autoimport.NewView(registry, mainSF, projectPath, defaultProject.GetProgram(), prefs.ModuleSpecifierPreferences())
	found := false
	for _, e := range view.Search("testFn", autoimport.QueryKindExactMatch) {
		if e.Name() == "testFn" {
			found = true
		}
	}
	assert.Assert(t, found, "auto-import registry must offer testFn after a host-less disk write")
}
// deletion: when TWO project files change in one update batch, the first mark
// deleted the bucket from the clean set, so the second file's dirty mark was
// eaten (map-order dependent — volar #5847's 50% flake). Both must land.
func TestBatchTwoFileChangesBothInvalidateRegistry(t *testing.T) {
	t.Parallel()
	if !bundled.Embedded {
		t.Skip("bundled files are not embedded")
	}
	const configFileName = "/home/projects/p/tsconfig.json"
	const aName = "/home/projects/p/a.ts"
	const bName = "/home/projects/p/b.ts"
	const mainName = "/home/projects/p/main.ts"
	files := map[string]any{
		configFileName: `{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["**/*"] }`,
		aName:          ``,
		bName:          ``,
		mainName:       `exportA; exportB;`,
	}
	projectSession, _ := projecttestutil.Setup(files)
	defer projectSession.Close()
	session := NewSession(projectSession, nil)
	defer session.Close()
	ctx := context.Background()
	mainURI := lsconv.FileNameToDocumentURI(mainName)
	prefs := lsutil.NewDefaultUserPreferences()
	prefs.IncludeCompletionsForModuleExports = core.TSTrue

	overlay := func(entries ...OpenFileWithContent) *UpdateSnapshotResponse {
		resp, err := session.handleUpdateSnapshot(ctx, &UpdateSnapshotParams{
			OpenProjects:         []OpenProjectParams{{DocumentIdentifier: DocumentIdentifier{FileName: configFileName}}},
			OpenFilesWithContent: entries,
		})
		assert.NilError(t, err)
		return resp
	}
	entry := func(name, content string) OpenFileWithContent {
		return OpenFileWithContent{FileName: name, Content: content, ScriptKind: int(core.ScriptKindTS)}
	}

	// Era 1: both files empty — build the registry.
	overlay(entry(aName, ""), entry(bName, ""))
	_, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot := projectSession.Snapshot()
	defaultProject := snapshot.GetDefaultProject(mainURI)
	assert.Assert(t, defaultProject != nil)
	projectPath := defaultProject.ConfigFilePath()
	assert.Assert(t, snapshot.AutoImportRegistry().IsPreparedForImportingFile(mainName, projectPath, prefs))

	// Era 2: BOTH files change in ONE update batch (the mark-eating shape).
	overlay(
		entry(aName, "export const exportA: number = 1;\n"),
		entry(bName, "export const exportB: number = 2;\n"),
	)
	_, err = projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
	assert.NilError(t, err)
	snapshot = projectSession.Snapshot()
	registry := snapshot.AutoImportRegistry()
	assert.Assert(t, registry.IsPreparedForImportingFile(mainName, projectPath, prefs))
	mainSF := defaultProject.GetProgram().GetSourceFile(mainName)
	view := autoimport.NewView(registry, mainSF, projectPath, defaultProject.GetProgram(), prefs.ModuleSpecifierPreferences())
	names := map[string]bool{}
	for _, e := range view.Search("export", autoimport.QueryKindWordPrefix) {
		names[e.Name()] = true
	}
	assert.Assert(t, names["exportA"], "exportA must be offered after a same-batch content change")
	assert.Assert(t, names["exportB"], "exportB must be offered after a same-batch content change (its mark was eaten before the fix)")
}
