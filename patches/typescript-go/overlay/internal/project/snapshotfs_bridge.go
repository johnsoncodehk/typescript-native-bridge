package project

// TNB additions to package project, kept out of snapshotfs.go so its in-place patch
// carries only edits to upstream code.

import (
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
	"github.com/zeebo/xxh3"
)

// detectStaleDiskFiles returns cached disk files whose on-disk content
// changed since the cached read (mtime pre-filter, xxh3 hash confirm). A disk
// write that never surfaces as a host event — a plain fs write from a CLI
// tool or an editor outside the session — leaves no Changed entry behind, so
// without this probe the cached read and everything built on it (the
// auto-import registry above all) stays stale forever (volar #5847).
// node_modules and the bundled lib are skipped: both are stable on disk.
func (s *SnapshotFS) detectStaleDiskFiles(fs vfs.FS, memo map[tspath.Path]time.Time, bundledLibRoot string) []tspath.Path {
	var stale []tspath.Path
	for path, cached := range s.diskFiles {
		if cached == nil {
			continue
		}
		if strings.Contains(string(path), "/node_modules/") || strings.HasPrefix(string(path), bundledLibRoot) {
			continue
		}
		var mtime time.Time
		if info := fs.Stat(string(path)); info != nil {
			mtime = info.ModTime()
		}
		if prev, ok := memo[path]; ok && !mtime.After(prev) {
			continue
		}
		contents, ok := fs.ReadFile(string(path))
		if !ok {
			// Vanished from disk: feed it into Changed so consumers re-resolve
			// (the change feed has no Deleted path for this probe).
			stale = append(stale, path)
			memo[path] = mtime
			continue
		}
		if xxh3.HashString128(contents) != cached.hash {
			stale = append(stale, path)
		}
		memo[path] = mtime
	}
	return stale
}
