package checker_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

// Unused type parameters must be reported with the same diagnostic codes as
// stock TypeScript:
//   - a single unused type parameter (or each individually unused one) is
//     TS6133 "'T' is declared but its value is never read." — the code stock
//     uses for unused declarations generally;
//   - TS6196 is stock's code for an unused *type declaration* (e.g. an unused
//     type alias), never for type parameters.
//
// tsgo currently reports TS6196 for a single unused type parameter while
// reporting TS6205 (matching stock) when every parameter of a multi-parameter
// list is unused — an internally inconsistent split that also breaks tooling
// filtering on stock's codes (e.g. Volar's doNotReportTs6133).
//
// Repro: go test ./internal/checker/ -run TestUnusedTypeParameterDiagnosticCode
// Actual (pristine tsgo @ 2bd066d87): TS6196 for the single-parameter case.
func TestUnusedTypeParameterDiagnosticCode(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		"/a.ts": "function f<T>() { return 1; }\nf();\n",
	}
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	fs := vfstest.FromMap(files, false)
	fs = bundled.WrapFS(fs)
	host := compiler.NewCompilerHost("/", fs, bundled.LibPath(), nil, nil)
	jsonText := fmt.Sprintf(`{"compilerOptions":{"strict":true,"noUnusedLocals":true,"noUnusedParameters":true},"files":[%q]}`, strings.Join(keys, `","`))
	var parsed any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		t.Fatal(err)
	}
	config := tsoptions.ParseJsonConfigFileContent(parsed, host, "/", nil, "/tsconfig.json", nil, nil, nil)
	program := compiler.NewProgram(compiler.ProgramOptions{Config: config, Host: host})
	_, done := program.GetTypeChecker(context.Background())
	defer done()

	diags := program.GetSuggestionDiagnostics(context.Background(), program.GetSourceFile("/a.ts"))
	if len(diags) != 1 {
		t.Fatalf("expected exactly 1 diagnostic, got %d: %v", len(diags), diags)
	}
	if got := diags[0].Code(); got != 6133 {
		t.Fatalf("unused type parameter reported as TS%d; want TS6133 (stock reserves TS6196 for unused type declarations)", got)
	}
}
