package project

// TNB additions to package project, kept out of session.go so its in-place patch
// carries only edits to upstream code.

import (
	"context"
	"fmt"

	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// OverlayContent returns the session's current overlay text for path —
// the base a delta push (openFilesWithContent edits) splices into.
func (s *Session) OverlayContent(path tspath.Path) (string, bool) {
	s.fs.mu.RLock()
	defer s.fs.mu.RUnlock()
	if o, ok := s.fs.overlays[path]; ok {
		return o.Content(), true
	}
	return "", false
}

func (s *Session) SetAPIExtraFileExtensions(extras []tsoptions.FileExtensionInfo) {
	s.apiExtraFileExtensions = extras
}

func (s *Session) APIExtraFileExtensions() []tsoptions.FileExtensionInfo {
	return s.apiExtraFileExtensions
}

// EnqueueOpenFiles adds open-file overlays to the pending changes queue
// WITHOUT flushing or building a snapshot. The caller (e.g. APIUpdate)
// is responsible for flushing. This enables batch-feeding host content
// for many files in one snapshot build instead of N individual DidOpenFile
// calls (each of which builds a snapshot).
func (s *Session) EnqueueOpenFiles(changes []FileChange) {
	if len(changes) == 0 {
		return
	}
	s.cancelScheduledSnapshotUpdate()
	s.pendingFileChangesMu.Lock()
	s.pendingFileChanges = append(s.pendingFileChanges, changes...)
	s.pendingFileChangesMu.Unlock()
}

// GetSnapshotWithAutoImports is the bridge-API variant of
// GetLanguageServiceWithAutoImports: it returns the prepared snapshot and the
// file's default project so the caller can wrap the snapshot host (e.g.
// per-request preferences) before constructing a LanguageService of its own.
func (s *Session) GetSnapshotWithAutoImports(ctx context.Context, baseSnapshot *Snapshot, uri lsproto.DocumentUri) (*Snapshot, *Project, error) {
	change := SnapshotChange{
		reason: UpdateReasonRequestedLanguageServiceWithAutoImports,
		ResourceRequest: ResourceRequest{
			Documents:   []lsproto.DocumentUri{uri},
			AutoImports: uri,
		},
	}
	newSnapshot := baseSnapshot.Clone(ctx, change, baseSnapshot.fs.overlays, s)

	project := newSnapshot.GetDefaultProject(uri)
	if project == nil {
		// Clone's initial ref (1) is released since we won't use this snapshot.
		newSnapshot.Deref(s)
		return nil, nil, fmt.Errorf("no project found for URI %s", uri)
	}

	// The caller derefs after its synchronous use; without this extra ref the
	// background adopt below could dispose the clone mid-use when the session
	// has already moved on (adopt owns the clone's initial ref).
	newSnapshot.tryRef()
	s.backgroundQueue.Enqueue(s.backgroundCtx, func(ctx context.Context) {
		s.adoptSnapshotChange(baseSnapshot, newSnapshot)
	})

	return newSnapshot, project, nil
}
