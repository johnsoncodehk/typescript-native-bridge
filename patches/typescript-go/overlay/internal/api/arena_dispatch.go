package api

// Arena request dispatch: decode the fixed-shape request record, build the
// same typed params the JSON path produces, call the SAME handlers, encode
// the result into the arena. Only the measured hot query classes are capable;
// everything else errors loudly (the client routes it via JSON).

import (
	"context"
	"fmt"

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
		MethodTypeToString, MethodIsArrayType:
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
	loc := func(off int) NodeHandle { return NodeHandle(r.nodeHandle(off)) }

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
		a.records(1, 152, func(int) { a.encodeTypeResponse(v) })
	case []*TypeResponse:
		a.records(len(v), 152, func(i int) { a.encodeTypeResponse(v[i]) })
	case *SymbolResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, 72, func(int) { a.encodeSymbolResponse(v) })
	case []*SymbolResponse:
		a.records(len(v), 72, func(i int) { a.encodeSymbolResponse(v[i]) })
	case *SignatureResponse:
		if v == nil {
			a.finish(arenaKindNull)
			return
		}
		a.records(1, 64, func(int) { a.encodeSignatureResponse(v) })
	case []*SignatureResponse:
		a.records(len(v), 64, func(i int) { a.encodeSignatureResponse(v[i]) })
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
