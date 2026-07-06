package incremental

import (
	"slices"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
)

// BuilderFileGraphEntry describes one program file for an external builder
// state (the JS-side BuilderProgram the API bridge feeds): content-hash
// version, global-scope effect, implied module format, and the same
// referenced-file edges programToSnapshot stores in its referencedMap.
// Keeping this computation in the incremental package guarantees the external
// builder sees the exact invalidation graph tsgo's own --incremental uses.
type BuilderFileGraphEntry struct {
	File               *ast.SourceFile
	Version            string
	AffectsGlobalScope bool
	ImpliedNodeFormat  core.ResolutionMode
	ReferencedFiles    []string
}

// BuilderFileGraph serves the builder file graph from this Program's
// snapshot, whose construction (programToSnapshot) already ran the identical
// per-file hash + referenced-files walk. Callers that hold an incremental
// Program should prefer this over ComputeBuilderFileGraph — recomputing would
// double the whole-program walk (and its checker-alias import resolution) per
// build. Returns nil when the snapshot does not carry full per-file state
// (non-incremental build-mode snapshots skip it); fall back to
// ComputeBuilderFileGraph then.
func (p *Program) BuilderFileGraph() []BuilderFileGraphEntry {
	files := p.program.GetSourceFiles()
	if p.snapshot.fileInfos.Size() != len(files) {
		return nil
	}
	entries := make([]BuilderFileGraphEntry, len(files))
	for i, file := range files {
		info, ok := p.snapshot.fileInfos.Load(file.Path())
		if !ok {
			return nil
		}
		var refNames []string
		if refs, ok := p.snapshot.referencedMap.getReferences(file.Path()); ok && refs != nil {
			refNames = make([]string, 0, refs.Len())
			for refPath := range refs.Keys() {
				refNames = append(refNames, string(refPath))
			}
			// Deterministic order so serialized builder state round-trips
			// byte-identically across sessions.
			slices.Sort(refNames)
		}
		entries[i] = BuilderFileGraphEntry{
			File:               file,
			Version:            info.version,
			AffectsGlobalScope: info.affectsGlobalScope,
			ImpliedNodeFormat:  info.impliedNodeFormat,
			ReferencedFiles:    refNames,
		}
	}
	return entries
}

// ComputeBuilderFileGraph computes fileInfo metadata and referenced-file
// edges for every program file, in parallel. It performs no semantic pass:
// getReferencedFiles resolves import symbols at binder/alias level only, the
// same work programToSnapshot does when serializing buildinfo.
func ComputeBuilderFileGraph(program *compiler.Program) []BuilderFileGraphEntry {
	files := program.GetSourceFiles()
	entries := make([]BuilderFileGraphEntry, len(files))
	wg := core.NewWorkGroup(program.SingleThreaded())
	for i, file := range files {
		wg.Queue(func() {
			var refNames []string
			if refs := getReferencedFiles(program, file); refs != nil {
				refNames = make([]string, 0, refs.Len())
				for refPath := range refs.Keys() {
					refNames = append(refNames, string(refPath))
				}
				// Deterministic order so serialized builder state round-trips
				// byte-identically across sessions.
				slices.Sort(refNames)
			}
			entries[i] = BuilderFileGraphEntry{
				File:               file,
				Version:            ComputeHash(file.Text(), false),
				AffectsGlobalScope: fileAffectsGlobalScope(file),
				ImpliedNodeFormat:  program.GetSourceFileMetaData(file.Path()).ImpliedNodeFormat,
				ReferencedFiles:    refNames,
			}
		})
	}
	wg.RunAndWait()
	return entries
}
