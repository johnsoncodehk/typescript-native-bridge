package checker

// TNB additions to package checker, kept out of printer.go so its in-place patch
// carries only edits to upstream code.

import (
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/nodebuilder"
)

func (c *Checker) TypeParameterToDeclaration(t *Type, enclosingDeclaration *ast.Node, flags nodebuilder.Flags) *ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.TypeParameterToDeclaration(t, enclosingDeclaration, flags, nodebuilder.InternalFlagsNone, nil)
}

func (c *Checker) SymbolToTypeParameterDeclarations(symbol *ast.Symbol, enclosingDeclaration *ast.Node, flags nodebuilder.Flags) []*ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.SymbolToTypeParameterDeclarations(symbol, enclosingDeclaration, flags, nodebuilder.InternalFlagsNone, nil)
}

func (c *Checker) SymbolToParameterDeclaration(symbol *ast.Symbol, enclosingDeclaration *ast.Node, flags nodebuilder.Flags) *ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.SymbolToParameterDeclaration(symbol, enclosingDeclaration, flags, nodebuilder.InternalFlagsNone, nil)
}

func (c *Checker) SymbolToExpression(symbol *ast.Symbol, meaning ast.SymbolFlags, enclosingDeclaration *ast.Node, flags nodebuilder.Flags, internalFlags nodebuilder.InternalFlags) *ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.SymbolToExpression(symbol, meaning, enclosingDeclaration, flags, internalFlags, nil)
}

func (c *Checker) SymbolToNode(symbol *ast.Symbol, meaning ast.SymbolFlags, enclosingDeclaration *ast.Node, flags nodebuilder.Flags, internalFlags nodebuilder.InternalFlags) *ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.SymbolToNode(symbol, meaning, enclosingDeclaration, flags, internalFlags, nil)
}

func (c *Checker) SymbolToEntityName(symbol *ast.Symbol, meaning ast.SymbolFlags, enclosingDeclaration *ast.Node, flags nodebuilder.Flags, internalFlags nodebuilder.InternalFlags) *ast.Node {
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.SymbolToEntityName(symbol, meaning, enclosingDeclaration, flags, internalFlags, nil)
}

// TypePredicateToTypePredicateNodeFromParts reconstructs a TypePredicate from
// wire fields (no TypePredicate handle registry) and builds the AST node.
func (c *Checker) TypePredicateToTypePredicateNodeFromParts(kind TypePredicateKind, parameterName string, parameterIndex int32, t *Type, enclosingDeclaration *ast.Node, flags nodebuilder.Flags) *ast.Node {
	pred := c.newTypePredicate(kind, parameterName, parameterIndex, t)
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.TypePredicateToTypePredicateNode(pred, enclosingDeclaration, flags, nodebuilder.InternalFlagsNone, nil)
}

// IndexInfoToIndexSignatureDeclaration reconstructs IndexInfo from wire fields
// (key/value/readonly/declaration; no IndexInfo handle) and builds the AST.
func (c *Checker) IndexInfoToIndexSignatureDeclaration(keyType, valueType *Type, isReadonly bool, declaration, enclosingDeclaration *ast.Node, flags nodebuilder.Flags) *ast.Node {
	info := c.newIndexInfo(keyType, valueType, isReadonly, declaration, nil)
	nodeBuilder, release := c.getNodeBuilder()
	defer release()
	return nodeBuilder.IndexInfoToIndexSignatureDeclaration(info, enclosingDeclaration, flags, nodebuilder.InternalFlagsNone, nil)
}
