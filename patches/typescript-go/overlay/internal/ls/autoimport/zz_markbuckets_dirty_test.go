package autoimport

import (
	"testing"

	"github.com/microsoft/typescript-go/internal/collections"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/project/dirty"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// Two project files changing in ONE update batch must both land their dirty
// marks (Ledger(tsgo-autoimport-markbuckets-dirty)). Pristine tsgo deletes a
// bucket from the markFilesDirty worklist as soon as it is no longer
// multiple-files-dirty — which is the case after the FIRST granular mark,
// before the second file's mark runs — so the second mark is eaten and its
// exports stay stale in the auto-import registry (map-order 50% flake, volar
// #5847). The fix keeps the bucket in the worklist until it actually goes
// multiple-dirty: the second file then sees a dirtyFile besides itself and
// flips the bucket to a full rebuild, covering both files.
func TestMarkBucketsDirtyTwoFileBatchBothLand(t *testing.T) {
	reg := &Registry{toPath: func(f string) tspath.Path { return tspath.Path(f) }}
	projects := dirty.NewMap[tspath.Path, *RegistryBucket](nil)
	projects.Add("/p", &RegistryBucket{Paths: map[tspath.Path]string{"/p/a.ts": "", "/p/b.ts": ""}})
	b := &registryBuilder{
		base:        reg,
		projects:    projects,
		nodeModules: dirty.NewMap[tspath.Path, *RegistryBucket](nil),
	}
	uri := func(f string) lsproto.DocumentUri { return lsproto.DocumentUri("file://" + f) }
	ch := RegistryChange{Changed: *collections.NewSetFromItems(uri("/p/a.ts"), uri("/p/b.ts"))}
	b.markBucketsDirty(ch, nil)

	entry, _ := projects.Get("/p")
	st := entry.Value().state
	if st.multipleFilesDirty == false {
		t.Fatalf("second file's dirty mark was eaten: only dirtyFile=%q recorded, want multipleFilesDirty=true", st.dirtyFile)
	}
}
