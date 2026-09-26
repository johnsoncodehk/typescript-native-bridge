package checker

// TNB additions to package checker, kept out of exports.go so its in-place patch
// carries only edits to upstream code.

import (
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/debug"
	"github.com/microsoft/typescript-go/internal/jsnum"
)

func (c *Checker) GetNonPrimitiveType() *Type {
	return c.nonPrimitiveType
}

func (c *Checker) GetStringLiteralType(value string) *Type {
	return c.getStringLiteralType(value)
}

func (c *Checker) GetNumberLiteralType(value jsnum.Number) *Type {
	return c.getNumberLiteralType(value)
}

func (c *Checker) GetBigIntLiteralType(value jsnum.PseudoBigInt) *Type {
	return c.getBigIntLiteralType(value)
}

func (c *Checker) LookupSymbolForPrivateIdentifierDeclaration(propName string, location *ast.Node) *ast.Symbol {
	return c.lookupSymbolForPrivateIdentifierDeclaration(propName, location)
}

// GetTypeArgumentsForResolvedSignature mirrors stock: undefined when the
// signature has no mapper, else the (target ?? signature)'s type parameters
// instantiated by the mapper.
func (c *Checker) GetTypeArgumentsForResolvedSignature(sig *Signature) []*Type {
	if sig.mapper == nil {
		return nil
	}
	source := sig
	if sig.target != nil {
		source = sig.target
	}
	return c.instantiateTypes(source.typeParameters, sig.mapper)
}

func (c *Checker) GetFullyQualifiedName(symbol *ast.Symbol, containingLocation *ast.Node) string {
	return c.getFullyQualifiedName(symbol, containingLocation)
}

func (c *Checker) GetRecursionIdentity(t *Type) RecursionId {
	return getRecursionIdentity(t)
}

// GetSymbolOfDeclaration returns the symbol bound to a declaration node.
func (c *Checker) GetSymbolOfDeclaration(node *ast.Node) *ast.Symbol {
	if node == nil {
		return nil
	}
	return c.getSymbolOfDeclaration(node)
}

// GetIndexInfosAtLocation mirrors stock getIndexInfosAtLocation.
// Returns (nil, false) when node is not a property-access name (stock: undefined).
// Returns (infos, true) otherwise — infos may be empty.
func (c *Checker) GetIndexInfosAtLocation(node *ast.Node) ([]*IndexInfo, bool) {
	if ast.IsIdentifier(node) && ast.IsPropertyAccessExpression(node.Parent) && node.Parent.Name() == node {
		keyType := c.getLiteralTypeFromPropertyName(node)
		objectType := c.getTypeOfExpression(node.Parent.Expression())
		var result []*IndexInfo
		for _, t := range objectType.Distributed() {
			result = append(result, c.getApplicableIndexInfos(t, keyType)...)
		}
		if result == nil {
			result = []*IndexInfo{}
		}
		return result, true
	}
	return nil, false
}

// IsImplementationOfOverload reports whether a signature declaration is the
// implementation body of an overload set (stock TypeChecker.isImplementationOfOverload).
// Logic lives on EmitResolver; thin Checker wrapper matches isOptionalParameter shape.
func (c *Checker) IsImplementationOfOverload(node *ast.Node) bool {
	if node == nil {
		return false
	}
	return c.GetEmitResolver().IsImplementationOfOverload(node)
}

func (c *Checker) GetAwaitedType(t *Type) *Type {
	return c.getAwaitedType(t)
}

func (c *Checker) GetNullableType(t *Type, flags TypeFlags) *Type {
	return c.getNullableType(t, flags)
}

func (c *Checker) GetIndexInfoOfTypeByKind(t *Type, kind int32) *IndexInfo {
	key := c.stringType
	if kind == 1 {
		key = c.numberType
	}
	return c.getIndexInfoOfType(t, key)
}

func (c *Checker) GetIndexTypeOfTypeByKind(t *Type, kind int32) *Type {
	key := c.stringType
	if kind == 1 {
		key = c.numberType
	}
	return c.getIndexTypeOfType(t, key)
}

func (c *Checker) GetUnmatchedProperties(source, target *Type, requireOptionalProperties, matchDiscriminantProperties bool) []*ast.Symbol {
	return c.getUnmatchedProperties(source, target, requireOptionalProperties, matchDiscriminantProperties)
}

func (c *Checker) SymbolIsValue(symbol *ast.Symbol) bool {
	return c.symbolIsValue(symbol)
}

func (c *Checker) GetIndexInfosOfIndexSymbol(indexSymbol *ast.Symbol, siblingSymbols []*ast.Symbol) []*IndexInfo {
	return c.getIndexInfosOfIndexSymbol(indexSymbol, siblingSymbols)
}

func (c *Checker) ContainsArgumentsReference(node *ast.Node) bool {
	return c.containsArgumentsReference(node)
}

func (c *Checker) GetAugmentedPropertiesOfType(t *Type) []*ast.Symbol {
	return c.getAugmentedPropertiesOfType(t)
}

func (c *Checker) IsLibType(t *Type) bool {
	return c.IsLibTypeForHoverVerbosity(t)
}

func (c *Checker) GetSuggestedSymbolForNonexistentProperty(name *ast.Node, containingType *Type) *ast.Symbol {
	return c.getSuggestedSymbolForNonexistentProperty(name, containingType)
}

func (c *Checker) GetSuggestedSymbolForNonexistentClassMember(name string, baseType *Type) *ast.Symbol {
	return c.getSuggestedSymbolForNonexistentClassMember(name, baseType)
}

func (c *Checker) GetSuggestedSymbolForNonexistentJSXAttribute(name string, containingType *Type) *ast.Symbol {
	return c.getSuggestedSymbolForNonexistentJSXAttribute(name, containingType)
}

func (c *Checker) GetSuggestedSymbolForNonexistentModule(name *ast.Node, targetModule *ast.Symbol) *ast.Symbol {
	return c.getSuggestedSymbolForNonexistentModule(name, targetModule)
}

func (c *Checker) GetSuggestedSymbolForNonexistentSymbol(location *ast.Node, outerName string, meaning ast.SymbolFlags) *ast.Symbol {
	return c.getSuggestedSymbolForNonexistentSymbol(location, outerName, meaning)
}

func (c *Checker) GetPromiseType() *Type {
	return c.getGlobalPromiseType()
}

func (c *Checker) GetPromiseLikeType() *Type {
	return c.getGlobalPromiseLikeType()
}

// GetAnyAsyncIterableType returns AsyncIterable<any, any, any>, or nil when the
// global AsyncIterable type is missing (stock checker.ts getAnyAsyncIterableType).
func (c *Checker) GetAnyAsyncIterableType() *Type {
	t := c.getGlobalAsyncIterableType()
	if t == c.emptyGenericType {
		return nil
	}
	return c.createTypeFromGenericGlobalType(t, []*Type{c.anyType, c.anyType, c.anyType})
}

// GetExactOptionalProperties returns optional properties whose type contains
// the missing type (stock checker.ts getExactOptionalProperties).
func (c *Checker) GetExactOptionalProperties(t *Type) []*ast.Symbol {
	props := c.GetPropertiesOfType(t)
	var result []*ast.Symbol
	for _, prop := range props {
		if c.containsMissingType(c.getTypeOfSymbol(prop)) {
			result = append(result, prop)
		}
	}
	return result
}

// ParameterIdentifierInfo is the stock getParameterIdentifierInfoAtPosition result.
type ParameterIdentifierInfo struct {
	Parameter       *ast.IdentifierNode
	ParameterName   string
	IsRestParameter bool
}

// GetParameterIdentifierInfoAtPosition returns the parameter identifier info at
// the given argument position (stock checker.ts; previously ls/inlay_hints.go).
func (c *Checker) GetParameterIdentifierInfoAtPosition(signature *Signature, pos int) *ParameterIdentifierInfo {
	if signature == nil {
		return nil
	}
	parameters := signature.Parameters()
	paramCount := len(parameters) - core.IfElse(signature.HasRestParameter(), 1, 0)
	if pos < paramCount {
		param := parameters[pos]
		paramId := getParameterDeclarationIdentifier(param)
		if paramId == nil {
			return nil
		}
		return &ParameterIdentifierInfo{
			Parameter:       paramId,
			ParameterName:   param.Name,
			IsRestParameter: false,
		}
	}

	var restParameter *ast.Symbol
	var restId *ast.IdentifierNode
	if paramCount < len(parameters) {
		restParameter = parameters[paramCount]
		restId = getParameterDeclarationIdentifier(restParameter)
	}
	if restId == nil {
		return nil
	}

	restType := c.GetTypeOfSymbol(restParameter)
	if restType.IsTupleType() {
		associatedNames := make([]*ast.Node, 0, len(restType.Target().AsTupleType().ElementInfos())) // asguard:exempt IsTupleType() guard above: the tuple target carries *TupleType data (newObjectType Tuple case)
		for _, elementInfo := range restType.Target().AsTupleType().ElementInfos() {                 // asguard:exempt IsTupleType() guard above: the tuple target carries *TupleType data (newObjectType Tuple case)
			labeledElement := elementInfo.LabeledDeclaration()
			associatedNames = append(associatedNames, labeledElement)
		}
		index := pos - paramCount
		if index < len(associatedNames) {
			associatedName := associatedNames[index]
			if associatedName != nil {
				debug.Assert(ast.IsIdentifier(associatedName.Name()))
				var isRestTupleElement bool
				if ast.IsNamedTupleMember(associatedName) {
					isRestTupleElement = associatedName.AsNamedTupleMember().DotDotDotToken != nil
				} else {
					isRestTupleElement = associatedName.AsParameterDeclaration().DotDotDotToken != nil
				}
				return &ParameterIdentifierInfo{
					Parameter:       associatedName.Name(),
					ParameterName:   associatedName.Name().Text(),
					IsRestParameter: isRestTupleElement,
				}
			}
		}
		return nil
	}

	if pos == paramCount {
		return &ParameterIdentifierInfo{
			Parameter:       restId,
			ParameterName:   restParameter.Name,
			IsRestParameter: true,
		}
	}
	return nil
}

func getParameterDeclarationIdentifier(symbol *ast.Symbol) *ast.IdentifierNode {
	if symbol.ValueDeclaration != nil && ast.IsParameterDeclaration(symbol.ValueDeclaration) && ast.IsIdentifier(symbol.ValueDeclaration.Name()) {
		return symbol.ValueDeclaration.Name()
	}
	return nil
}

// CreateArrayType wraps createArrayType (stock checker.ts createArrayType).
func (c *Checker) CreateArrayType(elementType *Type) *Type {
	return c.createArrayType(elementType)
}

// CreatePromiseType wraps createPromiseType (stock checker.ts createPromiseType).
func (c *Checker) CreatePromiseType(promisedType *Type) *Type {
	return c.createPromiseType(promisedType)
}

// CreateTransientSymbolWithType builds a transient symbol and pins its resolved
// type via valueSymbolLinks.resolvedType (same field as newParameter/newProperty
// at checker.go:14023-14030).
func (c *Checker) CreateTransientSymbolWithType(flags ast.SymbolFlags, name string, t *Type) *ast.Symbol {
	symbol := c.newSymbol(flags, name)
	if t != nil {
		c.valueSymbolLinks.Get(symbol).resolvedType = t
	}
	return symbol
}

// CreateSignatureFromParts assembles a Signature via newSignature
// (checker.go:25163). typeParameters / thisParameter are forwarded when
// provided (returnValueCorrect generic isFunctionType path). declaration /
// typePredicate remain omitted (no Node / TypePredicate wire in this RPC).
func (c *Checker) CreateSignatureFromParts(
	parameters []*ast.Symbol,
	returnType *Type,
	minArgumentCount int,
	flags SignatureFlags,
	typeParameters []*Type,
	thisParameter *ast.Symbol,
) *Signature {
	return c.newSignature(flags, nil /*declaration*/, typeParameters, thisParameter, parameters, returnType, nil /*resolvedTypePredicate*/, minArgumentCount)
}

// IndexInfoPart is the wire shape for createAnonymousTypeFromParts index infos.
type IndexInfoPart struct {
	KeyType    *Type
	ValueType  *Type
	IsReadonly bool
}

// CreateAnonymousTypeFromParts assembles an anonymous type via newAnonymousType
// (checker.go:25006) and newIndexInfo (checker.go:25179).
func (c *Checker) CreateAnonymousTypeFromParts(
	symbol *ast.Symbol,
	members []*ast.Symbol,
	callSignatures []*Signature,
	constructSignatures []*Signature,
	indexInfos []IndexInfoPart,
) *Type {
	table := make(ast.SymbolTable, len(members))
	for _, member := range members {
		if member == nil {
			continue
		}
		table[member.Name] = member
	}
	infos := make([]*IndexInfo, 0, len(indexInfos))
	for _, part := range indexInfos {
		infos = append(infos, c.newIndexInfo(part.KeyType, part.ValueType, part.IsReadonly, nil /*declaration*/, nil /*components*/))
	}
	return c.newAnonymousType(symbol, table, callSignatures, constructSignatures, infos)
}

func (c *Checker) GetOptionalType() *Type {
	return c.optionalType
}

func (c *Checker) GetTypeOfAssignmentPattern(node *ast.Node) *Type {
	// Stock asserts the node is an object/array literal expression; a wrong-kind
	// node would walk parents to the file root and panic there — guard instead
	// (a JS Debug.assert is catchable, a Go panic is not).
	if !ast.IsObjectLiteralExpression(node) && !ast.IsArrayLiteralExpression(node) {
		return nil
	}
	return c.getTypeOfAssignmentPattern(node)
}

func (c *Checker) GetPrivateIdentifierPropertyOfType(leftType *Type, lexicallyScopedIdentifier *ast.Symbol) *ast.Symbol {
	return c.getPrivateIdentifierPropertyOfType(leftType, lexicallyScopedIdentifier)
}
