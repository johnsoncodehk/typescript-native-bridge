package api

import (
	"context"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/core"
)

// FileDiagnosticsBatchEntry pairs one program file with its per-file
// syntactic and semantic diagnostics.
type FileDiagnosticsBatchEntry struct {
	FileName  string                `json:"fileName"`
	Syntactic []*DiagnosticResponse `json:"syntactic"`
	Semantic  []*DiagnosticResponse `json:"semantic"`
}

// handleGetDiagnosticsBatch returns syntactic + semantic diagnostics for every
// program file in one response. Build-mode builders (tsc -b / vue-tsc -b) ask
// for both kinds file-by-file — ~2 RPCs per file whose results are already
// memoized Go-side after the prefetched whole-program pass, so the cost was
// almost entirely per-call bridge overhead. Each entry is computed through the
// exact same code paths as handleGetSyntacticDiagnostics /
// handleGetSemanticDiagnostics to keep per-file parity byte-for-byte.
func (s *Session) handleGetDiagnosticsBatch(ctx context.Context, params *GetProjectDiagnosticsParams) ([]*FileDiagnosticsBatchEntry, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	syntacticCtx := core.WithCheckerLifetime(ctx, core.CheckerLifetimeDiagnostics)
	incrementalProgram := sd.getIncrementalProgram(program)

	files := program.GetSourceFiles()
	entries := make([]*FileDiagnosticsBatchEntry, 0, len(files))
	for _, file := range files {
		if file == nil {
			continue
		}
		syntactic := program.GetSyntacticDiagnostics(syntacticCtx, file)
		var semantic []*ast.Diagnostic
		if incrementalProgram != nil {
			semantic = incrementalProgram.GetSemanticDiagnostics(ctx, file)
		} else {
			semantic = program.GetSemanticDiagnostics(ctx, file)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		entries = append(entries, &FileDiagnosticsBatchEntry{
			FileName:  file.FileName(),
			Syntactic: NewDiagnosticResponses(syntactic),
			Semantic:  NewDiagnosticResponses(semantic),
		})
	}
	return entries, nil
}
