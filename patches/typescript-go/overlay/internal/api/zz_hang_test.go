package api

import (
	"context"
	"testing"
	"time"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/ls/lsconv"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/testutil/projecttestutil"
	"gotest.tools/v3/assert"
)

// era-1: fixture empty, completions with auto-imports (registry built empty);
// era-2: fixture gets content, completions again, then once more (the hang case).
func TestSecondCompletionsAfterRegistryRebuildDoesNotHang(t *testing.T) {
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

	projectSession.DidOpenFile(ctx, mainURI, 1, "testFn;\n", lsproto.LanguageKindTypeScript)
	if _, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI); err != nil {
		t.Fatal(err)
	}

	// era 2: fixture gets content via a whole-document didChange.
	fixtureURI := lsconv.FileNameToDocumentURI(fixtureName)
	projectSession.DidOpenFile(ctx, fixtureURI, 1, "", lsproto.LanguageKindTypeScript)
	projectSession.DidChangeFile(ctx, fixtureURI, 2, []lsproto.TextDocumentContentChangePartialOrWholeDocument{
		{WholeDocument: &lsproto.TextDocumentContentChangeWholeDocument{Text: "export function testFn() { console.log('testFn'); }\n"}},
	})

	for i := 1; i <= 3; i++ {
		done := make(chan error, 1)
		go func() {
			_, err := projectSession.GetCurrentLanguageServiceWithAutoImports(ctx, mainURI)
			done <- err
		}()
		select {
		case err := <-done:
			assert.NilError(t, err)
		case <-time.After(20 * time.Second):
			t.Fatalf("completion %d hung", i)
		}
	}
}
