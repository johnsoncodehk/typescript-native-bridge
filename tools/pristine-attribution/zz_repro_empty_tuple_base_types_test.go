package checker_test

import (
	"context"
	"testing"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

// The empty tuple type an array literal gets from its `[]` contextual type
// (`export const empty: [] = [];`) is the createArrayLiteralType clone of the
// arity-0 tuple target: its objectFlags carry Tuple while its data is a
// *TypeReference, so getBaseTypes' AsInterfaceType() is nil and the checker
// nil-dereferences — a fatal panic, not a catchable error, on the API the
// linter ecosystem calls.
//
// Repro: go test ./internal/checker/ -run TestEmptyTupleLiteralBaseTypes
// Actual (pristine tsgo @ 2bd066d87): panic: runtime error: invalid memory
// address or nil pointer dereference, checker.(*Checker).getBaseTypes.
func TestEmptyTupleLiteralBaseTypes(t *testing.T) {
	fs := vfstest.FromMap(map[string]string{
		"/a.ts":          "export const empty: [] = [];\n",
		"/tsconfig.json": `{"compilerOptions":{"strict":true,"target":"es2022","types":[]},"files":["a.ts"]}`,
	}, false)
	fs = bundled.WrapFS(fs)
	host := compiler.NewCompilerHost("/", fs, bundled.LibPath(), nil, nil)
	parsed, errs := tsoptions.GetParsedCommandLineOfConfigFile("/tsconfig.json", &core.CompilerOptions{}, nil, host, nil)
	if len(errs) != 0 {
		t.Fatalf("config errors: %v", errs)
	}
	program := compiler.NewProgram(compiler.ProgramOptions{Config: parsed, Host: host})

	sf := program.GetSourceFile("/a.ts")
	var literal *ast.Node
	var walk ast.Visitor
	walk = func(n *ast.Node) bool {
		if literal == nil && n.Kind == ast.KindArrayLiteralExpression {
			literal = n
		}
		n.ForEachChild(walk)
		return false
	}
	sf.AsNode().ForEachChild(walk)
	if literal == nil {
		t.Fatal("no array literal in a.ts")
	}

	c, done := program.GetTypeChecker(context.Background())
	defer done()
	typ := c.GetTypeAtLocation(literal)
	if got := c.TypeToString(typ); got != "[]" {
		t.Fatalf("literal type = %q; want \"[]\"", got)
	}
	bases := c.GetBaseTypes(typ)
	if len(bases) != 1 {
		t.Fatalf("GetBaseTypes([] literal) returned %d base types; want 1 (never[])", len(bases))
	}
	if got := c.TypeToString(bases[0]); got != "never[]" {
		t.Fatalf("GetBaseTypes([] literal)[0] = %q; want exactly never[] (the literal clone is mutable)", got)
	}
}
