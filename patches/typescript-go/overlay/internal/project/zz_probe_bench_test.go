package project

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs/osvfs"
)

// Perf self-check for the disk-staleness probe: the per-snapshot cost is one
// Stat per cached disk file (mtime pre-filter; content reads only on mtime
// change). 1000 cached files should cost single-digit ms per snapshot.
func TestDiskStalenessProbeStatScanCost(t *testing.T) {
	if testing.Short() {
		t.Skip("perf probe")
	}
	dir := t.TempDir()
	n := 1000
	sfs := &SnapshotFS{
		diskFiles: make(map[tspath.Path]*diskFile, n),
	}
	for i := 0; i < n; i++ {
		name := filepath.Join(dir, fmt.Sprintf("f%04d.ts", i))
		content := fmt.Sprintf("export const v%d = %d;\n", i, i)
		if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		p := tspath.Path(name)
		sfs.diskFiles[p] = newDiskFile(name, content)
	}
	memo := make(map[tspath.Path]time.Time)
	fs := osvfs.FS()

	// First pass: full validation (re-read every file once).
	start := time.Now()
	stale := sfs.detectStaleDiskFiles(fs, memo, "/nonexistent-bundled-root")
	first := time.Since(start)
	if len(stale) != 0 {
		t.Fatalf("unexpected stale files: %d", len(stale))
	}

	// Steady state: pure mtime scan.
	const rounds = 20
	start = time.Now()
	for i := 0; i < rounds; i++ {
		stale = sfs.detectStaleDiskFiles(fs, memo, "/nonexistent-bundled-root")
	}
	steady := time.Since(start) / rounds
	if len(stale) != 0 {
		t.Fatalf("unexpected stale files on steady pass: %d", len(stale))
	}
	t.Logf("probe cost: first-pass(full validation)=%v, steady-state(mtime scan)=%v over %d files", first, steady, n)
}
