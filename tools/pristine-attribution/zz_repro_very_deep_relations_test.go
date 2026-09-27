package checker_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

// Two structurally identical 40-link interface cycles (upstream's
// veryDeepRelations test): relating A0 to B0 walks A_i -> B_i until the cycle
// closes. Stock and tsgo main cut it as deeply nested and relate the chains;
// the 7.0.2 relater overflows the stack limit first, reports TS2321, and caches
// the failed sub-relations, so the later A20 -> B20 assignment fails as well.
//
// Repro: go test ./internal/checker/ -run TestVeryDeepRelationsNoStackDepthError
// Actual (pristine tsgo @ 2bd066d87): TS2321 at `assigned`, TS2322 at `mid`.
func TestVeryDeepRelationsNoStackDepthError(t *testing.T) {
	var src strings.Builder
	for _, p := range []string{"A", "B"} {
		for i := range 40 {
			fmt.Fprintf(&src, "interface %s%d { name: string; next?: %s%d[]; }\n", p, i, p, (i+1)%40)
		}
	}
	src.WriteString("declare const a: A0;\nexport const assigned: B0 = a;\ndeclare const a20: A20;\nexport const mid: B20 = a20;\n")

	fs := vfstest.FromMap(map[string]string{
		"/a.ts":          src.String(),
		"/tsconfig.json": `{"compilerOptions":{"strict":true,"target":"es2022","types":[]},"files":["a.ts"]}`,
	}, false)
	fs = bundled.WrapFS(fs)
	host := compiler.NewCompilerHost("/", fs, bundled.LibPath(), nil, nil)
	parsed, errs := tsoptions.GetParsedCommandLineOfConfigFile("/tsconfig.json", &core.CompilerOptions{}, nil, host, nil)
	if len(errs) != 0 {
		t.Fatalf("config errors: %v", errs)
	}
	program := compiler.NewProgram(compiler.ProgramOptions{Config: parsed, Host: host})

	diags := program.GetSemanticDiagnostics(context.Background(), program.GetSourceFile("/a.ts"))
	var got []string
	for _, d := range diags {
		got = append(got, fmt.Sprintf("TS%d", d.Code()))
	}
	if len(got) != 0 {
		t.Fatalf("semantic diagnostics = %v; want none", got)
	}
}
