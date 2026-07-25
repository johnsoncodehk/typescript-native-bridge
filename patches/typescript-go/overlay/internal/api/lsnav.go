package api

// LS navigation payloads (TNB issue #12, batch 1): quickinfo / references /
// definitionAndBoundSpan computed Go-side (internal/ls) and returned as
// stock-services-shaped records, over both transports (JSON and V8-arena).
// Spans cross as UTF-16 offsets (tsserver/JS convention); the ls layer works in
// UTF-8 and is converted here per file position map.

import (
	"context"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/collections"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/json"
	"github.com/microsoft/typescript-go/internal/ls"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/module"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
)

// ── Params ─────────────────────────────────────────────────────────────────

// QuickinfoParams are the parameters for the quickinfo method.
type QuickinfoParams struct {
	Snapshot           SnapshotID         `json:"snapshot"`
	Project            ProjectID          `json:"project"`
	File               DocumentIdentifier `json:"file"`
	Position           uint32             `json:"position"`
	MaximumHoverLength int32              `json:"maximumHoverLength,omitempty"` // <=0: undefined (stock default 500)
	VerbosityLevel     *int32             `json:"verbosityLevel,omitempty"`     // nil: undefined
}

// ReferencesParams are the parameters for the references method.
type ReferencesParams struct {
	Snapshot  SnapshotID         `json:"snapshot"`
	Project   ProjectID          `json:"project"`
	File      DocumentIdentifier `json:"file"`
	Position  uint32             `json:"position"`
}

// DefinitionAndBoundSpanParams are the parameters for the definitionAndBoundSpan method.
type DefinitionAndBoundSpanParams struct {
	Snapshot  SnapshotID         `json:"snapshot"`
	Project   ProjectID          `json:"project"`
	File      DocumentIdentifier `json:"file"`
	Position  uint32             `json:"position"`
}

// ── Responses ──────────────────────────────────────────────────────────────

// DisplayPartResponse mirrors Strada's SymbolDisplayPart.
type DisplayPartResponse struct {
	Text string `json:"text"`
	Kind string `json:"kind"`
}

// JSDocTagResponse mirrors Strada's JSDocTagInfo.
type JSDocTagResponse struct {
	Name string                `json:"name"`
	Text []DisplayPartResponse `json:"text,omitempty"`
}

// QuickinfoResponse mirrors the stock QuickInfo consumed by the session
// (displayParts pre-flattened to displayString).
type QuickinfoResponse struct {
	Kind                      string                `json:"kind"`
	KindModifiers             string                `json:"kindModifiers"`
	Start                     uint32                `json:"start"`
	Length                    uint32                `json:"length"`
	DisplayString             string                `json:"displayString"`
	Documentation             []DisplayPartResponse `json:"documentation,omitempty"`
	Tags                      []JSDocTagResponse    `json:"tags,omitempty"`
	CanIncreaseVerbosityLevel *bool                 `json:"canIncreaseVerbosityLevel,omitzero"`
}

// DocumentSpanResponse mirrors Strada's DocumentSpan with the span decomposed
// (UTF-16 offsets; context span absent when contextStart/contextLength are nil).
type DocumentSpanResponse struct {
	FileName      string  `json:"fileName"`
	Start         uint32  `json:"start"`
	Length        uint32  `json:"length"`
	ContextStart  *uint32 `json:"contextStart,omitzero"`
	ContextLength *uint32 `json:"contextLength,omitzero"`
}

// DefinitionInfoResponse mirrors Strada's DefinitionInfo /
// ReferencedSymbolDefinitionInfo.
type DefinitionInfoResponse struct {
	DocumentSpanResponse
	Kind                  string                `json:"kind"`
	Name                  string                `json:"name"`
	ContainerKind         *string               `json:"containerKind,omitzero"`
	ContainerName         *string               `json:"containerName,omitzero"`
	DisplayParts          []DisplayPartResponse `json:"displayParts,omitempty"`
	Unverified            *bool                 `json:"unverified,omitzero"`
	IsLocal               *bool                 `json:"isLocal,omitzero"`
	IsAmbient             *bool                 `json:"isAmbient,omitzero"`
	FailedAliasResolution *bool                 `json:"failedAliasResolution,omitzero"`
}

// ReferenceEntryResponse mirrors Strada's ReferencedSymbolEntry.
type ReferenceEntryResponse struct {
	DocumentSpanResponse
	IsWriteAccess bool  `json:"isWriteAccess"`
	IsDefinition  *bool `json:"isDefinition,omitzero"`
	IsInString    *bool `json:"isInString,omitzero"`
}

// ReferencedSymbolResponse mirrors Strada's ReferencedSymbol.
type ReferencedSymbolResponse struct {
	Definition *DefinitionInfoResponse   `json:"definition"`
	References []*ReferenceEntryResponse `json:"references"`
}

// DefinitionAndBoundSpanResponse mirrors Strada's DefinitionInfoAndBoundSpan.
type DefinitionAndBoundSpanResponse struct {
	Definitions []*DefinitionInfoResponse `json:"definitions"`
	Start       uint32                    `json:"start"`
	Length      uint32                    `json:"length"`
}

// ── Payload conversion (UTF-8 spans → UTF-16 wire spans) ───────────────────

type lsNavContext struct {
	program *compiler.Program
}

func (c lsNavContext) span(fileName string, r core.TextRange) (uint32, uint32) {
	start, end := int(r.Pos()), int(r.End())
	if sf := c.program.GetSourceFile(fileName); sf != nil {
		pm := sf.GetPositionMap()
		u16s := int(pm.UTF8ToUTF16(start))
		u16e := int(pm.UTF8ToUTF16(end))
		return uint32(u16s), uint32(u16e - u16s)
	}
	return uint32(start), uint32(end - start)
}

func (c lsNavContext) documentSpan(d ls.DocumentSpanPayload) DocumentSpanResponse {
	start, length := c.span(d.FileName, d.TextSpan)
	out := DocumentSpanResponse{FileName: d.FileName, Start: start, Length: length}
	if d.HasContextSpan {
		cs, cl := c.span(d.FileName, d.ContextSpan)
		out.ContextStart = &cs
		out.ContextLength = &cl
	}
	return out
}

func displayParts(parts []ls.DisplayPart) []DisplayPartResponse {
	if len(parts) == 0 {
		return nil
	}
	out := make([]DisplayPartResponse, len(parts))
	for i, p := range parts {
		out[i] = DisplayPartResponse{Text: p.Text, Kind: p.Kind}
	}
	return out
}

func (c lsNavContext) definitionInfo(d *ls.DefinitionInfoPayload) *DefinitionInfoResponse {
	if d == nil {
		return nil
	}
	return &DefinitionInfoResponse{
		DocumentSpanResponse: c.documentSpan(d.DocumentSpanPayload),
		Kind:                 d.Kind,
		Name:                 d.Name,
		ContainerKind:        d.ContainerKind,
		ContainerName:        d.ContainerName,
		DisplayParts:         displayParts(d.DisplayParts),
		Unverified:           d.Unverified,
		IsLocal:              d.IsLocal,
		IsAmbient:            d.IsAmbient,
		FailedAliasResolution: d.FailedAliasResolution,
	}
}

// ── Handlers ───────────────────────────────────────────────────────────────

func (s *Session) handleQuickinfo(ctx context.Context, params *QuickinfoParams) (*QuickinfoResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	verbosity := -1
	if params.VerbosityLevel != nil {
		verbosity = int(*params.VerbosityLevel)
	}
	qi := langSvc.GetQuickInfoForAPI(ctx, sourceFile, internalPos, int(params.MaximumHoverLength), verbosity)
	if qi == nil {
		return nil, nil
	}
	conv := lsNavContext{program}
	start, length := conv.span(sourceFile.FileName(), qi.Span)
	var tags []JSDocTagResponse
	for _, t := range qi.Tags {
		tags = append(tags, JSDocTagResponse{Name: t.Name, Text: displayParts(t.Text)})
	}
	return &QuickinfoResponse{
		Kind:                      qi.Kind,
		KindModifiers:             qi.KindModifiers,
		Start:                     start,
		Length:                    length,
		DisplayString:             qi.DisplayString,
		Documentation:             displayParts(qi.Documentation),
		Tags:                      tags,
		CanIncreaseVerbosityLevel: qi.CanIncreaseVerbosityLevel,
	}, nil
}

func (s *Session) handleReferences(ctx context.Context, params *ReferencesParams) ([]*ReferencedSymbolResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	symbols := langSvc.FindReferencesForAPI(ctx, sourceFile, internalPos)
	if symbols == nil {
		return nil, nil
	}
	conv := lsNavContext{program}
	out := make([]*ReferencedSymbolResponse, 0, len(symbols))
	for _, sym := range symbols {
		payload := &ReferencedSymbolResponse{
			Definition: conv.definitionInfo(sym.Definition),
			References: make([]*ReferenceEntryResponse, 0, len(sym.References)),
		}
		for _, entry := range sym.References {
			span := conv.documentSpan(entry.DocumentSpanPayload)
			payload.References = append(payload.References, &ReferenceEntryResponse{
				DocumentSpanResponse: span,
				IsWriteAccess:        entry.IsWriteAccess,
				IsDefinition:         entry.IsDefinition,
				IsInString:           entry.IsInString,
			})
		}
		out = append(out, payload)
	}
	return out, nil
}

func (s *Session) handleDefinitionAndBoundSpan(ctx context.Context, params *DefinitionAndBoundSpanParams) (*DefinitionAndBoundSpanResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	result := langSvc.GetDefinitionAndBoundSpanForAPI(ctx, sourceFile, internalPos)
	if result == nil {
		return nil, nil
	}
	conv := lsNavContext{program}
	defs := make([]*DefinitionInfoResponse, 0, len(result.Definitions))
	for _, d := range result.Definitions {
		defs = append(defs, conv.definitionInfo(d))
	}
	start, length := conv.span(sourceFile.FileName(), result.TextSpan)
	return &DefinitionAndBoundSpanResponse{
		Definitions: defs,
		Start:       start,
		Length:      length,
	}, nil
}


// lspRangeToSpan converts an LSP (line, character) range back to a UTF-16
// (start, length) span using the file's line map (LSP characters are UTF-16).
func lspRangeToSpan(sourceFile *ast.SourceFile, r lsproto.Range) (uint32, uint32) {
	lineMap := sourceFile.ECMALineMap()
	pm := sourceFile.GetPositionMap()
	toOffset := func(line, char uint32) uint32 {
		if int(line) >= len(lineMap) {
			return 0
		}
		return uint32(pm.UTF8ToUTF16(int(lineMap[line]))) + char
	}
	start := toOffset(r.Start.Line, r.Start.Character)
	end := toOffset(r.End.Line, r.End.Character)
	return start, end - start
}

// completionsPrefsHost wraps the snapshot host with per-request completion
// preferences forwarded from the editor (issue #12).
type completionsPrefsHost struct {
	ls.Host
	prefs lsutil.UserPreferences
}

func (h *completionsPrefsHost) GetPreferences(string) lsutil.UserPreferences {
	return h.prefs
}

func mergeCompletionsPreferences(base lsutil.UserPreferences, p *CompletionsPreferences) lsutil.UserPreferences {
	if p != nil {
		set := func(dst *core.Tristate, v *bool) {
			if v != nil {
				if *v {
					*dst = core.TSTrue
				} else {
					*dst = core.TSFalse
				}
			}
		}
		set(&base.IncludeCompletionsForModuleExports, p.IncludeCompletionsForModuleExports)
		set(&base.IncludeCompletionsForImportStatements, p.IncludeCompletionsForImportStatements)
		set(&base.IncludeAutomaticOptionalChainCompletions, p.IncludeAutomaticOptionalChainCompletions)
		set(&base.IncludeCompletionsWithClassMemberSnippets, p.IncludeCompletionsWithClassMemberSnippets)
		set(&base.IncludeCompletionsWithObjectLiteralMethodSnippets, p.IncludeCompletionsWithObjectLiteralMethodSnippets)
	}
	// Stock's tsserver session defaults includeCompletionsForModuleExports to
	// off (falsy check in shouldOfferImportCompletions); tsgo's LSP default
	// (NewDefaultUserPreferences) is on, and the bridge's project session is
	// never re-configured — session-configured state only ever arrives
	// per-request. So "request didn't set it" must mean stock's off, not the
	// LSP default's on.
	if p == nil || p.IncludeCompletionsForModuleExports == nil {
		base.IncludeCompletionsForModuleExports = core.TSFalse
	}
	return base
}

func ptrTrue() *bool { t := true; return &t }

// decodeCompletionsPreferences reads the five tri-state preference bytes
// (0=unset, 1=true, 2=false) starting at off.
func decodeCompletionsPreferences(r *arenaReq, off int) *CompletionsPreferences {
	p := &CompletionsPreferences{
		IncludeCompletionsForModuleExports:              triBool(r.u8(off)),
		IncludeCompletionsForImportStatements:           triBool(r.u8(off + 1)),
		IncludeAutomaticOptionalChainCompletions:        triBool(r.u8(off + 2)),
		IncludeCompletionsWithClassMemberSnippets:       triBool(r.u8(off + 3)),
		IncludeCompletionsWithObjectLiteralMethodSnippets: triBool(r.u8(off + 4)),
	}
	if p.IncludeCompletionsForModuleExports == nil && p.IncludeCompletionsForImportStatements == nil &&
		p.IncludeAutomaticOptionalChainCompletions == nil && p.IncludeCompletionsWithClassMemberSnippets == nil &&
		p.IncludeCompletionsWithObjectLiteralMethodSnippets == nil {
		return nil
	}
	return p
}

// ── Completion candidate filter + ordering (stock parity) ─────────────────

// filterAutoImportItemsByPackageJsonVisibility mirrors stock's auto-import
// candidate rule (getPackageJsonsVisibleToFile): a bare-module candidate is
// offered only when its package appears in a package.json visible from the
// importing file — any of dependencies/devDependencies/optionalDependencies/
// peerDependencies, @types names canonicalized to the base package. tsgo's
// view additionally unions program-resolved packages (ResolvedPackageNames),
// which stock does not offer (verified against stock tsserver: a package
// imported by the program but absent from package.json is not suggested).
// It also returns the dependencies/peerDependencies-only set, which marks
// stock's provider-covered (isPackageJsonImport) candidates.
func filterAutoImportItemsByPackageJsonVisibility(items []*ls.CompletionItem, fileName string, fsys vfs.FS) ([]*ls.CompletionItem, *collections.Set[string]) {
	needsFilter := false
	for _, item := range items {
		if item.Data != nil && item.Data.Source != "" {
			needsFilter = true
			break
		}
	}
	if !needsFilter {
		return items, nil
	}
	var allowed *collections.Set[string]
	var providerDeps *collections.Set[string]
	for dir := tspath.GetDirectoryPath(fileName); ; {
		if contents, ok := fsys.ReadFile(tspath.CombinePaths(dir, "package.json")); ok {
			var pj struct {
				Dependencies         map[string]string `json:"dependencies"`
				DevDependencies      map[string]string `json:"devDependencies"`
				OptionalDependencies map[string]string `json:"optionalDependencies"`
				PeerDependencies     map[string]string `json:"peerDependencies"`
			}
			if err := json.Unmarshal([]byte(contents), &pj); err == nil {
				if allowed == nil {
					allowed = &collections.Set[string]{}
				}
				for _, deps := range []map[string]string{pj.Dependencies, pj.DevDependencies, pj.OptionalDependencies, pj.PeerDependencies} {
					for name := range deps {
						if name != "" && name[0] != '.' {
							allowed.Add(module.GetPackageNameFromTypesPackageName(name))
						}
					}
				}
				if providerDeps == nil && (len(pj.Dependencies) > 0 || len(pj.PeerDependencies) > 0) {
					providerDeps = &collections.Set[string]{}
				}
				for _, deps := range []map[string]string{pj.Dependencies, pj.PeerDependencies} {
					for name := range deps {
						if name != "" && name[0] != '.' {
							providerDeps.Add(module.GetPackageNameFromTypesPackageName(name))
						}
					}
				}
			}
		}
		parent := tspath.GetDirectoryPath(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if allowed == nil {
		// No package.json on the spine: both engines offer everything.
		return items, nil
	}
	out := make([]*ls.CompletionItem, 0, len(items))
	for _, item := range items {
		if item.Data != nil && item.Data.Source != "" && item.Data.AutoImport != nil {
			if name := packageNameFromSpecifier(item.Data.AutoImport.ModuleSpecifier); name != "" && !allowed.Has(name) {
				continue
			}
		}
		out = append(out, item)
	}
	return out, providerDeps
}

// packageNameFromSpecifier extracts the package name from a bare module
// specifier; "" for relative specifiers (not package candidates).
func packageNameFromSpecifier(spec string) string {
	if spec == "" || spec[0] == '.' {
		return ""
	}
	rest := spec
	if spec[0] == '@' {
		slash := strings.IndexByte(spec, '/')
		if slash < 0 {
			return spec
		}
		rest = spec[slash+1:]
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			rest = rest[:i]
		}
		return spec[:slash] + "/" + rest
	}
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func autoImportModuleSpecifier(item *ls.CompletionItem) string {
	if item.Data != nil && item.Data.AutoImport != nil {
		return item.Data.AutoImport.ModuleSpecifier
	}
	return ""
}

// sortCompletionItems mirrors stock's compareCompletionEntries: sortText, then
// name, then auto-import module-specifier directory depth; stable on ties
// (stock's full-tie reversal only matters for identical keys, which do not
// occur in practice).
func sortCompletionItems(items []*ls.CompletionItem) {
	slices.SortStableFunc(items, func(a, b *ls.CompletionItem) int {
		if c := compareCollationUI(strVal(a.SortText), strVal(b.SortText)); c != 0 {
			return c
		}
		if c := compareCollationUI(a.Label, b.Label); c != 0 {
			return c
		}
		as, bs := autoImportModuleSpecifier(a), autoImportModuleSpecifier(b)
		if as != "" && bs != "" {
			if c := strings.Count(as, "/") - strings.Count(bs, "/"); c != 0 {
				return c
			}
			return strings.Compare(as, bs)
		}
		return 0
	})
}

// compareCollationUI approximates stock's Intl.Collator({usage:"sort",
// sensitivity:"variant", numeric:true}) used to order completion entries:
// case-insensitive primary with numeric digit runs, then a lowercase-before-
// uppercase tertiary (ICU case ordering). Exact for the ASCII identifiers and
// sortTexts completions carry; non-ASCII accent orderings may diverge.
func compareCollationUI(a, b string) int {
	if c := compareFoldedNumeric(a, b); c != 0 {
		return c
	}
	ar, br := []rune(a), []rune(b)
	for i := 0; i < len(ar) && i < len(br); i++ {
		x, y := ar[i], br[i]
		if x == y {
			continue
		}
		lx, ly := unicode.ToLower(x) == x, unicode.ToLower(y) == y
		if lx != ly {
			if lx {
				return -1
			}
			return 1
		}
		if x < y {
			return -1
		}
		return 1
	}
	return len(ar) - len(br)
}

func compareFoldedNumeric(a, b string) int {
	ai, bi := 0, 0
	for ai < len(a) && bi < len(b) {
		if isASCIIDigit(a[ai]) && isASCIIDigit(b[bi]) {
			za, ea := scanDigits(a, ai)
			zb, eb := scanDigits(b, bi)
			if c := compareDigitRuns(a[za:ea], b[zb:eb]); c != 0 {
				return c
			}
			ai, bi = ea, eb
			continue
		}
		ra, sa := utf8.DecodeRuneInString(a[ai:])
		rb, sb := utf8.DecodeRuneInString(b[bi:])
		ua, ub := unicode.ToUpper(ra), unicode.ToUpper(rb)
		if ua != ub {
			if ua < ub {
				return -1
			}
			return 1
		}
		ai, bi = ai+sa, bi+sb
	}
	switch {
	case ai < len(a):
		return 1
	case bi < len(b):
		return -1
	}
	return 0
}

func isASCIIDigit(c byte) bool { return c >= '0' && c <= '9' }

func scanDigits(s string, start int) (int, int) {
	end := start
	for end < len(s) && isASCIIDigit(s[end]) {
		end++
	}
	return start, end
}

// compareDigitRuns compares two digit runs by numeric value without overflow.
func compareDigitRuns(a, b string) int {
	ta, tb := strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
	if len(ta) != len(tb) {
		return len(ta) - len(tb)
	}
	if c := strings.Compare(ta, tb); c != 0 {
		return c
	}
	// Same numeric value: fewer leading zeros first ("2" before "02", matching
	// Intl.Collator numeric ordering).
	return len(a) - len(b)
}

// ── SignatureHelp (issue #12 batch 2) ─────────────────────────────────────

// SignatureHelpParams are the parameters for the signatureHelp method.
type SignatureHelpParams struct {
	Snapshot      SnapshotID         `json:"snapshot"`
	Project       ProjectID          `json:"project"`
	File          DocumentIdentifier `json:"file"`
	Position      uint32             `json:"position"`
	TriggerReason *string            `json:"triggerReason,omitempty"`
}

// TextSpanWire mirrors Strada's TextSpan.
type TextSpanWire struct {
	Start  uint32 `json:"start"`
	Length uint32 `json:"length"`
}

// SignatureHelpItemsResponse mirrors the stock SignatureHelpItems body.
type SignatureHelpItemsResponse struct {
	Items             []*SignatureHelpItemResponse `json:"items"`
	ApplicableSpan    TextSpanWire                 `json:"applicableSpan"`
	SelectedItemIndex uint32                       `json:"selectedItemIndex"`
	ArgumentIndex     uint32                       `json:"argumentIndex"`
	ArgumentCount     uint32                       `json:"argumentCount"`
}

// SignatureHelpItemResponse mirrors Strada's SignatureHelpItem.
type SignatureHelpItemResponse struct {
	IsVariadic    bool                            `json:"isVariadic"`
	Prefix        []DisplayPartResponse           `json:"prefixDisplayParts"`
	Suffix        []DisplayPartResponse           `json:"suffixDisplayParts"`
	Separator     []DisplayPartResponse           `json:"separatorDisplayParts"`
	Parameters    []*SignatureHelpParameterResponse `json:"parameters"`
	Documentation []DisplayPartResponse             `json:"documentation"`
	Tags          []JSDocTagResponse              `json:"tags,omitempty"`
}

// SignatureHelpParameterResponse mirrors Strada's SignatureHelpParameter.
type SignatureHelpParameterResponse struct {
	Name          string                `json:"name"`
	Documentation []DisplayPartResponse `json:"documentation"`
	DisplayParts  []DisplayPartResponse `json:"displayParts"`
	IsOptional    bool                  `json:"isOptional"`
	IsRest        bool                  `json:"isRest"`
}

func (s *Session) handleSignatureHelp(ctx context.Context, params *SignatureHelpParams) (*SignatureHelpItemsResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	reason := ""
	if params.TriggerReason != nil {
		reason = *params.TriggerReason
	}
	payload := langSvc.GetSignatureHelpForAPI(ctx, sourceFile, internalPos, reason)
	if payload == nil {
		return nil, nil
	}
	conv := lsNavContext{program}
	resp := &SignatureHelpItemsResponse{
		SelectedItemIndex: payload.SelectedItemIndex,
		ArgumentIndex:     payload.ArgumentIndex,
		ArgumentCount:     payload.ArgumentCount,
	}
	spanStart, spanLength := conv.span(sourceFile.FileName(), payload.ApplicableSpan)
	resp.ApplicableSpan = TextSpanWire{Start: spanStart, Length: spanLength}
	for _, item := range payload.Items {
		ir := &SignatureHelpItemResponse{
			IsVariadic:    item.IsVariadic,
			Prefix:        displayParts(item.Prefix),
			Suffix:        displayParts(item.Suffix),
			Separator:     displayParts(item.Separator),
			Documentation: displayParts(item.Documentation),
		}
		for _, t := range item.Tags {
			ir.Tags = append(ir.Tags, JSDocTagResponse{Name: t.Name, Text: displayParts(t.Text)})
		}
		for _, p := range item.Parameters {
			ir.Parameters = append(ir.Parameters, &SignatureHelpParameterResponse{
				Name:          p.Name,
				Documentation: displayParts(p.Documentation),
				DisplayParts:  displayParts(p.DisplayParts),
				IsOptional:    p.IsOptional,
				IsRest:        p.IsRest,
			})
		}
		resp.Items = append(resp.Items, ir)
	}
	return resp, nil
}

// ── Rename (issue #12 batch 2) ────────────────────────────────────────────

// RenameInfoParams are the parameters for the getRenameInfo method.
type RenameInfoParams struct {
	Snapshot                        SnapshotID         `json:"snapshot"`
	Project                         ProjectID          `json:"project"`
	File                            DocumentIdentifier `json:"file"`
	Position                        uint32             `json:"position"`
	AllowRenameOfImportPath         *bool              `json:"allowRenameOfImportPath,omitempty"`
	ProvidePrefixAndSuffixTextForRename *bool          `json:"providePrefixAndSuffixTextForRename,omitempty"`
}

// RenameInfoResponse mirrors Strada's RenameInfo (success or failure).
type RenameInfoResponse struct {
	CanRename             bool    `json:"canRename"`
	FileToRename          string  `json:"fileToRename,omitempty"`
	DisplayName           string  `json:"displayName,omitempty"`
	FullDisplayName       string  `json:"fullDisplayName,omitempty"`
	Kind                  string  `json:"kind,omitempty"`
	KindModifiers         *string `json:"kindModifiers,omitempty"`
	TriggerSpan           *TextSpanWire `json:"triggerSpan,omitempty"`
	LocalizedErrorMessage string  `json:"localizedErrorMessage,omitempty"`
}

// EditsForRenameParams are the parameters for the getEditsForRename method.
type EditsForRenameParams struct {
	Snapshot                        SnapshotID         `json:"snapshot"`
	Project                         ProjectID          `json:"project"`
	File                            DocumentIdentifier `json:"file"`
	Position                        uint32             `json:"position"`
	FindInStrings                   bool               `json:"findInStrings,omitempty"`
	FindInComments                  bool               `json:"findInComments,omitempty"`
	ProvidePrefixAndSuffixTextForRename *bool          `json:"providePrefixAndSuffixTextForRename,omitempty"`
}

// RenameLocationResponse mirrors Strada's RenameLocation entry.
type RenameLocationResponse struct {
	DocumentSpanResponse
	PrefixText string `json:"prefixText,omitempty"`
	SuffixText string `json:"suffixText,omitempty"`
}

func (s *Session) handleGetRenameInfo(ctx context.Context, params *RenameInfoParams) (*RenameInfoResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	allowImportPath := true
	if params.AllowRenameOfImportPath != nil {
		allowImportPath = *params.AllowRenameOfImportPath
	}
	providePrefixSuffix := params.ProvidePrefixAndSuffixTextForRename != nil && *params.ProvidePrefixAndSuffixTextForRename
	payload := langSvc.GetRenameInfoForAPI(ctx, sourceFile, internalPos, allowImportPath, providePrefixSuffix)
	if payload == nil {
		return nil, nil
	}
	resp := &RenameInfoResponse{
		CanRename:             payload.CanRename,
		FileToRename:          payload.FileToRename,
		DisplayName:           payload.DisplayName,
		FullDisplayName:       payload.FullDisplayName,
		Kind:                  payload.Kind,
		LocalizedErrorMessage: payload.LocalizedErrorMessage,
	}
	if payload.CanRename {
		resp.KindModifiers = &payload.KindModifiers
	}
	if payload.CanRename {
		conv := lsNavContext{program}
		start, length := conv.span(sourceFile.FileName(), payload.TriggerSpan)
		resp.TriggerSpan = &TextSpanWire{Start: start, Length: length}
	}
	return resp, nil
}

func (s *Session) handleGetEditsForRename(ctx context.Context, params *EditsForRenameParams) ([]*RenameLocationResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, nil
	}
	langSvc, err := s.setupLanguageService(sd, program, params.Project, "")
	if err != nil {
		return nil, err
	}
	positionMap := sourceFile.GetPositionMap()
	internalPos := int(positionMap.UTF16ToUTF8(int(params.Position)))
	providePrefixSuffix := params.ProvidePrefixAndSuffixTextForRename != nil && *params.ProvidePrefixAndSuffixTextForRename
	locs := langSvc.FindRenameLocationsForAPI(ctx, sourceFile, internalPos, params.FindInStrings, params.FindInComments, providePrefixSuffix)
	if locs == nil {
		return nil, nil
	}
	conv := lsNavContext{program}
	out := make([]*RenameLocationResponse, 0, len(locs))
	for _, loc := range locs {
		out = append(out, &RenameLocationResponse{
			DocumentSpanResponse: conv.documentSpan(loc.DocumentSpanPayload),
			PrefixText:           loc.PrefixText,
			SuffixText:           loc.SuffixText,
		})
	}
	return out, nil
}

// triBool decodes a tri-state byte (0=unset, 1=true, 2=false).
func triBool(b uint32) *bool {
	switch b {
	case 1:
		t := true
		return &t
	case 2:
		f := false
		return &f
	default:
		return nil
	}
}
