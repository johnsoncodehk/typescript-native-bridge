package api

// LS navigation payloads (TNB issue #12, batch 1): quickinfo / references /
// definitionAndBoundSpan computed Go-side (internal/ls) and returned as
// stock-services-shaped records, over both transports (JSON and V8-arena).
// Spans cross as UTF-16 offsets (tsserver/JS convention); the ls layer works in
// UTF-8 and is converted here per file position map.

import (
	"context"

	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/ls"
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
