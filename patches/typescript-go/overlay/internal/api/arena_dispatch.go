package api

// Arena request dispatch: decode the fixed-shape request record, build the
// same typed params the JSON path produces, call the SAME handlers, encode
// the result into the arena. Only the measured hot query classes are capable;
// everything else errors loudly (the client routes it via JSON).

import (
	"context"
	"fmt"
	"math"

	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/json"
)

// arenaCapable reports whether a method rides the arena transport.
func arenaCapable(method string) bool {
	switch Method(method) {
	case MethodGetTypeAtLocation, MethodGetContextualType, MethodGetApparentType,
		MethodGetContextualTypeForArgumentAtIndex,
		MethodGetTypeOfSymbolAtLocation, MethodGetTypeOfSymbol, MethodGetDeclaredTypeOfSymbol,
		MethodGetSymbolAtPosition, MethodGetSymbolAtLocation,
		MethodGetPropertiesOfType, MethodGetSignaturesOfType,
		MethodGetReturnTypeOfSignature, MethodGetSymbolOfType,
		MethodGetBaseTypeOfLiteralType, MethodGetNonNullableType,
		MethodGetTypeArguments, MethodGetBaseTypes, MethodGetTypesOfType,
		MethodGetFreshTypeOfType, MethodGetRegularTypeOfType,
		MethodGetTargetOfType, MethodGetObjectTypeOfType,
		MethodGetCheckTypeOfType, MethodGetExtendsTypeOfType, MethodGetBaseTypeOfType,
		MethodGetTypeParametersOfType, MethodGetOuterTypeParametersOfType,
		MethodGetLocalTypeParametersOfType, MethodGetAliasTypeArgumentsOfType,
		MethodGetParametersOfSignature, MethodGetResolvedSignature,
		MethodTypeToString, MethodIsArrayType,
		MethodQuickinfo, MethodReferences, MethodDefinitionAndBoundSpan,
		// issue #12 candidate 2: record-shaped query classes (type/symbol/
		// signature/bool/string results ride the existing record encoders).
		MethodGetAliasedSymbol, MethodGetImmediateAliasedSymbol, MethodGetRootSymbols,
		MethodGetExportsOfModule, MethodGetExportsAndPropertiesOfModule, MethodGetExportsOfSymbol,
		MethodGetMembersOfSymbol, MethodGetParentOfSymbol, MethodGetExportSymbolOfSymbol,
		MethodGetGlobalExportsOfSymbol,
		MethodGetDocumentationComment, MethodResolveExternalModuleSymbol, MethodSymbolIsValue,
		MethodGetLocalTypeParametersOfClassOrInterfaceOrTypeAlias, MethodGetJSDocTags,
		MethodCollectVisitedTypeParameters, MethodCreateArrayType, MethodCreatePromiseType,
		MethodGetAugmentedPropertiesOfType, MethodGetAwaitedType, MethodGetBaseConstraintOfType,
		MethodGetConstraintOfTypeParameter, MethodGetDefaultFromTypeParameter,
		MethodGetElementTypeOfArrayType, MethodGetExactOptionalProperties,
		MethodGetIndexTypeOfType, MethodGetPromisedTypeOfPromise, MethodGetWidenedLiteralType,
		MethodIsEmptyAnonymousObjectType, MethodIsLibType, MethodIsNullableType,
		MethodIsTupleType, MethodTypeHasCallOrConstructSignatures,
		MethodGetConstraintOfType, MethodGetFalseTypeOfConditionalType,
		MethodGetTrueTypeOfConditionalType, MethodGetAliasSymbolOfType,
		MethodGetThisTypeOfType,
		MethodGetAnyType, MethodGetBigIntType, MethodGetBooleanType, MethodGetESSymbolType,
		MethodGetErrorType, MethodGetNeverType, MethodGetNonPrimitiveType, MethodGetNullType,
		MethodGetNumberType, MethodGetOptionalType, MethodGetPromiseLikeType,
		MethodGetPromiseType, MethodGetStringType, MethodGetUndefinedType,
		MethodGetUnknownType, MethodGetVoidType, MethodGetAnyAsyncIterableType,
		MethodContainsArgumentsReference, MethodGetContextualTypeForJsxAttribute,
		MethodGetTypeArgumentConstraint, MethodGetTypeOfAssignmentPattern,
		MethodIsDeclarationVisible, MethodIsImplementationOfOverload, MethodIsOptionalParameter,
		MethodRequiresAddingImplicitUndefined, MethodGetJsxFragmentFactory,
		MethodGetJsxIntrinsicTagNamesAt, MethodGetPropertySymbolOfDestructuringAssignment,
		MethodGetSignatureFromDeclaration, MethodGetExportSpecifierLocalTarget,
		MethodResolveExternalModuleName,
		MethodGetRestTypeOfSignature, MethodGetTypeArgumentsForResolvedSignature,
		MethodGetTargetOfSignature, MethodGetThisParameterOfSignature,
		MethodGetTypeParametersOfSignature, MethodHasEffectiveRestParameter,
		MethodGetExpandedParameters,
		MethodGetPropertyOfType, MethodGetTypeOfPropertyOfType, MethodGetTypeOfPropertyOfContextualType,
		MethodGetStringLiteralType, MethodGetBigIntLiteralType, MethodGetNumberLiteralType,
		MethodGetTypeAtPosition, MethodGetModuleSymbolForSourceFile,
		MethodGetAccessibleSymbolChain, MethodGetCandidateSignaturesForStringLiteralCompletions,
		MethodTryGetThisTypeAt,
		MethodGetSymbolsDeclarations, MethodGetParentsOfSymbols, MethodGetAmbientModules,
		MethodGetCompletionsAtPosition, MethodSignatureHelp,
		MethodGetRenameInfo, MethodGetEditsForRename:
		return true
	}
	return false
}

// HandleArenaRequest processes one arena call. The response header is left in
// the arena at arenaRespOffset for the JS side to decode. When the response
// does not fit the arena, the result crosses out-of-band as the returned JSON
// doc (exactly what the JSON transport would have produced); "" means the
// arena holds the response.
func (s *Session) HandleArenaRequest(method string) string {
	a := s.arena
	if a == nil {
		return "" // no arena installed: leave kind=0 (client treats as transport error)
	}
	a.begin()
	if !arenaCapable(method) {
		a.finishError("arena: method not arena-capable: " + method)
		return ""
	}
	res, err := s.handleArenaRequest(method)
	if err != nil {
		a.finishError(err.Error())
		return ""
	}
	a.encodeResult(res)
	if a.failed {
		a.rewindStrings() // the failed encode's interns were never announced
		doc, merr := json.Marshal(res)
		if merr != nil {
			a.begin()
			a.finishError("arena: json escape failed: " + merr.Error())
			return ""
		}
		return string(doc)
	}
	return ""
}

// Request record layout (little-endian):
//
//	+0  snapshot u64
//	+8  project string (off u32, len u32) — bytes after the head
//	+16 per-method args
//
// Node location: index u32, kind u32, path (off u32, len u32).
// typeToString: type u32 @16, flags i32 @20, location handle @24 ("0.0." = none).
func (s *Session) handleArenaRequest(method string) (any, error) {
	r := arenaReq{s.arena}
	ctx := context.Background()
	snap := SnapshotID(r.u64(0))
	proj := ProjectID(r.str(8))
	loc := func(off int) NodeHandle {
		if h := r.nodeHandle(off); h != "0.0." { // absent-handle sentinel (index 0, kind 0, empty path)
			return NodeHandle(h)
		}
		return NodeHandle("")
	}

	switch Method(method) {
	case MethodGetTypeAtLocation:
		return s.handleGetTypeAtLocation(ctx, &GetTypeAtLocationParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetContextualType:
		return s.handleGetContextualType(ctx, &GetContextualTypeParams{Snapshot: snap, Project: proj, Location: loc(16), ContextFlags: r.i32(32)})
	case MethodGetContextualTypeForArgumentAtIndex:
		return s.handleGetContextualTypeForArgumentAtIndex(ctx, &GetContextualTypeForArgumentAtIndexParams{Snapshot: snap, Project: proj, Location: loc(16), ArgIndex: r.i32(32)})
	case MethodGetApparentType:
		return s.handleGetApparentType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTypeOfSymbolAtLocation:
		return s.handleGetTypeOfSymbolAtLocation(ctx, &GetTypeOfSymbolAtLocationParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16)), Location: loc(24)})
	case MethodGetTypeOfSymbol:
		return s.handleGetTypeOfSymbol(ctx, &GetTypeOfSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetDeclaredTypeOfSymbol:
		return s.handleGetDeclaredTypeOfSymbol(ctx, &GetTypeOfSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetSymbolAtPosition:
		return s.handleGetSymbolAtPosition(ctx, &GetSymbolAtPositionParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24)})
	case MethodGetSymbolAtLocation:
		return s.handleGetSymbolAtLocation(ctx, &GetSymbolAtLocationParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetPropertiesOfType:
		return s.handleGetPropertiesOfType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetSignaturesOfType:
		return s.handleGetSignaturesOfType(ctx, &GetSignaturesOfTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16)), Kind: r.i32(20)})
	case MethodGetReturnTypeOfSignature:
		return s.handleGetReturnTypeOfSignature(ctx, &CheckerSignatureParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetSymbolOfType:
		return s.handleGetSymbolOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetBaseTypeOfLiteralType:
		return s.handleGetBaseTypeOfLiteralType(ctx, &GetBaseTypeOfLiteralTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetNonNullableType:
		return s.handleGetNonNullableType(ctx, &GetNonNullableTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTypeArguments:
		return s.handleGetTypeArguments(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetBaseTypes:
		return s.handleGetBaseTypes(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTypesOfType:
		return s.handleGetTypesOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetFreshTypeOfType:
		return s.handleGetFreshTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetRegularTypeOfType:
		return s.handleGetRegularTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTargetOfType:
		return s.handleGetTargetOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetThisTypeOfType:
		return s.handleGetThisTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetObjectTypeOfType:
		return s.handleGetObjectTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetCheckTypeOfType:
		return s.handleGetCheckTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetExtendsTypeOfType:
		return s.handleGetExtendsTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetBaseTypeOfType:
		return s.handleGetBaseTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTypeParametersOfType:
		return s.handleGetTypeParametersOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetOuterTypeParametersOfType:
		return s.handleGetOuterTypeParametersOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetLocalTypeParametersOfType:
		return s.handleGetLocalTypeParametersOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetAliasTypeArgumentsOfType:
		return s.handleGetAliasTypeArgumentsOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetParametersOfSignature:
		return s.handleGetParametersOfSignature(ctx, &GetSignaturePropertyParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetResolvedSignature:
		return s.handleGetResolvedSignature(ctx, &GetResolvedSignatureParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodTypeToString:
		loc := r.nodeHandle(24)
		if loc == "0.0." { // absent-handle sentinel
			loc = ""
		}
		return s.handleTypeToString(ctx, &TypeToTypeNodeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16)), Location: NodeHandle(loc), Flags: r.i32(20)})
	case MethodIsArrayType:
		return s.handleIsArrayType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodQuickinfo:
		var verbosity *int32
		if v := r.i32(32); v >= 0 {
			verbosity = &v
		}
		return s.handleQuickinfo(ctx, &QuickinfoParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24), MaximumHoverLength: r.i32(28), VerbosityLevel: verbosity})
	case MethodReferences:
		return s.handleReferences(ctx, &ReferencesParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24)})
	case MethodDefinitionAndBoundSpan:
		return s.handleDefinitionAndBoundSpan(ctx, &DefinitionAndBoundSpanParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24)})

	// ── issue #12 candidate 2: record-shaped query classes ──
	// symbol u64 @16 (CheckerSymbolParams / GetSymbolPropertyParams family)
	case MethodGetAliasedSymbol:
		return s.handleGetAliasedSymbol(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetImmediateAliasedSymbol:
		return s.handleGetImmediateAliasedSymbol(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetRootSymbols:
		return s.handleGetRootSymbols(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetExportsOfModule:
		return s.handleGetExportsOfModule(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetExportsAndPropertiesOfModule:
		return s.handleGetExportsAndPropertiesOfModule(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetExportsOfSymbol:
		return s.handleGetExportsOfSymbol(ctx, &GetSymbolPropertyParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetMembersOfSymbol:
		return s.handleGetMembersOfSymbol(ctx, &GetSymbolPropertyParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetParentOfSymbol:
		return s.handleGetParentOfSymbol(ctx, &GetSymbolPropertyParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetExportSymbolOfSymbol:
		return s.handleGetExportSymbolOfSymbol(ctx, &GetSymbolPropertyParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetGlobalExportsOfSymbol:
		return s.handleGetGlobalExportsOfSymbol(ctx, &GetSymbolPropertyParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetDocumentationComment:
		return s.handleGetDocumentationComment(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodResolveExternalModuleSymbol:
		return s.handleResolveExternalModuleSymbol(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodSymbolIsValue:
		return s.handleSymbolIsValue(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetLocalTypeParametersOfClassOrInterfaceOrTypeAlias:
		return s.handleGetLocalTypeParametersOfClassOrInterfaceOrTypeAlias(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	case MethodGetJSDocTags:
		return s.handleGetJSDocTags(ctx, &CheckerSymbolParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16))})
	// type u32 @16 (CheckerTypeParams / GetTypePropertyParams family)
	case MethodCollectVisitedTypeParameters:
		return s.handleCollectVisitedTypeParameters(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodCreateArrayType:
		return s.handleCreateArrayType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodCreatePromiseType:
		return s.handleCreatePromiseType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetAugmentedPropertiesOfType:
		return s.handleGetAugmentedPropertiesOfType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetAwaitedType:
		return s.handleGetAwaitedType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetBaseConstraintOfType:
		return s.handleGetBaseConstraintOfType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetConstraintOfTypeParameter:
		return s.handleGetConstraintOfTypeParameter(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetDefaultFromTypeParameter:
		return s.handleGetDefaultFromTypeParameter(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetElementTypeOfArrayType:
		return s.handleGetElementTypeOfArrayType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetExactOptionalProperties:
		return s.handleGetExactOptionalProperties(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetIndexTypeOfType:
		return s.handleGetIndexTypeOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetPromisedTypeOfPromise:
		return s.handleGetPromisedTypeOfPromise(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetWidenedLiteralType:
		return s.handleGetWidenedLiteralType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodIsEmptyAnonymousObjectType:
		return s.handleIsEmptyAnonymousObjectType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodIsLibType:
		return s.handleIsLibType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodIsNullableType:
		return s.handleIsNullableType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodIsTupleType:
		return s.handleIsTupleType(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodTypeHasCallOrConstructSignatures:
		return s.handleTypeHasCallOrConstructSignatures(ctx, &CheckerTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetConstraintOfType:
		return s.handleGetConstraintOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetFalseTypeOfConditionalType:
		return s.handleGetFalseTypeOfConditionalType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetTrueTypeOfConditionalType:
		return s.handleGetTrueTypeOfConditionalType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	case MethodGetAliasSymbolOfType:
		return s.handleGetAliasSymbolOfType(ctx, &GetTypePropertyParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16))})
	// intrinsic type getters (head only)
	case MethodGetAnyType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetAnyType)
	case MethodGetBigIntType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetBigIntType)
	case MethodGetBooleanType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetBooleanType)
	case MethodGetESSymbolType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetESSymbolType)
	case MethodGetErrorType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetErrorType)
	case MethodGetNeverType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetNeverType)
	case MethodGetNonPrimitiveType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetNonPrimitiveType)
	case MethodGetNullType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetNullType)
	case MethodGetNumberType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetNumberType)
	case MethodGetOptionalType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetOptionalType)
	case MethodGetPromiseLikeType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetPromiseLikeType)
	case MethodGetPromiseType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetPromiseType)
	case MethodGetStringType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetStringType)
	case MethodGetUndefinedType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetUndefinedType)
	case MethodGetUnknownType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetUnknownType)
	case MethodGetVoidType:
		return s.handleGetIntrinsicType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj}, (*checker.Checker).GetVoidType)
	case MethodGetAnyAsyncIterableType:
		return s.handleGetAnyAsyncIterableType(ctx, &GetIntrinsicTypeParams{Snapshot: snap, Project: proj})
	// node handle @16 (CheckerNodeParams family)
	case MethodContainsArgumentsReference:
		return s.handleContainsArgumentsReference(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetContextualTypeForJsxAttribute:
		return s.handleGetContextualTypeForJsxAttribute(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetTypeArgumentConstraint:
		return s.handleGetTypeArgumentConstraint(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetTypeOfAssignmentPattern:
		return s.handleGetTypeOfAssignmentPattern(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodIsDeclarationVisible:
		return s.handleIsDeclarationVisible(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodIsImplementationOfOverload:
		return s.handleIsImplementationOfOverload(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodIsOptionalParameter:
		return s.handleIsOptionalParameter(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodRequiresAddingImplicitUndefined:
		return s.handleRequiresAddingImplicitUndefined(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetJsxFragmentFactory:
		return s.handleGetJsxFragmentFactory(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetJsxIntrinsicTagNamesAt:
		return s.handleGetJsxIntrinsicTagNamesAt(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetPropertySymbolOfDestructuringAssignment:
		return s.handleGetPropertySymbolOfDestructuringAssignment(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetSignatureFromDeclaration:
		return s.handleGetSignatureFromDeclaration(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodGetExportSpecifierLocalTarget:
		return s.handleGetExportSpecifierLocalTargetSymbol(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	case MethodResolveExternalModuleName:
		return s.handleResolveExternalModuleName(ctx, &CheckerNodeParams{Snapshot: snap, Project: proj, Location: loc(16)})
	// signature u64 @16
	case MethodGetRestTypeOfSignature:
		return s.handleGetRestTypeOfSignature(ctx, &CheckerSignatureParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetTypeArgumentsForResolvedSignature:
		return s.handleGetTypeArgumentsForResolvedSignature(ctx, &CheckerSignatureParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetTargetOfSignature:
		return s.handleGetTargetOfSignature(ctx, &GetSignaturePropertyParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetThisParameterOfSignature:
		return s.handleGetThisParameterOfSignature(ctx, &GetSignaturePropertyParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetTypeParametersOfSignature:
		return s.handleGetTypeParametersOfSignature(ctx, &GetSignaturePropertyParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodHasEffectiveRestParameter:
		return s.handleHasEffectiveRestParameter(ctx, &HasEffectiveRestParameterParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16))})
	case MethodGetExpandedParameters:
		return s.handleGetExpandedParameters(ctx, &GetExpandedParametersParams{Snapshot: snap, Project: proj, Signature: SignatureID(r.u64(16)), SkipUnionExpanding: r.u32(24) != 0})
	// type u32 @16 + name str @20 (GetPropertyOfTypeParams family)
	case MethodGetPropertyOfType:
		return s.handleGetPropertyOfType(ctx, &GetPropertyOfTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16)), Name: r.str(20)})
	case MethodGetTypeOfPropertyOfType:
		return s.handleGetTypeOfPropertyOfType(ctx, &GetPropertyOfTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16)), Name: r.str(20)})
	case MethodGetTypeOfPropertyOfContextualType:
		return s.handleGetTypeOfPropertyOfContextualType(ctx, &GetPropertyOfTypeParams{Snapshot: snap, Project: proj, Type: TypeID(r.u32(16)), Name: r.str(20)})
	// literal value @16
	case MethodGetStringLiteralType:
		return s.handleGetStringLiteralType(ctx, &GetLiteralTypeParams{Snapshot: snap, Project: proj, Value: r.str(16)})
	case MethodGetBigIntLiteralType:
		return s.handleGetBigIntLiteralType(ctx, &GetLiteralTypeParams{Snapshot: snap, Project: proj, Value: r.str(16)})
	case MethodGetNumberLiteralType:
		return s.handleGetNumberLiteralType(ctx, &GetLiteralTypeParams{Snapshot: snap, Project: proj, Value: math.Float64frombits(r.u64(16))})
	// file @16 (+ position @24)
	case MethodGetTypeAtPosition:
		return s.handleGetTypeAtPosition(ctx, &GetTypeAtPositionParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24)})
	case MethodGetModuleSymbolForSourceFile:
		return s.handleGetModuleSymbolForSourceFile(ctx, &GetSourceFileParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}})
	// symbol u64 @16 + handle @24 ("0.0." = none) + meaning u32 @40 + flags u8 @44
	case MethodGetAccessibleSymbolChain:
		return s.handleGetAccessibleSymbolChain(ctx, &GetAccessibleSymbolChainParams{Snapshot: snap, Project: proj, Symbol: SymbolID(r.u64(16)), EnclosingDeclaration: loc(24), Meaning: r.u32(40), UseOnlyExternalAliasing: r.u32(44) != 0})
	// two handles @16/@32
	case MethodGetCandidateSignaturesForStringLiteralCompletions:
		return s.handleGetCandidateSignaturesForStringLiteralCompletions(ctx, &GetCandidateSignaturesForStringLiteralCompletionsParams{Snapshot: snap, Project: proj, Call: loc(16), EditingArgument: loc(32)})
	// handle @16 + includeGlobalThis u8 @32 + container handle @36 ("0.0." = none)
	case MethodTryGetThisTypeAt:
		return s.handleTryGetThisTypeAt(ctx, &TryGetThisTypeAtParams{Snapshot: snap, Project: proj, Location: loc(16), IncludeGlobalThis: r.u32(32) != 0, Container: loc(36)})
	// symbol id array (ptr,count) @16
	case MethodGetSymbolsDeclarations:
		return s.handleGetSymbolsDeclarations(ctx, &GetSymbolsDeclarationsParams{Snapshot: snap, Symbols: r.symbolIDs(16)})
	case MethodGetParentsOfSymbols:
		return s.handleGetParentsOfSymbols(ctx, &GetSymbolsDeclarationsParams{Snapshot: snap, Symbols: r.symbolIDs(16)})
	// head only
	case MethodGetAmbientModules:
		return s.handleGetAmbientModules(ctx, &GetAmbientModulesParams{Snapshot: snap, Project: proj})
	// file str @16, position u32 @24, triggerReason str @28
	case MethodSignatureHelp:
		var reason *string
		if t := r.str(28); t != "" {
			reason = &t
		}
		return s.handleSignatureHelp(ctx, &SignatureHelpParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24), TriggerReason: reason})
	// file str @16, position u32 @24, pref tri bytes @28-29
	case MethodGetRenameInfo:
		return s.handleGetRenameInfo(ctx, &RenameInfoParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24), AllowRenameOfImportPath: triBool(r.u8(28)), ProvidePrefixAndSuffixTextForRename: triBool(r.u8(29))})
	// file str @16, position u32 @24, findInStrings u8 @28, findInComments u8 @29, providePrefixSuffix tri byte @30
	case MethodGetEditsForRename:
		return s.handleGetEditsForRename(ctx, &EditsForRenameParams{Snapshot: snap, Project: proj, File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24), FindInStrings: r.u8(28) != 0, FindInComments: r.u8(29) != 0, ProvidePrefixAndSuffixTextForRename: triBool(r.u8(30))})
	// file str @16, position u32 @24, triggerCharacter str @28, includeSymbol u8 @36,
	// preference tri-states @40-44 (0=unset, 1=true, 2=false)
	case MethodGetCompletionsAtPosition:
		var trigger *string
		if t := r.str(28); t != "" {
			trigger = &t
		}
		return s.handleGetCompletionsAtPosition(ctx, &GetCompletionsAtPositionParams{
			Snapshot: snap, Project: proj,
			File: DocumentIdentifier{FileName: r.str(16)}, Position: r.u32(24),
			TriggerCharacter: trigger,
			IncludeSymbol:    r.u32(36) != 0,
			Preferences:      decodeCompletionsPreferences(&r, 40),
		})
	}
	return nil, fmt.Errorf("arena: unhandled capable method %q", method)
}

// encodeResult writes the result into the arena in one of the three shapes:
// null, a record run (count-prefixed), or a raw scalar payload.
func (a *arena) encodeResult(res any) {
	switch v := res.(type) {
	case nil:
		a.finish(arenaKindNull)
	case *TypeResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, typeRecordSize, func(int) { a.encodeTypeResponse(v) })
	case []*TypeResponse:
		a.records(len(v), typeRecordSize, func(i int) { a.encodeTypeResponse(v[i]) })
	case *[]*TypeResponse:
		if v == nil || *v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(len(*v), typeRecordSize, func(i int) { a.encodeTypeResponse((*v)[i]) })
	case *SymbolResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, symbolRecordSize, func(int) { a.encodeSymbolResponse(v) })
	case []*SymbolResponse:
		a.records(len(v), symbolRecordSize, func(i int) {
			if v[i] == nil {
				a.zeroSymbolRecord(a.rec(symbolRecordSize))
				return
			}
			a.encodeSymbolResponse(v[i])
		})
	case *SignatureResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, signatureRecordSize, func(int) { a.encodeSignatureResponse(v) })
	case []*SignatureResponse:
		a.records(len(v), signatureRecordSize, func(i int) { a.encodeSignatureResponse(v[i]) })
	case string:
		o, n := a.writeStr(v)
		off := a.rec(8)
		a.u32(off, o)
		a.u32(off+4, n)
		a.finish(arenaKindRecord)
	case bool:
		off := a.rec(1)
		a.b(off, 0)
		if v {
			a.b(off, 1)
		}
		a.finish(arenaKindRecord)
	case *QuickinfoResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, quickinfoRecordSize, func(int) { a.encodeQuickinfoResponse(v) })
	case []*ReferencedSymbolResponse:
		a.records(len(v), referencedSymbolRecordSize, func(i int) { a.encodeReferencedSymbolResponse(v[i]) })
	case *DefinitionAndBoundSpanResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, dabsRecordSize, func(int) { a.encodeDefinitionAndBoundSpanResponse(v) })
	case []*JSDocTagInfo:
		a.records(len(v), jsdocTagRecordSize, func(i int) { a.encodeJSDocTag(v[i]) })
	case [][]SymbolID:
		a.encodeExpandedParameters(v)
	case *AmbientModulesResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, ambientModulesRecordSize, func(int) { a.encodeAmbientModulesResponse(v) })
	case *CompletionInfoResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, completionInfoRecordSize, func(int) { a.encodeCompletionsResponse(v) })
	case *SignatureHelpItemsResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, signatureHelpTopRecordSize, func(int) { a.encodeSignatureHelpItemsResponse(v) })
	case *RenameInfoResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, renameInfoRecordSize, func(int) { a.encodeRenameInfoResponse(v) })
	case []*RenameLocationResponse:
		a.records(len(v), renameLocationRecordSize, func(i int) { a.encodeRenameLocationResponse(a.rec(renameLocationRecordSize), v[i]) })
	default:
		a.finishError(fmt.Sprintf("arena: cannot encode result of type %T", res))
	}
}

// records writes a count-prefixed run of fixed-size records and starts the
// pack region right after, so array fields never interleave with the fixed
// record stride the JS side walks.
func (a *arena) records(count int, size int, encode func(i int)) {
	a.u32(a.rec(4), uint32(count))
	a.packOff = a.recOff + count*size
	for i := 0; i < count; i++ {
		encode(i)
	}
	a.finish(arenaKindRecord)
}
