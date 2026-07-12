package checker

import (
	"github.com/microsoft/typescript-go/internal/ast"
)

// GetSymbolOfExpando mirrors stock getSymbolOfExpando (checker.ts:37745).
func (c *Checker) GetSymbolOfExpando(node *ast.Node, allowDeclaration bool) *ast.Symbol {
	if node.Parent == nil {
		return nil
	}

	var name *ast.Node
	var decl *ast.Node

	if ast.IsVariableDeclaration(node.Parent) && node.Parent.Initializer() == node {
		if !ast.IsInJSFile(node) && !(c.isVarConstLike(node.Parent) && ast.IsFunctionLikeDeclaration(node)) {
			return nil
		}
		name = node.Parent.Name()
		decl = node.Parent
	} else if ast.IsBinaryExpression(node.Parent) {
		parentNode := node.Parent
		parentNodeOperator := parentNode.AsBinaryExpression().OperatorToken.Kind
		if parentNodeOperator == ast.KindEqualsToken && (allowDeclaration || parentNode.AsBinaryExpression().Right == node) {
			name = parentNode.AsBinaryExpression().Left
			decl = name
		} else if parentNodeOperator == ast.KindBarBarToken || parentNodeOperator == ast.KindQuestionQuestionToken {
			if ast.IsVariableDeclaration(parentNode.Parent) && parentNode.Parent.Initializer() == parentNode {
				name = parentNode.Parent.Name()
				decl = parentNode.Parent
			} else if ast.IsBinaryExpression(parentNode.Parent) &&
				parentNode.Parent.AsBinaryExpression().OperatorToken.Kind == ast.KindEqualsToken &&
				(allowDeclaration || parentNode.Parent.AsBinaryExpression().Right == parentNode) {
				name = parentNode.Parent.AsBinaryExpression().Left
				decl = name
			}

			if name == nil || !ast.IsBindableStaticNameExpression(name, false /*excludeThisKeyword*/) ||
				!isSameEntityName(name, parentNode.AsBinaryExpression().Left) {
				return nil
			}
		}
	} else if allowDeclaration && ast.IsFunctionDeclaration(node) {
		name = node.Name()
		decl = node
	}

	if decl == nil || name == nil || (!allowDeclaration && getExpandoInitializer(node, ast.IsPrototypeAccess(name)) == nil) {
		return nil
	}
	return c.getSymbolOfNode(decl)
}

// getExpandoInitializer mirrors stock getExpandoInitializer (utilities.ts:3994).
func getExpandoInitializer(initializer *ast.Node, isPrototypeAssignment bool) *ast.Node {
	if initializer == nil {
		return nil
	}
	if ast.IsCallExpression(initializer) {
		e := ast.SkipParentheses(initializer.Expression())
		if e.Kind == ast.KindFunctionExpression || e.Kind == ast.KindArrowFunction {
			return initializer
		}
		return nil
	}
	if initializer.Kind == ast.KindFunctionExpression ||
		initializer.Kind == ast.KindClassExpression ||
		initializer.Kind == ast.KindArrowFunction {
		return initializer
	}
	if ast.IsObjectLiteralExpression(initializer) &&
		(len(initializer.Properties()) == 0 || isPrototypeAssignment) {
		return initializer
	}
	return nil
}

// isLiteralLikeAccess mirrors stock isLiteralLikeAccess (utilities.ts:4132).
func isLiteralLikeAccess(node *ast.Node) bool {
	return ast.IsPropertyAccessExpression(node) || ast.IsLiteralLikeElementAccess(node)
}

// getNameOrArgument mirrors stock getNameOrArgument (utilities.ts:4171).
func getNameOrArgument(expr *ast.Node) *ast.Node {
	if ast.IsPropertyAccessExpression(expr) {
		return expr.Name()
	}
	return expr.AsElementAccessExpression().ArgumentExpression
}

// isSameEntityName mirrors stock isSameEntityName (utilities.ts:4064).
func isSameEntityName(name *ast.Node, initializer *ast.Node) bool {
	if name == nil || initializer == nil {
		return false
	}
	if ast.IsPropertyNameLiteral(name) && ast.IsPropertyNameLiteral(initializer) {
		return name.Text() == initializer.Text()
	}
	if ast.IsMemberName(name) && isLiteralLikeAccess(initializer) {
		expr := initializer.Expression()
		if expr.Kind == ast.KindThisKeyword ||
			(ast.IsIdentifier(expr) &&
				(expr.Text() == "window" || expr.Text() == "self" || expr.Text() == "global")) {
			return isSameEntityName(name, getNameOrArgument(initializer))
		}
	}
	if isLiteralLikeAccess(name) && isLiteralLikeAccess(initializer) {
		nameAccess := ast.GetElementOrPropertyAccessName(name)
		initAccess := ast.GetElementOrPropertyAccessName(initializer)
		if nameAccess == nil || initAccess == nil || nameAccess.Text() != initAccess.Text() {
			return false
		}
		return isSameEntityName(name.Expression(), initializer.Expression())
	}
	return false
}
