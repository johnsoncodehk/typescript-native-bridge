// Package main is the NAPI bridge for typescript-go.
//
// It builds as a NAPI addon (`go build -buildmode=c-shared` → bridge.node,
// see napi_shim.c) that Node.js loads directly via require(). The bridge
// reuses the exact same api.Session / project.Session machinery that the IPC
// stdio server uses — every type/symbol/source-file query goes through
// Session.HandleRequest, so there is zero handler duplication. The only thing
// we remove is the IPC transport: calls are direct in-process function calls.
//
// Two call paths, both envelope-free:
//   - BridgeCall        -> { kind, data }: null/bool results ride the kind
//     tag, JSON payloads cross as raw doc strings (JS parses the payload,
//     never a wrapper), errors are thrown by the shim as napi exceptions
//   - BridgeCallBinary  -> raw bytes (for getSourceFile etc.), zero-copy into a Node Buffer
//
// Memory model: text results reuse a process-lifetime C buffer (the NAPI
// shim copies to V8 synchronously before the next call). Binary responses are
// pinned Go slices (runtime.Pinner) handed to V8 as external buffers with
// zero copies — the pin is released by BridgeReleaseBinary from the external
// buffer's finalizer on GC.
package main

/*
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// BridgeText is returned by value from BridgeCall, BridgeBinary from
// BridgeCallBinary. Layouts match napi_shim.c's declarations. For text, kind
// is 0=JSON doc, 1=null, 2=true, 3=false, 4=error (data is the message). For
// binary, kind is 0=ok or 4=error; data is a view into the pinned Go slice
// and handle releases the pin via BridgeReleaseBinary.
struct BridgeText { char* data; long long kind; };
struct BridgeBinary { void* data; long long len; unsigned long long handle; long long kind; };
*/
import "C"

import (
	"context"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/microsoft/typescript-go/internal/api"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/json"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/project"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs/osvfs"
)

var (
	mu       sync.Mutex
	nextID   int64
	sessions = make(map[int64]*sessionEntry, 4)

	// resultBuf is a single reusable C buffer for text responses (JSON docs
	// and error messages).
	resultBuf    *C.char
	resultBufLen C.size_t
)

type sessionEntry struct {
	api *api.Session
}

// Wire kinds shared with napi_shim.c: null/bool results ride the tag so JS
// never parses a wrapper; textDoc carries the raw result JSON; textError
// carries the message the shim throws as a napi exception.
const (
	textDoc C.longlong = iota
	textNull
	textTrue
	textFalse
	textError
)

// returnText writes b into the reusable result buffer, returning a pointer to
// that buffer with the given kind. The pointer remains valid until the next
// bridge call.
func returnText(b []byte, kind C.longlong) C.struct_BridgeText {
	need := C.size_t(len(b) + 1)
	if resultBuf == nil || resultBufLen < need {
		if resultBuf != nil {
			C.free(unsafe.Pointer(resultBuf))
		}
		resultBuf = (*C.char)(C.malloc(need))
		resultBufLen = need
	}
	if len(b) > 0 {
		C.memcpy(unsafe.Pointer(resultBuf), unsafe.Pointer(&b[0]), C.size_t(len(b)))
	}
	(*[1 << 30]byte)(unsafe.Pointer(resultBuf))[len(b)] = 0
	return C.struct_BridgeText{data: resultBuf, kind: kind}
}

// bridgeCheckerPoolOptions returns checker pool sizing for the in-process bridge.
// MaxCheckers=5 (1 diagnostics + 4 query) aligns with tsgo CLI parallelism.
func bridgeCheckerPoolOptions() project.CheckerPoolOptions {
	return project.CheckerPoolOptions{MaxCheckers: 5}
}

// pinnedParseCacheKey reports whether a parse-cache entry should be pinned for
// the process lifetime: disk-stable declaration files (node_modules and the
// bundled lib.d.ts set). During a solution build (tsc -b), consecutive projects
// share most of these; without pinning, closing project N derefs its files and
// any file that project N+1 doesn't reference is evicted — then re-parsed and
// re-bound when project N+2 wants it. Correctness is unaffected: the cache key
// includes the content hash, so changed files miss and re-parse under a new
// key. Cost is memory, bounded by the union of node_modules/lib declaration
// files seen by the session (what a tsslint-style process-global cache holds).
func pinnedParseCacheKey(key project.ParseCacheKey) bool {
	return tspath.IsDeclarationFileName(key.FileName) &&
		(strings.Contains(key.FileName, "/node_modules/") || strings.HasPrefix(key.FileName, "bundled://"))
}

var watchdogOnce sync.Once

// startOrphanWatchdog kills this process if its parent dies. This is the only
// mechanism that works when the Node main thread is blocked inside a
// synchronous NAPI call: JS timers and the tinypool IPC-disconnect handler all
// need the event loop, but this goroutine runs on its own Go thread.
func startOrphanWatchdog() {
	watchdogOnce.Do(func() {
		if os.Getppid() <= 1 {
			return // already reparented at startup; don't arm
		}
		go func() {
			for {
				time.Sleep(2 * time.Second)
				if os.Getppid() == 1 {
					// Parent died. Hard-kill ourselves: skips Node's atexit
					// (ResetStdio) entirely, so the storm can never re-arm,
					// and the OS reclaims all session memory. killSelf is
					// platform-split (syscall.Kill is Unix-only).
					killSelf()
				}
			}
		}()
	})
}

// BridgeNewSession creates a project session + api session rooted at cwd.
// Returns the session handle.
//
//export BridgeNewSession
func BridgeNewSession(cwd *C.char) C.int64_t {
	startOrphanWatchdog()

	cwdStr := C.GoString(cwd)

	fs := bundled.WrapFS(osvfs.FS())

	parseCache := project.NewParseCache(project.RefCountCacheOptions{})
	parseCache.SetPin(pinnedParseCacheKey)

	ps := project.NewSession(&project.SessionInit{
		BackgroundCtx: context.Background(),
		FS:            fs,
		ParseCache:    parseCache,
		Options: &project.SessionOptions{
			CurrentDirectory:   cwdStr,
			DefaultLibraryPath: bundled.LibPath(),
			PositionEncoding:   lsproto.PositionEncodingKindUTF8,
			CheckerPoolOptions: bridgeCheckerPoolOptions(),
		},
	})

	// UseBinaryResponses=true makes getSourceFile/echo return api.RawBinary
	// (raw bytes) instead of a base64 JSON object, so BridgeCallBinary can
	// hand the bytes straight to JS with no base64 round-trip. Other handlers
	// are unaffected by this flag.
	as := api.NewSession(ps, &api.SessionOptions{
		UseBinaryResponses: true,
	})

	mu.Lock()
	nextID++
	id := nextID
	sessions[id] = &sessionEntry{api: as}
	mu.Unlock()

	return C.int64_t(id)
}

// BridgeCall invokes api.Session.HandleRequest(method, params) directly.
// paramsJson may be NULL (treated as "null"). On success, data is the handler's
// raw JSON result; null/bool results ride the kind tag instead so JS never
// parses a wrapper.
//
//export BridgeCall
func BridgeCall(session C.int64_t, method *C.char, paramsJson *C.char) C.struct_BridgeText {
	mu.Lock()
	entry, ok := sessions[int64(session)]
	mu.Unlock()
	if !ok {
		return returnText([]byte("invalid session handle"), textError)
	}

	methodStr := C.GoString(method)

	var params json.Value
	if paramsJson != nil {
		params = json.Value(append([]byte(nil), C.GoString(paramsJson)...))
	} else {
		params = json.Value(append([]byte(nil), []byte("null")...))
	}

	res, err := entry.api.HandleRequest(context.Background(), methodStr, params)
	if err != nil {
		return returnText([]byte(err.Error()), textError)
	}
	if res == nil {
		return C.struct_BridgeText{kind: textNull}
	}

	dataBytes, err := json.Marshal(res)
	if err != nil {
		return returnText([]byte("marshal result: "+err.Error()), textError)
	}
	switch string(dataBytes) {
	case "null":
		return C.struct_BridgeText{kind: textNull}
	case "true":
		return C.struct_BridgeText{kind: textTrue}
	case "false":
		return C.struct_BridgeText{kind: textFalse}
	}
	return returnText(dataBytes, textDoc)
}

// BridgeCallBinary invokes HandleRequest and returns the result as raw bytes.
// For getSourceFile (UseBinaryResponses=true), the handler returns
// api.RawBinary which is handed straight through with no base64. For non-binary
// methods, the JSON-marshaled bytes are returned (caller can JSON.parse).
//
// Returns a struct by value: { void* data; int64_t len; uint64_t handle;
// int64_t kind }. kind 0 = ok: data points INTO the Go slice (no copy); the
// slice is pinned via runtime.Pinner so Go's (non-moving) GC keeps it valid.
// Ownership of the pin transfers to the caller (napi_shim.c), which wraps the
// view in a V8 external buffer and calls BridgeReleaseBinary exactly once,
// from the buffer's finalizer on GC. len is 0 for nil/empty results (handle
// is 0 then; nothing to release). kind 4 = error: data/len hold the message
// in resultBuf and the shim throws it.
//
//export BridgeCallBinary
func BridgeCallBinary(session C.int64_t, method *C.char, paramsJson *C.char) C.struct_BridgeBinary {
	empty := C.struct_BridgeBinary{data: nil, len: 0, handle: 0}

	mu.Lock()
	entry, ok := sessions[int64(session)]
	mu.Unlock()
	if !ok {
		return returnBinaryError("invalid session handle")
	}

	methodStr := C.GoString(method)

	var params json.Value
	if paramsJson != nil {
		params = json.Value(append([]byte(nil), C.GoString(paramsJson)...))
	} else {
		params = json.Value(append([]byte(nil), []byte("null")...))
	}

	res, err := entry.api.HandleRequest(context.Background(), methodStr, params)
	if err != nil {
		return returnBinaryError(err.Error())
	}

	var bytes []byte
	switch r := res.(type) {
	case nil:
		bytes = nil
	case api.RawBinary:
		bytes = []byte(r)
	default:
		bytes, err = json.Marshal(res)
		if err != nil {
			return returnBinaryError("marshal result: " + err.Error())
		}
	}

	if len(bytes) == 0 {
		return empty
	}
	return pinBinary(bytes)
}

// returnBinaryError reports msg on the binary path: the message rides the
// reusable text buffer and kind 4 tells the shim to throw it.
func returnBinaryError(msg string) C.struct_BridgeBinary {
	t := returnText([]byte(msg), textError)
	return C.struct_BridgeBinary{data: unsafe.Pointer(t.data), len: C.longlong(len(msg)), kind: textError}
}

// pinBinary pins b via runtime.Pinner (the cgo-legal way to return a Go heap
// pointer: cgo.Handle would keep the object alive but does NOT mark the
// pointer pinned, and the runtime's cgoCheckResult panics on it) and returns
// the view + a registry id for BridgeReleaseBinary.
var (
	binPinnerNext uint64
	binPinners    sync.Map // uint64 -> *runtime.Pinner
)

func pinBinary(b []byte) C.struct_BridgeBinary {
	p := &runtime.Pinner{}
	p.Pin(&b[0])
	id := atomic.AddUint64(&binPinnerNext, 1)
	binPinners.Store(id, p)
	return C.struct_BridgeBinary{
		data:   unsafe.Pointer(&b[0]),
		len:    C.longlong(len(b)),
		handle: C.uint64_t(id),
	}
}

// BridgeReleaseBinary releases a pin from pinBinary. Called exactly once per
// BridgeCallBinary result, from the V8 external buffer's finalizer when the
// zero-copy view is garbage collected.
//
//export BridgeReleaseBinary
func BridgeReleaseBinary(handle C.uint64_t) {
	if p, ok := binPinners.LoadAndDelete(uint64(handle)); ok {
		p.(*runtime.Pinner).Unpin()
	}
}

// BridgeDisposeSession closes the session and releases all refs.
//
//export BridgeDisposeSession
func BridgeDisposeSession(session C.int64_t) {
	mu.Lock()
	entry, ok := sessions[int64(session)]
	if ok {
		delete(sessions, int64(session))
	}
	mu.Unlock()
	if !ok {
		return
	}
	entry.api.Close()
}

func main() {}
