package api

import (
	"context"
	"fmt"

	"github.com/microsoft/typescript-go/internal/ls"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
)

type ResolveCompletionItemParams struct {
	Snapshot    SnapshotID                 `json:"snapshot"`
	Project     ProjectID                  `json:"project"`
	Data        lsproto.CompletionItemData `json:"data"`
	Preferences lsutil.UserPreferences     `json:"preferences"`
}

type ResolvedCompletionItemResponse struct {
	Detail      string               `json:"detail"`
	TextChanges []TextChangeResponse `json:"textChanges"`
}

type TextChangeResponse struct {
	Start   uint32 `json:"start"`
	Length  uint32 `json:"length"`
	NewText string `json:"newText"`
}

func (s *Session) handleResolveCompletionItem(ctx context.Context, params *ResolveCompletionItemParams) (*ResolvedCompletionItemResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	projectName := parseProjectHandle(params.Project)
	proj := sd.snapshot.ProjectCollection.GetProjectByPath(projectName)
	if proj == nil {
		return nil, fmt.Errorf("%w: project %s not found", ErrClientError, projectName)
	}
	langSvc := ls.NewLanguageService(proj.ID(), program, &completionsPrefsHost{Host: sd.snapshot, prefs: params.Preferences}, "")
	item, err := langSvc.ResolveCompletionItem(ctx, &lsproto.CompletionItem{Label: params.Data.Name}, &params.Data)
	if err != nil {
		return nil, err
	}
	response := &ResolvedCompletionItemResponse{TextChanges: []TextChangeResponse{}}
	if item.Detail != nil {
		response.Detail = *item.Detail
	}
	if item.AdditionalTextEdits != nil {
		sourceFile := program.GetSourceFile(params.Data.FileName)
		response.TextChanges = make([]TextChangeResponse, len(*item.AdditionalTextEdits))
		for i, edit := range *item.AdditionalTextEdits {
			start, length := lspRangeToSpan(sourceFile, edit.Range)
			response.TextChanges[i] = TextChangeResponse{Start: start, Length: length, NewText: edit.NewText}
		}
	}
	return response, nil
}
