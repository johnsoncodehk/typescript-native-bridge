package ls

import (
	"testing"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/parser"
)

// Find-all-references on a module specifier must attach a context node to
// each entry (stock TypeScript returns the enclosing import statement, which
// becomes ReferenceEntry.contextSpan in the protocol).
//
// tsgo's port of getContextNodeForNodeEntry broke the branch three ways:
//  1. the string-literal handling is keyed `case ast.KindStringLiteral` under
//     `switch node.Parent.Kind`, but stock keys on the node itself
//     (`else if (isStringLiteralLike(node))`) — string literals are leaves,
//     so a module-specifier literal never matches its own parent's kind here;
//  2. the FindAncestor predicate ignores its parameter and tests the captured
//     outer `node`, so even a reached branch walks off the tree and returns nil;
//  3. the outer `!ast.IsDeclaration(node.Parent)` gate treats the enclosing
//     ImportDeclaration as a declaration (stock's isDeclaration in this path
//     does not), skipping the special-case block entirely.
//
// Repro: go test ./internal/ls/ -run TestModuleSpecifierContextNode
// Actual (pristine tsgo @ 2bd066d87): nil context for the "./b" literal.
func TestModuleSpecifierContextNode(t *testing.T) {
	t.Parallel()
	text := "import { x } from \"./b\";\nx;\n"
	sourceFile := parser.ParseSourceFile(ast.SourceFileParseOptions{
		FileName: "/a.ts",
		Path:     "/a.ts",
	}, text, core.ScriptKindTS)

	var literal *ast.Node
	for _, stmt := range sourceFile.Statements.Nodes {
		if ast.IsImportDeclaration(stmt) {
			literal = stmt.AsImportDeclaration().ModuleSpecifier
		}
	}
	if literal == nil || literal.Kind != ast.KindStringLiteral {
		t.Fatalf("module specifier literal not found: %v", literal)
	}
	if ctx := getContextNodeForNodeEntry(literal); ctx == nil {
		t.Fatal("getContextNodeForNodeEntry(module specifier) = nil; want the enclosing import statement (stock attaches contextSpan)")
	}
}
