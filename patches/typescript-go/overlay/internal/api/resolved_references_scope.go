package api

import "github.com/microsoft/typescript-go/internal/ast"

const (
	ResolvedReferencesScopeDeclarationNames = "declarationNames"
	// Identifiers resolves every Identifier / PrivateIdentifier except member-name
	// positions (PropertyAccessExpression.Name, QualifiedName.Right). Member names
	// require type-directed resolution; other identifiers use binder/cheap paths.
	ResolvedReferencesScopeIdentifiers = "identifiers"
	// AllIdentifiers resolves every Identifier / PrivateIdentifier including member
	// names. Used for batch prefetch where type-directed member resolution is
	// amortized across one checker acquisition per file.
	ResolvedReferencesScopeAllIdentifiers = "allIdentifiers"
)

// isNonMemberIdentifier returns true for identifier nodes that are not the
// member-name slot of a property access or qualified name.
func isNonMemberIdentifier(node *ast.Node) bool {
	if node == nil || (!ast.IsIdentifier(node) && node.Kind != ast.KindPrivateIdentifier) {
		return false
	}
	parent := node.Parent
	if parent == nil {
		return true
	}
	switch parent.Kind {
	case ast.KindPropertyAccessExpression:
		return parent.AsPropertyAccessExpression().Name() != node
	case ast.KindQualifiedName:
		return parent.AsQualifiedName().Right != node
	default:
		return true
	}
}
