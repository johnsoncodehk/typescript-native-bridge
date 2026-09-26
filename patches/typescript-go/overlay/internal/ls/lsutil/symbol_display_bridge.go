package lsutil

// TNB additions to package lsutil, kept out of symbol_display.go so its in-place patch
// carries only edits to upstream code.

import (
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/core"
)

// GetSymbolModifiersText mirrors Strada's SymbolDisplay.getSymbolModifiers:
// the first declaration's modifiers in getNodeModifiers order, then (for
// aliases) the resolved target's, insertion-deduped, optional last. The order
// is observable ("export,declare" for a direct export, "declare,export" for an
// ambient re-export alias) and lost if taken from the bitmask.
func GetSymbolModifiersText(typeChecker *checker.Checker, symbol *ast.Symbol) string {
	if symbol == nil {
		return ""
	}
	seen := make(map[string]struct{})
	var out []string
	add := func(mods []string) {
		for _, m := range mods {
			if _, ok := seen[m]; !ok {
				seen[m] = struct{}{}
				out = append(out, m)
			}
		}
	}
	add(getNormalizedSymbolModifiersText(typeChecker, symbol))
	if symbol.Flags&ast.SymbolFlagsAlias != 0 && typeChecker != nil {
		if resolvedSymbol := typeChecker.GetAliasedSymbol(symbol); resolvedSymbol != symbol {
			add(getNormalizedSymbolModifiersText(typeChecker, resolvedSymbol))
		}
	}
	if symbol.Flags&ast.SymbolFlagsOptional != 0 {
		add([]string{"optional"})
	}
	return strings.Join(out, ",")
}

func getNormalizedSymbolModifiersText(typeChecker *checker.Checker, symbol *ast.Symbol) []string {
	if len(symbol.Declarations) == 0 {
		return nil
	}
	declaration := symbol.Declarations[0]
	declarations := symbol.Declarations[1:]
	// omit deprecated flag if some declarations are not deprecated
	var excludeFlags ast.ModifierFlags
	if len(declarations) > 0 &&
		isDeprecatedDeclaration(typeChecker, declaration) &&
		core.Some(declarations, func(d *ast.Node) bool { return !isDeprecatedDeclaration(typeChecker, d) }) {
		excludeFlags = ast.ModifierFlagsDeprecated
	} else {
		excludeFlags = ast.ModifierFlagsNone
	}
	return getNodeModifiersText(typeChecker, declaration, excludeFlags)
}

func getNodeModifiersText(typeChecker *checker.Checker, node *ast.Node, excludeFlags ast.ModifierFlags) []string {
	var out []string
	var flags ast.ModifierFlags
	if ast.IsDeclaration(node) {
		flags = ast.GetCombinedModifierFlags(node)
		if isDeprecatedDeclaration(typeChecker, node) {
			flags |= ast.ModifierFlagsDeprecated
		}
		flags &^= excludeFlags
	}
	if flags&ast.ModifierFlagsPrivate != 0 {
		out = append(out, "private")
	}
	if flags&ast.ModifierFlagsProtected != 0 {
		out = append(out, "protected")
	}
	if flags&ast.ModifierFlagsPublic != 0 {
		out = append(out, "public")
	}
	if flags&ast.ModifierFlagsStatic != 0 || node.Kind == ast.KindClassStaticBlockDeclaration {
		out = append(out, "static")
	}
	if flags&ast.ModifierFlagsAbstract != 0 {
		out = append(out, "abstract")
	}
	if flags&ast.ModifierFlagsExport != 0 {
		out = append(out, "export")
	}
	if flags&ast.ModifierFlagsDeprecated != 0 {
		out = append(out, "deprecated")
	}
	if node.Flags&ast.NodeFlagsAmbient != 0 {
		out = append(out, "declare")
	}
	if node.Kind == ast.KindExportAssignment {
		out = append(out, "export")
	}
	return out
}
