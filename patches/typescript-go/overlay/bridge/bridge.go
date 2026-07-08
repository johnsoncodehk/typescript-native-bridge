// Package main is a Proof-of-Concept NAPI/FFI bridge for typescript-go.
//
// It builds as a C-shared library (`go build -buildmode=c-shared`) and exposes
// a tiny C ABI that Node.js can load via an FFI library (koffi). The bridge
// reuses the exact same api.Session / project.Session machinery that the IPC
// stdio server uses — every type/symbol/source-file query goes through
// Session.HandleRequest, so there is zero handler duplication. The only thing
// we remove is the IPC transport: calls are direct in-process function calls.
//
// Two call paths:
//   - BridgeCall        -> JSON envelope string  {"ok":true,"data":...} | {"ok":false,"error":"..."}
//   - BridgeCallBinary  -> raw bytes (for getSourceFile etc.), single-copy into a Node Buffer
//
// Memory model: both paths write into reusable C buffers. Calls are fully
// synchronous, so koffi copies the data out at the FFI boundary before the
// next call reuses the buffer. Zero per-call malloc, zero leaks.
package main

/*
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// BridgeBinary is returned by value from BridgeCallBinary. Layout must match
// the koffi struct declared on the JS side: { void* data; int64_t len; }.
struct BridgeBinary { void* data; long long len; };
*/
import "C"

import (
	"context"
	"encoding/base64"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
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

	// resultBuf is a single reusable C buffer for JSON envelope responses.
	resultBuf    *C.char
	resultBufLen C.size_t

	// binBuf is a single reusable C buffer for binary responses (getSourceFile).
	// Grows only; never freed (one buffer for the process lifetime).
	binBuf    unsafe.Pointer
	binBufLen C.size_t
)

type sessionEntry struct {
	api *api.Session
}

// envelope is the wire format returned to JS.
type envelope struct {
	OK    bool       `json:"ok"`
	// No omitempty: v2 (go-json-experiment) treats a jsontext.Value that
	// marshals to `[]` or `null` as "empty" and drops the field, which makes
	// empty-array results (e.g. getSignaturesOfType with no signatures)
	// vanish from the envelope — the JS side then reads `data` as null and
	// crashes on `.map`. Always emit `data` (null when absent).
	Data  json.Value `json:"data"`
	Error string     `json:"error,omitempty"`
}

// returnEnvelope marshals env and writes it into the reusable result buffer,
// returning a pointer to that buffer. The pointer remains valid until the next
// bridge call. Always non-NULL.
func returnEnvelope(env envelope) *C.char {
	b, err := json.Marshal(env)
	if err != nil {
		b = []byte(`{"ok":false,"error":"marshal envelope failed"}`)
	}
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
	return resultBuf
}

// ensureBinBuf grows the reusable binary buffer to at least need bytes.
func ensureBinBuf(need C.size_t) {
	if binBuf == nil || binBufLen < need {
		if binBuf != nil {
			C.free(binBuf)
		}
		binBuf = C.malloc(need)
		binBufLen = need
	}
}

// bridgeCheckerPoolOptions returns checker pool sizing for the in-process bridge.
// Default MaxCheckers=5 (1 diagnostics + 4 query) aligns with tsgo CLI parallelism.
// Override with TSGO_CHECKERS (minimum 2).
func bridgeCheckerPoolOptions() project.CheckerPoolOptions {
	opts := project.CheckerPoolOptions{MaxCheckers: 5}
	if v := os.Getenv("TSGO_CHECKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 2 {
			opts.MaxCheckers = n
		}
	}
	return opts
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
// Kill switch: TNB_PIN_PARSE_CACHE=0.
func pinnedParseCacheKey(key project.ParseCacheKey) bool {
	return tspath.IsDeclarationFileName(key.FileName) &&
		(strings.Contains(key.FileName, "/node_modules/") || strings.HasPrefix(key.FileName, "bundled://"))
}

var watchdogOnce sync.Once

// startOrphanWatchdog kills this process if its parent dies. This is the only
// mechanism that works when the Node main thread is blocked inside a
// synchronous FFI call: JS timers and the tinypool IPC-disconnect handler all
// need the event loop, but this goroutine runs on its own Go thread.
//
// Default-on only inside test runners (VITEST / JEST set these envs in
// workers). Other embedders opt in with TNB_PPID_WATCHDOG=1; opt out with =0.
func startOrphanWatchdog() {
	watchdogOnce.Do(func() {
		v := os.Getenv("TNB_PPID_WATCHDOG")
		if v == "0" {
			return
		}
		if v != "1" && os.Getenv("VITEST") == "" && os.Getenv("JEST_WORKER_ID") == "" {
			return
		}
		if os.Getppid() <= 1 {
			return // already reparented at startup; don't arm
		}
		go func() {
			for {
				time.Sleep(2 * time.Second)
				if os.Getppid() == 1 {
					// Parent died. SIGKILL ourselves: skips Node's atexit
					// (ResetStdio) entirely, so the storm can never re-arm,
					// and the OS reclaims all session memory.
					_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
				}
			}
		}()
	})
}

// BridgeNewSession creates a project session + api session rooted at cwd.
// Returns a JSON envelope. On success, env.data is the session handle (number).
//
//export BridgeNewSession
func BridgeNewSession(cwd *C.char) *C.char {
	startOrphanWatchdog()

	cwdStr := C.GoString(cwd)

	fs := bundled.WrapFS(osvfs.FS())

	var parseCache *project.ParseCache
	if os.Getenv("TNB_PIN_PARSE_CACHE") != "0" {
		parseCache = project.NewParseCache(project.RefCountCacheOptions{})
		parseCache.SetPin(pinnedParseCacheKey)
	}

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

	handleBytes, _ := json.Marshal(id)
	return returnEnvelope(envelope{OK: true, Data: json.Value(handleBytes)})
}

// BridgeCall invokes api.Session.HandleRequest(method, params) directly.
// paramsJson may be NULL (treated as "null"). Returns a JSON envelope.
// On success, env.data is the handler's JSON result.
//
// If the handler returns api.RawBinary (only getSourceFile/echo with
// UseBinaryResponses=true), this path base64-encodes it as a safety net —
// callers should use BridgeCallBinary for those methods instead.
//
//export BridgeCall
func BridgeCall(session C.int64_t, method *C.char, paramsJson *C.char) *C.char {
	mu.Lock()
	entry, ok := sessions[int64(session)]
	mu.Unlock()
	if !ok {
		return returnEnvelope(envelope{OK: false, Error: "invalid session handle"})
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
		return returnEnvelope(envelope{OK: false, Error: err.Error()})
	}

	var dataBytes []byte
	switch r := res.(type) {
	case nil:
		dataBytes = []byte("null")
	case api.RawBinary:
		// Safety net: callers should route binary methods through
		// BridgeCallBinary. If they land here, return base64 so the envelope
		// stays valid JSON.
		if r == nil {
			dataBytes = []byte("null")
		} else {
			dataBytes = []byte(`"` + base64.StdEncoding.EncodeToString([]byte(r)) + `"`)
		}
	default:
		dataBytes, err = json.Marshal(res)
		if err != nil {
			return returnEnvelope(envelope{OK: false, Error: "marshal result: " + err.Error()})
		}
	}

	return returnEnvelope(envelope{OK: true, Data: json.Value(dataBytes)})
}

// BridgeCallBinary invokes HandleRequest and returns the result as raw bytes.
// For getSourceFile (UseBinaryResponses=true), the handler returns
// api.RawBinary which is handed straight through with no base64. For non-binary
// methods, the JSON-marshaled bytes are returned (caller can JSON.parse).
//
// Returns a struct by value: { void* data; int64_t len }. data points into the
// reusable binary buffer and stays valid until the next bridge call. len is 0
// for nil/empty results.
//
//export BridgeCallBinary
func BridgeCallBinary(session C.int64_t, method *C.char, paramsJson *C.char) C.struct_BridgeBinary {
	empty := C.struct_BridgeBinary{data: nil, len: 0}

	mu.Lock()
	entry, ok := sessions[int64(session)]
	mu.Unlock()
	if !ok {
		return empty
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
		// No way to surface an error through the binary path without a side
		// channel; fall back to a JSON error envelope written into the binary
		// buffer so the caller can detect it by parsing. The contract is:
		// callers use BridgeCallBinary only for methods known to return binary.
		errEnv := envelope{OK: false, Error: err.Error()}
		b, _ := json.Marshal(errEnv)
		ensureBinBuf(C.size_t(len(b)))
		C.memcpy(binBuf, unsafe.Pointer(&b[0]), C.size_t(len(b)))
		return C.struct_BridgeBinary{data: binBuf, len: C.longlong(len(b))}
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
			return empty
		}
	}

	if len(bytes) == 0 {
		return empty
	}
	ensureBinBuf(C.size_t(len(bytes)))
	C.memcpy(binBuf, unsafe.Pointer(&bytes[0]), C.size_t(len(bytes)))
	return C.struct_BridgeBinary{data: binBuf, len: C.longlong(len(bytes))}
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
