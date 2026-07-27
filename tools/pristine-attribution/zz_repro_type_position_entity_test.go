package checker_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/internal/astnav"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

// An entity name in type position inside an indexed access —
// the `P` in `(typeof OBJ)[P][number]` — must resolve to the type
// parameter P. Stock TypeScript reads it as the type parameter; tsgo
// resolves the name to `any` (TypeFlags.Any), so downstream queries
// (hover, completion on the constraint) lose the symbol entirely.
//
// Repro: go test ./internal/checker/ -run TestTypePositionEntityInIndexedAccess
// Actual (pristine tsgo @ 2bd066d87): intrinsic `any`, not the type parameter.
func TestTypePositionEntityInIndexedAccess(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		"/a.ts": "type OBJ = { p: number };\nfunction f<P>(x: [P, (typeof OBJ)[P][number]]) { const y = x[1]; }",
	}
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	fs := vfstest.FromMap(files, false)
	fs = bundled.WrapFS(fs)
	host := compiler.NewCompilerHost("/", fs, bundled.LibPath(), nil, nil)
	jsonText := fmt.Sprintf(`{"compilerOptions":{"strict":true},"files":[%q]}`, strings.Join(keys, `","`))
	var parsed any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		t.Fatal(err)
	}
	config := tsoptions.ParseJsonConfigFileContent(parsed, host, "/", nil, "/tsconfig.json", nil, nil, nil)
	program := compiler.NewProgram(compiler.ProgramOptions{Config: config, Host: host})

	sf := program.GetSourceFile("/a.ts")
	// The P inside the indexed access (typeof OBJ)[P][number]
	idx := strings.LastIndex(sf.Text(), "[P]")
	if idx < 0 {
		t.Fatal("no [P]")
	}
	node := astnav.GetTouchingPropertyName(sf, idx+1)
	c, done := program.GetTypeChecker(context.Background())
	defer done()
	typ := c.GetTypeAtLocation(node)
	if typ.Flags()&checker.TypeFlagsAny != 0 {
		t.Fatalf("type of P in (typeof OBJ)[P][number] resolved to any; want the type parameter P (got %v, flags=%v)", c.TypeToString(typ), typ.Flags())
	}
	if got := c.TypeToString(typ); got != "P" {
		t.Fatalf("type of P in (typeof OBJ)[P][number] = %q; want \"P\"", got)
	}
}
