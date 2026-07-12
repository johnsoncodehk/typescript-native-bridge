package checker

import (
	"github.com/microsoft/typescript-go/internal/ast"
)

// CollectVisitedTypeParameters walks the type graph like stock symbolWalker.ts
// visitType (accept always true) and returns only visited types with
// TypeFlagsTypeParameter.
func (c *Checker) CollectVisitedTypeParameters(t *Type) []*Type {
	w := &symbolWalker{
		c:              c,
		visitedTypes:   make(map[TypeId]bool),
		visitedSymbols: make(map[ast.SymbolId]bool),
	}
	w.visitType(t)
	return w.typeParameters
}

type symbolWalker struct {
	c              *Checker
	visitedTypes   map[TypeId]bool
	visitedSymbols map[ast.SymbolId]bool
	typeParameters []*Type
}

func (w *symbolWalker) visitType(t *Type) {
	if t == nil {
		return
	}
	if w.visitedTypes[t.id] {
		return
	}
	w.visitedTypes[t.id] = true
	if t.flags&TypeFlagsTypeParameter != 0 {
		w.typeParameters = append(w.typeParameters, t)
	}

	// Reuse visitSymbol to visit the type's symbol; bail if accept declines
	// (accept always returns true for this narrow RPC).
	if w.visitSymbol(t.symbol) {
		return
	}

	if t.flags&TypeFlagsObject != 0 {
		objectFlags := t.objectFlags
		if objectFlags&ObjectFlagsReference != 0 {
			w.visitTypeReference(t)
		}
		if objectFlags&ObjectFlagsMapped != 0 {
			w.visitMappedType(t)
		}
		if objectFlags&(ObjectFlagsClass|ObjectFlagsInterface) != 0 {
			w.visitInterfaceType(t)
		}
		if objectFlags&(ObjectFlagsTuple|ObjectFlagsAnonymous) != 0 {
			w.visitObjectType(t)
		}
	}
	if t.flags&TypeFlagsTypeParameter != 0 {
		w.visitTypeParameter(t)
	}
	if t.flags&TypeFlagsUnionOrIntersection != 0 {
		w.visitUnionOrIntersectionType(t)
	}
	if t.flags&TypeFlagsIndex != 0 {
		w.visitIndexType(t)
	}
	if t.flags&TypeFlagsIndexedAccess != 0 {
		w.visitIndexedAccessType(t)
	}
}

func (w *symbolWalker) visitTypeReference(t *Type) {
	w.visitType(t.Target())
	for _, arg := range w.c.getTypeArguments(t) {
		w.visitType(arg)
	}
}

func (w *symbolWalker) visitTypeParameter(t *Type) {
	w.visitType(w.c.getConstraintOfTypeParameter(t))
}

func (w *symbolWalker) visitUnionOrIntersectionType(t *Type) {
	for _, part := range t.Types() {
		w.visitType(part)
	}
}

func (w *symbolWalker) visitIndexType(t *Type) {
	w.visitType(t.AsIndexType().target)
}

func (w *symbolWalker) visitIndexedAccessType(t *Type) {
	d := t.AsIndexedAccessType()
	w.visitType(d.objectType)
	w.visitType(d.indexType)
	// Stock IndexedAccessType.constraint is an optional cached field rarely set;
	// Go does not store it — visit nil equivalent (no-op).
}

func (w *symbolWalker) visitMappedType(t *Type) {
	// Stock visits MappedType fields directly (may be nil if not yet resolved).
	m := t.AsMappedType()
	w.visitType(m.typeParameter)
	w.visitType(m.constraintType)
	w.visitType(m.templateType)
	w.visitType(m.modifiersType)
}

func (w *symbolWalker) visitSignature(signature *Signature) {
	if typePredicate := w.c.getTypePredicateOfSignature(signature); typePredicate != nil {
		w.visitType(typePredicate.t)
	}
	for _, tp := range signature.typeParameters {
		w.visitType(tp)
	}
	for _, parameter := range signature.parameters {
		w.visitSymbol(parameter)
	}
	w.visitType(w.c.getRestTypeOfSignature(signature))
	w.visitType(w.c.getReturnTypeOfSignature(signature))
}

func (w *symbolWalker) visitInterfaceType(t *Type) {
	w.visitObjectType(t)
	iface := t.AsInterfaceType()
	for _, tp := range iface.TypeParameters() {
		w.visitType(tp)
	}
	for _, base := range w.c.getBaseTypes(t) {
		w.visitType(base)
	}
	w.visitType(iface.thisType)
}

func (w *symbolWalker) visitObjectType(t *Type) {
	resolved := w.c.resolveStructuredTypeMembers(t)
	for _, info := range resolved.indexInfos {
		w.visitType(info.keyType)
		w.visitType(info.valueType)
	}
	for _, signature := range resolved.CallSignatures() {
		w.visitSignature(signature)
	}
	for _, signature := range resolved.ConstructSignatures() {
		w.visitSignature(signature)
	}
	for _, p := range resolved.properties {
		w.visitSymbol(p)
	}
}

// visitSymbol returns true if the walker should bail on recurring into the type
// (accept declined). Accept always returns true here, so shouldBail is always false
// after a successful visit; returns false when symbol is nil / already visited.
func (w *symbolWalker) visitSymbol(symbol *ast.Symbol) bool {
	if symbol == nil {
		return false
	}
	symbolId := ast.GetSymbolId(symbol)
	if w.visitedSymbols[symbolId] {
		return false
	}
	w.visitedSymbols[symbolId] = true
	// accept always true for this narrow RPC
	w.visitType(w.c.getTypeOfSymbol(symbol))
	if symbol.Exports != nil {
		for _, exported := range symbol.Exports {
			w.visitSymbol(exported)
		}
	}
	for _, d := range symbol.Declarations {
		if d != nil && d.Type() != nil && d.Type().Kind == ast.KindTypeQuery {
			query := d.Type().AsTypeQueryNode()
			entity := w.c.GetResolvedSymbol(ast.GetFirstIdentifier(query.ExprName))
			w.visitSymbol(entity)
		}
	}
	return false
}
