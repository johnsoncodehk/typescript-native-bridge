package api

// TNB additions to package api, kept out of proto.go so its in-place patch
// carries only edits to upstream code.

import (
	"fmt"

	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/json"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
)

// OpenProjectParams identifies a tsconfig to open/load, optionally carrying
// the client's effective compiler options. On the wire it is
// string | { fileName?: string, uri?: string, compilerOptions?: {...} }.
//
// CompilerOptions is the client host's merged CLI + tsconfig + extends parse
// (stock parseCommandLine result). CLI-only flags never appear in the on-disk
// tsconfig, so a Go program built from the disk parse alone silently diverges
// from the client's (`tsc --strict` against a `"strict": false` tsconfig
// reported nothing). When present, the wire options REPLACE the disk-parsed
// options for this project (file expansion still comes from the disk config);
// when absent, the disk parse is used as before (LS/tsserver hosts, whose
// options live entirely in the tsconfig).
type OpenProjectParams struct {
	DocumentIdentifier
	CompilerOptions *core.CompilerOptions `json:"compilerOptions,omitempty"`
}

func (p *OpenProjectParams) UnmarshalJSONFrom(dec *json.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	switch tok.Kind() {
	case '"':
		p.FileName = tok.String()
		return nil
	case '{':
		for dec.PeekKind() != '}' {
			key, err := dec.ReadToken()
			if err != nil {
				return err
			}
			switch key.String() {
			case "fileName":
				val, err := dec.ReadToken()
				if err != nil {
					return err
				}
				p.FileName = val.String()
			case "uri":
				val, err := dec.ReadToken()
				if err != nil {
					return err
				}
				p.URI = lsproto.DocumentUri(val.String())
			case "compilerOptions":
				if err := json.UnmarshalDecode(dec, &p.CompilerOptions); err != nil {
					return err
				}
			default:
				if err := dec.SkipValue(); err != nil {
					return err
				}
			}
		}
		// Consume the closing brace.
		if _, err := dec.ReadToken(); err != nil {
			return err
		}
		return nil
	default:
		return fmt.Errorf("OpenProjectParams: expected string or object, got %v", tok.Kind())
	}
}

// ExtraFileExtensionWire is the JSON form of tsoptions.FileExtensionInfo for updateSnapshot.
type ExtraFileExtensionWire struct {
	Extension  string `json:"extension"`
	ScriptKind int    `json:"scriptKind"`
}

// OpenFileWithContent pairs a file name with its content and script kind for
// host-fed overlays (mirrors LSP textDocument/didOpen with content).
type OpenFileWithContent struct {
	FileName   string `json:"fileName"`
	Content    string `json:"content"`
	ScriptKind int    `json:"scriptKind"` // core.ScriptKind (3=TS, 7=Deferred, …)
	// Edits carries an incremental update to the overlay the session already
	// holds: instead of re-sending full content per host edit, the client
	// forwards the tsserver change deltas (UTF-16 code units, stock
	// ScriptInfo.editContent's native domain). Content is empty when Edits
	// is set; the session splices them into its stored overlay text.
	Edits []TextEditWire `json:"edits,omitempty"`
	// BaseVersion is the client-side count of delta pushes already applied to
	// this file's overlay (0 right after a full-content push). The session
	// rejects a mismatch loudly: a silent gap would corrupt every later text.
	BaseVersion *int `json:"baseVersion,omitempty"`
}

// LightSymbolResponse is a symbol wire shape without declarations (cheap to serialize).
type LightSymbolResponse struct {
	Id         SymbolID  `json:"id"`
	Project    ProjectID `json:"project,omitzero"`
	Name       string    `json:"name"`
	Flags      uint32    `json:"flags"`
	CheckFlags uint32    `json:"checkFlags"`
	Parent     SymbolID  `json:"parent,omitzero"`
}

// Stock formats unique-symbol escaped names `__@<name>@<ordinal>`
// (createUniqueESSymbolType); tsgo uses a 0xFE prefix as its internal marker
// (ast.InternalSymbolNamePrefix — invalid UTF-8, which would also corrupt the
// JSON transport). Translate to the stock shape at the wire boundary: the
// trailing ordinal stays engine-internal (the field audit normalizes it), but
// consumers get stock-format text.
func uniqueSymbolEscapedName(name string) string {
	// tsgo emits InternalSymbolNamePrefix + '@' (two bytes) where stock
	// writes "__@" (three chars).
	if len(name) >= 2 && name[0] == '\xFE' && name[1] == '@' {
		return "__@" + name[2:]
	}
	return name
}

// GetBuilderFileGraphParams are parameters for the getBuilderFileGraph method,
// which returns builder-state metadata (content-hash version, referenced-file
// edges, global-scope effect, implied format) for every file in the program.
type GetBuilderFileGraphParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
}

// BuilderFileGraphEntry is the per-file response element of getBuilderFileGraph.
// Refs are canonical tsgo paths; FileName preserves original casing.
type BuilderFileGraphEntry struct {
	FileName           string   `json:"fileName"`
	Version            string   `json:"version"`
	AffectsGlobalScope bool     `json:"affectsGlobalScope,omitempty"`
	ImpliedNodeFormat  int32    `json:"impliedNodeFormat,omitempty"`
	Refs               []string `json:"refs,omitempty"`
}

// GetProgramInfoParams are parameters for the program-info methods that need
// only a snapshot and a project: getMissingFilePaths, getFileIncludeReasons,
// getProgramResolutionInfo, getClassifiableNames and
// getUsesUriStyleNodeCoreModules. Response payloads are the wire DTOs built in
// internal/compiler/programinfo.go.
type GetProgramInfoParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
}

// GetSymbolsInScopeParams are parameters for the getSymbolsInScope method.
type GetSymbolsInScopeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	Meaning  uint32     `json:"meaning"` // SymbolFlags mask for which symbols to include
	// Dedup opts into the GetSymbolsInScopeResponse shape: symbols whose full
	// payload was already delivered by a previous dedup response for the same
	// snapshot come back as bare ids in Known. Scope results are dominated by
	// globals, which are identical across every location in a project, so
	// re-marshalling them per call is almost pure wire overhead.
	Dedup bool `json:"dedup,omitempty"`
}

// GetSymbolsInScopeResponse is the dedup response shape for getSymbolsInScope.
// Known lists symbol ids the client has already materialized from an earlier
// dedup response against the same snapshot; Symbols carries the full payload
// for first-seen symbols.
type GetSymbolsInScopeResponse struct {
	Known   []SymbolID        `json:"known,omitempty"`
	Symbols []*SymbolResponse `json:"symbols,omitempty"`
}

// GetSymbolsDeclarationsParams batch-upgrades light prefetch symbols to full
// declaration payloads in one RPC (snapshot registry only; no checker).
type GetSymbolsDeclarationsParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Symbols  []SymbolID `json:"symbols"`
}

// CompletionEntryDataResponse mirrors the stock CompletionEntryData payload:
// present exactly on auto-import (sourced) entries, where consumers either
// send it back to getCompletionEntryDetails or key their own metadata on it
// (volar's getAutoImportSuggestions filters on data presence).
type CompletionEntryDataResponse struct {
	ExportName        string                     `json:"exportName,omitempty"`
	FileName          string                     `json:"fileName,omitempty"`
	ModuleSpecifier   string                     `json:"moduleSpecifier,omitempty"`
	TnbCompletionData *TnbCompletionDataResponse `json:"tnbCompletionData,omitempty"`
}

// GetLiteralTypeParams are parameters for the literal type factories
// (getStringLiteralType / getNumberLiteralType / getBigIntLiteralType). Value
// is the literal payload: string for string literals, float64 for number
// literals, and a signed decimal string for bigint literals (mirroring
// literalValueToJSON on the way out).
type GetLiteralTypeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Value    any        `json:"value"`
}

// GetPrivateIdentifierPropertyOfTypeParams are parameters for
// getPrivateIdentifierPropertyOfType: the left-hand type, the private
// identifier name, and the location whose lexical scope resolves the
// private identifier declaration (stock's three-argument surface).
type GetPrivateIdentifierPropertyOfTypeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Type     TypeID     `json:"type"`
	Name     string     `json:"name"`
	Location NodeHandle `json:"location"`
}

// GetNonOptionalTypeParams are the parameters for the getNonOptionalType method.
type GetNonOptionalTypeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Type     TypeID     `json:"type"`
}

// GetUnionTypeParams combines multiple types into a union.
type GetUnionTypeParams struct {
	Snapshot       SnapshotID `json:"snapshot"`
	Project        ProjectID  `json:"project"`
	Types          []TypeID   `json:"types"`
	UnionReduction int32      `json:"unionReduction,omitempty"`
}

// CheckerTypesParams are parameters for checker methods that operate on multiple types.
type CheckerTypesParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Types    []TypeID   `json:"types"`
}

// IsTypeInvalidDueToUnionDiscriminantParams checks whether a union discriminant
// makes an object-literal property invalid for completion filtering.
type IsTypeInvalidDueToUnionDiscriminantParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Type     TypeID     `json:"type"`
	Location NodeHandle `json:"location"`
}

// GetPropertiesForObjectExpressionParams runs the whole stock
// Completions.getPropertiesForObjectExpression pipeline (promise filtering,
// union reduction, union-member filtering, property merge) in one round trip.
// Location must be the ObjectLiteralExpression or JsxAttributes being completed.
type GetPropertiesForObjectExpressionParams struct {
	Snapshot        SnapshotID `json:"snapshot"`
	Project         ProjectID  `json:"project"`
	ContextualType  TypeID     `json:"contextualType"`
	CompletionsType TypeID     `json:"completionsType,omitempty"`
	Location        NodeHandle `json:"location"`
}

// ObjectExpressionMemberResponse carries the promise verdict for one member of
// the contextual type (or the contextual type itself when it is not a union).
type ObjectExpressionMemberResponse struct {
	Type         *TypeResponse `json:"type"`
	PromisedType *TypeResponse `json:"promisedType,omitempty"`
}

// ObjectExpressionFinalMemberResponse carries the per-member filter verdicts
// stock getApparentProperties computes for each union constituent.
type ObjectExpressionFinalMemberResponse struct {
	Type                     *TypeResponse `json:"type"`
	IsArrayLike              bool          `json:"isArrayLike,omitempty"`
	InvalidDueToDiscriminant bool          `json:"invalidDueToUnionDiscriminant,omitempty"`
	HasCallOrConstruct       bool          `json:"hasCallOrConstructSignatures,omitempty"`
	// Apparent properties, populated only for class members (stock checks
	// containsNonPublicProperties on them client-side).
	ApparentProperties []*SymbolResponse `json:"apparentProperties,omitempty"`
}

// GetPropertiesForObjectExpressionResponse is the composite result used by the
// client to seed its per-call caches so the stock completions path costs one RPC.
type GetPropertiesForObjectExpressionResponse struct {
	Members             []*ObjectExpressionMemberResponse      `json:"members"`
	PromiseFilteredType *TypeResponse                          `json:"promiseFilteredType"`
	MergedType          *TypeResponse                          `json:"mergedType,omitempty"`
	FinalMembers        []*ObjectExpressionFinalMemberResponse `json:"finalMembers,omitempty"`
	// Final union members that survive the filter, in union order (matches the
	// argument stock passes to getAllPossiblePropertiesOfTypes).
	FilteredTypes []TypeID          `json:"filteredTypes,omitempty"`
	Properties    []*SymbolResponse `json:"properties,omitempty"`
}

// GetResolvedSignatureForSignatureHelpParams are the parameters for
// getResolvedSignatureForSignatureHelp. ArgumentCount of -1 means undefined
// (stock falls back to the call's argument-list length).
type GetResolvedSignatureForSignatureHelpParams struct {
	Snapshot      SnapshotID `json:"snapshot"`
	Project       ProjectID  `json:"project"`
	Location      NodeHandle `json:"location"`
	ArgumentCount int32      `json:"argumentCount"`
}

// GetResolvedSignatureForSignatureHelpResponse carries the resolved signature
// plus overload candidates (stock fills an out-array; the bridge returns both).
type GetResolvedSignatureForSignatureHelpResponse struct {
	Resolved   *SignatureResponse   `json:"resolved"`
	Candidates []*SignatureResponse `json:"candidates"`
}

// GetExpandedParametersParams are the parameters for getExpandedParameters.
type GetExpandedParametersParams struct {
	Snapshot           SnapshotID  `json:"snapshot"`
	Project            ProjectID   `json:"project"`
	Signature          SignatureID `json:"signature"`
	SkipUnionExpanding bool        `json:"skipUnionExpanding,omitempty"`
}

// HasEffectiveRestParameterParams are the parameters for hasEffectiveRestParameter.
type HasEffectiveRestParameterParams struct {
	Snapshot  SnapshotID  `json:"snapshot"`
	Project   ProjectID   `json:"project"`
	Signature SignatureID `json:"signature"`
}

// GetContextualTypeForObjectLiteralElementParams are the parameters for
// getContextualTypeForObjectLiteralElement.
type GetContextualTypeForObjectLiteralElementParams struct {
	Snapshot     SnapshotID `json:"snapshot"`
	Project      ProjectID  `json:"project"`
	Location     NodeHandle `json:"location"`
	ContextFlags int32      `json:"contextFlags,omitempty"`
}

// SymbolToTypeParameterDeclarationsParams are the parameters for the symbolToTypeParameterDeclarations method.
type SymbolToTypeParameterDeclarationsParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Symbol   SymbolID   `json:"symbol"`
	Location NodeHandle `json:"location,omitempty"`
	Flags    int32      `json:"flags,omitempty"`
}

// SymbolToParameterDeclarationParams are the parameters for the symbolToParameterDeclaration method.
type SymbolToParameterDeclarationParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Symbol   SymbolID   `json:"symbol"`
	Location NodeHandle `json:"location,omitempty"`
	Flags    int32      `json:"flags,omitempty"`
}

// SignatureToStringParams are the parameters for the signatureToString method.
type SignatureToStringParams struct {
	Snapshot  SnapshotID  `json:"snapshot"`
	Project   ProjectID   `json:"project"`
	Signature SignatureID `json:"signature"`
	Location  NodeHandle  `json:"location,omitempty"`
	Flags     int32       `json:"flags,omitempty"`
}

// CheckerNodeOptionalParams are parameters for checker methods with an optional node.
type CheckerNodeOptionalParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location,omitempty"`
}

// GetParameterIdentifierInfoAtPositionParams are parameters for getParameterIdentifierInfoAtPosition.
type GetParameterIdentifierInfoAtPositionParams struct {
	Snapshot  SnapshotID  `json:"snapshot"`
	Project   ProjectID   `json:"project"`
	Signature SignatureID `json:"signature"`
	Position  int32       `json:"position"`
}

// ParameterIdentifierInfoResponse is the JSON shape for getParameterIdentifierInfoAtPosition.
// parameter is a NodeHandle for the Identifier (stock: Identifier, not Symbol).
type ParameterIdentifierInfoResponse struct {
	Parameter       NodeHandle `json:"parameter,omitempty"`
	ParameterName   string     `json:"parameterName"`
	IsRestParameter bool       `json:"isRestParameter"`
}

// CreateTransientSymbolWithTypeParams are parameters for createTransientSymbolWithType.
type CreateTransientSymbolWithTypeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Flags    uint32     `json:"flags"`
	Name     string     `json:"name"`
	Type     TypeID     `json:"type,omitempty"`
}

// CreateSignatureFromPartsParams are parameters for createSignatureFromParts.
type CreateSignatureFromPartsParams struct {
	Snapshot         SnapshotID `json:"snapshot"`
	Project          ProjectID  `json:"project"`
	Parameters       []SymbolID `json:"parameters"`
	ReturnType       TypeID     `json:"returnType"`
	MinArgumentCount int32      `json:"minArgumentCount"`
	Flags            uint32     `json:"flags"`
	TypeParameters   []TypeID   `json:"typeParameters,omitempty"`
	ThisParameter    SymbolID   `json:"thisParameter,omitempty"`
}

// IndexInfoPartWire is the wire shape for an index info in createAnonymousTypeFromParts.
type IndexInfoPartWire struct {
	KeyType    TypeID `json:"keyType"`
	ValueType  TypeID `json:"valueType"`
	IsReadonly bool   `json:"isReadonly"`
}

// CreateAnonymousTypeFromPartsParams are parameters for createAnonymousTypeFromParts.
type CreateAnonymousTypeFromPartsParams struct {
	Snapshot            SnapshotID          `json:"snapshot"`
	Project             ProjectID           `json:"project"`
	Symbol              SymbolID            `json:"symbol,omitempty"`
	Members             []SymbolID          `json:"members"`
	CallSignatures      []SignatureID       `json:"callSignatures"`
	ConstructSignatures []SignatureID       `json:"constructSignatures"`
	IndexInfos          []IndexInfoPartWire `json:"indexInfos"`
}

// GetMemberOverrideModifierStatusParams are parameters for getMemberOverrideModifierStatus.
type GetMemberOverrideModifierStatusParams struct {
	Snapshot          SnapshotID `json:"snapshot"`
	Project           ProjectID  `json:"project"`
	ClassLike         NodeHandle `json:"classLike"`
	Symbol            SymbolID   `json:"symbol"`
	MemberHasOverride bool       `json:"memberHasOverride"`
	MemberHasAbstract bool       `json:"memberHasAbstract"`
	MemberIsStatic    bool       `json:"memberIsStatic"`
	MemberHasName     bool       `json:"memberHasName"`
}

// GetSymbolOfExpandoParams are parameters for getSymbolOfExpando.
type GetSymbolOfExpandoParams struct {
	Snapshot         SnapshotID `json:"snapshot"`
	Project          ProjectID  `json:"project"`
	Location         NodeHandle `json:"location"`
	AllowDeclaration bool       `json:"allowDeclaration"`
}

// TryGetThisTypeAtParams are parameters for tryGetThisTypeAt.
type TryGetThisTypeAtParams struct {
	Snapshot          SnapshotID `json:"snapshot"`
	Project           ProjectID  `json:"project"`
	Location          NodeHandle `json:"location"`
	IncludeGlobalThis bool       `json:"includeGlobalThis"`
	Container         NodeHandle `json:"container,omitempty"`
}

// IsValidPropertyAccessForCompletionsParams are parameters for isValidPropertyAccessForCompletions.
type IsValidPropertyAccessForCompletionsParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	Type     TypeID     `json:"type"`
	Symbol   SymbolID   `json:"symbol"`
}

// IsPropertyAccessibleParams are parameters for isPropertyAccessible.
type IsPropertyAccessibleParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	IsSuper  bool       `json:"isSuper"`
	IsWrite  bool       `json:"isWrite"`
	Type     TypeID     `json:"type"`
	Symbol   SymbolID   `json:"symbol"`
}

// GetAccessibleSymbolChainParams are parameters for getAccessibleSymbolChain.
type GetAccessibleSymbolChainParams struct {
	Snapshot                SnapshotID `json:"snapshot"`
	Project                 ProjectID  `json:"project"`
	Symbol                  SymbolID   `json:"symbol"`
	EnclosingDeclaration    NodeHandle `json:"enclosingDeclaration,omitempty"`
	Meaning                 uint32     `json:"meaning"`
	UseOnlyExternalAliasing bool       `json:"useOnlyExternalAliasing"`
}

// GetContextualTypeForArgumentAtIndexParams are parameters for getContextualTypeForArgumentAtIndex.
type GetContextualTypeForArgumentAtIndexParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	ArgIndex int32      `json:"argIndex"`
}

// IsValidPropertyAccessParams are parameters for isValidPropertyAccess.
type IsValidPropertyAccessParams struct {
	Snapshot     SnapshotID `json:"snapshot"`
	Project      ProjectID  `json:"project"`
	Location     NodeHandle `json:"location"`
	PropertyName string     `json:"propertyName"`
}

// GetCandidateSignaturesForStringLiteralCompletionsParams are parameters for
// getCandidateSignaturesForStringLiteralCompletions.
type GetCandidateSignaturesForStringLiteralCompletionsParams struct {
	Snapshot        SnapshotID `json:"snapshot"`
	Project         ProjectID  `json:"project"`
	Call            NodeHandle `json:"call"`
	EditingArgument NodeHandle `json:"editingArgument"`
}

// GetSymbolsOfParameterPropertyDeclarationParams are parameters for
// getSymbolsOfParameterPropertyDeclaration.
type GetSymbolsOfParameterPropertyDeclarationParams struct {
	Snapshot      SnapshotID `json:"snapshot"`
	Project       ProjectID  `json:"project"`
	Location      NodeHandle `json:"location"`
	ParameterName string     `json:"parameterName"`
}

// GetNullableTypeParams are parameters for getNullableType.
type GetNullableTypeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Type     TypeID     `json:"type"`
	Flags    uint32     `json:"flags"`
}

// GetIndexKindParams are parameters for getIndexInfoOfType / getIndexTypeOfType (by IndexKind).
type GetIndexKindParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Type     TypeID     `json:"type"`
	Kind     int32      `json:"kind"` // 0 String, 1 Number
}

// FillMissingTypeArgumentsParams are parameters for fillMissingTypeArguments.
type FillMissingTypeArgumentsParams struct {
	Snapshot                SnapshotID `json:"snapshot"`
	Project                 ProjectID  `json:"project"`
	TypeArguments           []TypeID   `json:"typeArguments"`
	TypeParameters          []TypeID   `json:"typeParameters"`
	MinTypeArgumentCount    int32      `json:"minTypeArgumentCount"`
	IsJavaScriptImplicitAny bool       `json:"isJavaScriptImplicitAny"`
}

// GetUnmatchedPropertiesParams are parameters for getUnmatchedProperties.
type GetUnmatchedPropertiesParams struct {
	Snapshot                    SnapshotID `json:"snapshot"`
	Project                     ProjectID  `json:"project"`
	Source                      TypeID     `json:"source"`
	Target                      TypeID     `json:"target"`
	RequireOptionalProperties   bool       `json:"requireOptionalProperties"`
	MatchDiscriminantProperties bool       `json:"matchDiscriminantProperties"`
}

// IsSymbolAccessibleParams are parameters for isSymbolAccessible.
type IsSymbolAccessibleParams struct {
	Snapshot                          SnapshotID `json:"snapshot"`
	Project                           ProjectID  `json:"project"`
	Symbol                            SymbolID   `json:"symbol"`
	EnclosingDeclaration              NodeHandle `json:"enclosingDeclaration,omitempty"`
	Meaning                           uint32     `json:"meaning"`
	ShouldComputeAliasesToMakeVisible bool       `json:"shouldComputeAliasesToMakeVisible"`
}

// SymbolAccessibilityResultResponse is the JSON shape for isSymbolAccessible.
type SymbolAccessibilityResultResponse struct {
	Accessibility   int32  `json:"accessibility"`
	ErrorSymbolName string `json:"errorSymbolName,omitempty"`
	ErrorModuleName string `json:"errorModuleName,omitempty"`
}

// GetIndexInfosOfIndexSymbolParams are parameters for getIndexInfosOfIndexSymbol.
type GetIndexInfosOfIndexSymbolParams struct {
	Snapshot       SnapshotID `json:"snapshot"`
	Project        ProjectID  `json:"project"`
	Symbol         SymbolID   `json:"symbol"`
	SiblingSymbols []SymbolID `json:"siblingSymbols,omitempty"`
}

// GetSuggestedSymbolForNonexistentPropertyParams — name is a MemberName node.
type GetSuggestedSymbolForNonexistentPropertyParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	Type     TypeID     `json:"type"`
}

// GetSuggestedSymbolForNonexistentClassMemberParams — name is a plain string.
type GetSuggestedSymbolForNonexistentClassMemberParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Name     string     `json:"name"`
	Type     TypeID     `json:"type"`
}

// GetSuggestedSymbolForNonexistentJSXAttributeParams — name is a string (idText).
type GetSuggestedSymbolForNonexistentJSXAttributeParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Name     string     `json:"name"`
	Type     TypeID     `json:"type"`
}

// GetSuggestedSymbolForNonexistentModuleParams — name node + module symbol.
type GetSuggestedSymbolForNonexistentModuleParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	Symbol   SymbolID   `json:"symbol"`
}

// GetSuggestedSymbolForNonexistentSymbolParams — location + name + meaning.
type GetSuggestedSymbolForNonexistentSymbolParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	Location NodeHandle `json:"location"`
	Name     string     `json:"name"`
	Meaning  int32      `json:"meaning"`
}

// SymbolToNodeBuilderParams — shared by symbolToExpression/Node/EntityName.
type SymbolToNodeBuilderParams struct {
	Snapshot      SnapshotID `json:"snapshot"`
	Project       ProjectID  `json:"project"`
	Symbol        SymbolID   `json:"symbol"`
	Meaning       int32      `json:"meaning"`
	Location      NodeHandle `json:"location,omitempty"`
	Flags         int32      `json:"flags,omitempty"`
	InternalFlags int32      `json:"internalFlags,omitempty"`
}

// TypePredicateToTypePredicateNodeParams — reconstruct TypePredicate from wire fields.
type TypePredicateToTypePredicateNodeParams struct {
	Snapshot       SnapshotID `json:"snapshot"`
	Project        ProjectID  `json:"project"`
	Kind           int32      `json:"kind"`
	ParameterIndex int32      `json:"parameterIndex"`
	ParameterName  string     `json:"parameterName,omitempty"`
	Type           TypeID     `json:"type,omitempty"`
	Location       NodeHandle `json:"location,omitempty"`
	Flags          int32      `json:"flags,omitempty"`
}

// IndexInfoToIndexSignatureDeclarationParams — reconstruct IndexInfo from wire fields.
type IndexInfoToIndexSignatureDeclarationParams struct {
	Snapshot    SnapshotID `json:"snapshot"`
	Project     ProjectID  `json:"project"`
	KeyType     TypeID     `json:"keyType"`
	ValueType   TypeID     `json:"valueType"`
	IsReadonly  bool       `json:"isReadonly,omitempty"`
	Declaration NodeHandle `json:"declaration,omitempty"`
	Location    NodeHandle `json:"location,omitempty"`
	Flags       int32      `json:"flags,omitempty"`
}

// GetModeForUsageLocationParams locate a module-specifier string literal.
type GetModeForUsageLocationParams struct {
	Snapshot SnapshotID         `json:"snapshot"`
	Project  ProjectID          `json:"project"`
	File     DocumentIdentifier `json:"file"`
	Position uint32             `json:"position"`
}

// ResolutionModeResponse is ESNext/CommonJS, or null when stock would return undefined.
type ResolutionModeResponse struct {
	Mode *int32 `json:"mode"`
}

// ModuleKindResponse is the emit module format for a source file.
type ModuleKindResponse struct {
	Kind int32 `json:"kind"`
}

// RedirectTargetsResponse lists redirect target paths for a program file.
type RedirectTargetsResponse struct {
	Targets []string `json:"targets"`
}

// EmitParams are parameters for the emit method.
type EmitParams struct {
	Snapshot SnapshotID          `json:"snapshot"`
	Project  ProjectID           `json:"project"`
	File     *DocumentIdentifier `json:"file,omitempty"`
	// EmitOnly maps to compiler.EmitOnly (0=All, 1=Js, 2=Dts, 3=ForcedDts). nil = All.
	EmitOnly     *int `json:"emitOnly,omitempty"`
	ForceDtsEmit bool `json:"forceDtsEmit,omitempty"`
}

// EmitOutputFile is one file produced by emit; the JS host writes it to disk so
// --noEmit, Volar output redirection, and build-mode writeFile wrapping are honored.
type EmitOutputFile struct {
	FileName           string `json:"fileName"`
	Text               string `json:"text"`
	WriteByteOrderMark bool   `json:"writeByteOrderMark"`
}

// EmitResponse is the API response for the emit method.
type EmitResponse struct {
	EmitSkipped  bool                  `json:"emitSkipped"`
	Diagnostics  []*DiagnosticResponse `json:"diagnostics,omitempty"`
	EmittedFiles []string              `json:"emittedFiles,omitempty"`
	OutputFiles  []*EmitOutputFile     `json:"outputFiles,omitempty"`
}

// EmitBuildInfoParams are parameters for the emitBuildInfo method. The response
// is an EmitResponse whose outputFiles carry the serialized .tsbuildinfo for
// the JS host to write.
type EmitBuildInfoParams struct {
	Snapshot SnapshotID `json:"snapshot"`
	Project  ProjectID  `json:"project"`
	// Build mirrors the `tsc -b` command-line flag: the solution builder passes
	// build-mode via the command line (never the tsconfig on disk that this
	// project was loaded from), and buildinfo emit for non-incremental projects
	// only happens under that flag.
	Build bool `json:"build,omitempty"`
}

// TextEditWire is one host edit delta in UTF-16 code units.
type TextEditWire struct {
	Start        int    `json:"start"`
	DeleteLength int    `json:"deleteLength"`
	InsertText   string `json:"insertText"`
}

// CompletionsPreferences mirrors the editor completion preferences the tsserver
// session forwards (nil fields keep the snapshot defaults). Only the fields the
// ls pipeline actually reads are wired (insert-text/snippet/package-json behavior
// is hardcoded in the pipeline and matches editor defaults).
type CompletionsPreferences struct {
	IncludeCompletionsForModuleExports                *bool `json:"includeCompletionsForModuleExports,omitempty"`
	IncludeCompletionsForImportStatements             *bool `json:"includeCompletionsForImportStatements,omitempty"`
	IncludeAutomaticOptionalChainCompletions          *bool `json:"includeAutomaticOptionalChainCompletions,omitempty"`
	IncludeCompletionsWithClassMemberSnippets         *bool `json:"includeCompletionsWithClassMemberSnippets,omitempty"`
	IncludeCompletionsWithObjectLiteralMethodSnippets *bool `json:"includeCompletionsWithObjectLiteralMethodSnippets,omitempty"`
}

type TnbCompletionDataResponse struct {
	AutoImport *lsproto.AutoImportFix `json:"autoImport,omitempty"`
}
