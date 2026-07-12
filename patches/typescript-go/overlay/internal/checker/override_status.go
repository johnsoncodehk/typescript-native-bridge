package checker

import (
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/core"
)

// MemberOverrideStatus mirrors stock MemberOverrideStatus (types.ts).
type MemberOverrideStatus int32

const (
	MemberOverrideStatusOk MemberOverrideStatus = iota
	MemberOverrideStatusNeedsOverride
	MemberOverrideStatusHasInvalidOverride
)

// GetMemberOverrideModifierStatus is a speculative API for completions.
// ClassElement is synthetic in completions; pass modifier flags from the JS adapter.
// Mirrors stock getMemberOverrideModifierStatus (checker.ts) with errorNode=nil
// (status only; does not report diagnostics).
func (c *Checker) GetMemberOverrideModifierStatus(
	node *ast.Node, // ClassLike
	memberSymbol *ast.Symbol,
	memberHasOverrideModifier bool,
	memberHasAbstractModifier bool,
	memberIsStatic bool,
	memberHasName bool,
) MemberOverrideStatus {
	if !memberHasName {
		return MemberOverrideStatusOk
	}

	classSymbol := c.getSymbolOfDeclaration(node)
	t := c.getDeclaredTypeOfSymbol(classSymbol)
	typeWithThis := c.getTypeWithThisArgument(t, nil, false)
	staticType := c.getTypeOfSymbol(classSymbol)

	var baseWithThis *Type
	baseTypeNode := ast.GetExtendsHeritageClauseElement(node)
	if baseTypeNode != nil {
		baseTypes := c.getBaseTypes(t)
		if len(baseTypes) > 0 {
			baseWithThis = c.getTypeWithThisArgument(core.FirstOrNil(baseTypes), t.AsInterfaceType().thisType, false)
		}
	}
	baseStaticType := c.getBaseConstructorTypeOfClass(t)

	return c.memberOverrideModifierStatus(
		node,
		staticType,
		baseStaticType,
		baseWithThis,
		t,
		typeWithThis,
		memberHasOverrideModifier,
		memberHasAbstractModifier,
		memberIsStatic,
		memberSymbol,
	)
}

// memberOverrideModifierStatus mirrors stock checkMemberForOverrideModifier with
// errorNode=nil: returns status without emitting diagnostics.
func (c *Checker) memberOverrideModifierStatus(
	node *ast.Node,
	staticType *Type,
	baseStaticType *Type,
	baseWithThis *Type,
	t *Type,
	typeWithThis *Type,
	memberHasOverrideModifier bool,
	memberHasAbstractModifier bool,
	memberIsStatic bool,
	member *ast.Symbol,
) MemberOverrideStatus {
	// 1. override on class element with non-bindable dynamic name
	if memberHasOverrideModifier && member != nil && member.ValueDeclaration != nil &&
		ast.IsClassElement(member.ValueDeclaration) && member.ValueDeclaration.Name() != nil &&
		c.isNonBindableDynamicName(member.ValueDeclaration.Name()) {
		return MemberOverrideStatusHasInvalidOverride
	}

	// 2. has base && (override || noImplicitOverride)
	if baseWithThis != nil && member != nil && (memberHasOverrideModifier || c.compilerOptions.NoImplicitOverride.IsTrue()) {
		thisType := core.IfElse(memberIsStatic, staticType, typeWithThis)
		baseType := core.IfElse(memberIsStatic, baseStaticType, baseWithThis)
		prop := c.getPropertyOfType(thisType, member.Name)
		baseProp := c.getPropertyOfType(baseType, member.Name)

		// 2b. prop && !baseProp && override
		if prop != nil && baseProp == nil && memberHasOverrideModifier {
			return MemberOverrideStatusHasInvalidOverride
		}

		// 2c. prop && baseProp.declarations && noImplicitOverride && !ambient
		if prop != nil && baseProp != nil && len(baseProp.Declarations) != 0 &&
			c.compilerOptions.NoImplicitOverride.IsTrue() && node.Flags&ast.NodeFlagsAmbient == 0 {
			baseHasAbstract := core.Some(baseProp.Declarations, ast.HasAbstractModifier)
			if memberHasOverrideModifier {
				return MemberOverrideStatusOk
			}
			if !baseHasAbstract {
				return MemberOverrideStatusNeedsOverride
			}
			if memberHasAbstractModifier && baseHasAbstract {
				return MemberOverrideStatusNeedsOverride
			}
		}
	} else if memberHasOverrideModifier {
		// 3. override with no base
		return MemberOverrideStatusHasInvalidOverride
	}

	// 4. else Ok
	return MemberOverrideStatusOk
}
