// napi_shim.c — NAPI entry for the TNB cgo bridge (replaces the koffi FFI).
//
// Node loads bridge.node directly via require(); no FFI library needed.
//
// Must precede every system header: glibc only exposes Dl_info (dladdr, used
// by pin_module_in_process) under _GNU_SOURCE, and features.h freezes the
// choice at its first inclusion.
#define _GNU_SOURCE

// Marshalling contract (deliberately tiny — see the design discussion):
//   - Shapes: strings in, string-or-Buffer-or-bool-or-null out, int64 session
//     handle. Nothing else ever crosses the boundary.
//   - Inputs: method names are converted once and cached per env for the
//     env's lifetime (lever 4); params strings convert into a per-env
//     grow-once scratch buffer (the call is synchronous and Go copies before
//     return). Neither path allocates per call. Per-env, not process-static:
//     worker_threads hosts run several envs in one process, and unsynchronized
//     process globals are data races across threads.
//   - Text results: kind-tagged (0=JSON doc string, 1=null, 2/3=bool, 4=error
//     message — thrown). JSON docs live in a Go-owned per-session buffer
//     (sessionEntry.resultBuf in bridge.go), copied into V8 by
//     napi_create_string_utf8.
//     Null/bool results ride the tag so JS never parses a wrapper envelope.
//   - Binary results: Go pins the slice (runtime.Pinner — the cgo-legal way
//     to hand a Go pointer across) and the shim copies it into a V8-allocated
//     buffer — one memcpy, the irreducible sandbox crossing. The pin is
//     released synchronously right after the copy via BridgeReleaseBinary.
//     Zero-copy external buffers are off the table: V8's sandbox (always on
//     in Electron utility processes, e.g. VS Code's tsserver host) rejects
//     external buffers backed by non-sandbox memory, and a Go heap pointer is
//     never sandbox memory — napi_create_external_buffer fails and every
//     binary call silently returns undefined (session-wide
//     RemoteSourceFile/NodeHandle death).
//   - Everything synchronous on the JS thread. No async NAPI, no callbacks,
//     no thread-safe functions.

#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

// A Go c-shared library can never be unloaded: the Go runtime keeps OS
// threads and a process-wide vectored exception handler registered for the
// life of the process, so FreeLibrary/dlclose leaves both pointing into
// unmapped pages — the next fault dispatches into the unloaded handler and
// recurses to death (0xC0000005 at teardown). Node unloads an addon when its
// last owning env dies, which happens whenever the addon was only ever
// required from worker threads (ESLint --concurrency). Pin the module so
// that unload is a no-op.
static void pin_module_in_process(void) {
#ifdef _WIN32
	HMODULE self = NULL;
	GetModuleHandleExW(
		GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
		(LPCWSTR)(void*)&pin_module_in_process, &self);
#else
	Dl_info info;
	if (dladdr((void*)&pin_module_in_process, &info) && info.dli_fname) {
		dlopen(info.dli_fname, RTLD_NOW | RTLD_NODELETE);
	}
#endif
}

// cgo-exported Go entry points (bridge.go).
struct BridgeText { char* data; long long kind; };
struct BridgeBinary { void* data; long long len; unsigned long long handle; long long kind; };
extern char* BridgeSetLibPath(char* dir);
extern long long BridgeNewSession(char* cwd);
extern struct BridgeText BridgeCall(int64_t session, char* method, char* paramsJson);
extern struct BridgeBinary BridgeCallBinary(int64_t session, char* method, char* paramsJson);
extern void BridgeReleaseBinary(unsigned long long handle);
extern void BridgeDisposeSession(int64_t session);
extern char* BridgeSetArena(int64_t session, void* ptr, long long length);
extern char* BridgeCallArena(int64_t session, char* method);

// Per-env reusable scratch for params conversion. The bridge call is
// synchronous and Go copies the params (C.GoString) before returning, so one
// grow-on-demand buffer per env replaces a malloc/free pair per call.
#define SHIM_MAX_ARENAS 8
#define METHOD_CACHE_SIZE 256
struct ShimInstance {
	char* paramsBuf;
	size_t paramsBufLen;
	// Method-name C-string cache (issue #10 lever 4): RPC method names are a
	// small, slowly-changing set, so each distinct name is converted once and
	// kept for the env lifetime — repeat calls cost one utf8 read + a probe,
	// skipping the per-call malloc/free. Entries are never evicted, which
	// also keeps their pointers stable for the lifetime of the env.
	char* methodCache[METHOD_CACHE_SIZE];
	// Session arenas kept alive while Go holds their pointers (part 3).
	struct { int64_t session; napi_ref ref; } arenas[SHIM_MAX_ARENAS];
	int arenaCount;
	// Sessions this env created, tracked so finalize_instance can dispose any
	// that were never explicitly disposed (a worker that exits without
	// disposeSession must not leave its session registered in Go, or a later
	// call on the dead id silently fails the affinity guard instead of being
	// an unknown session). Grows on demand; freed in finalize_instance.
	int64_t* sessions;
	int sessionCount;
	int sessionCap;
};

// Arena-path error sentinel (mirrors bridge.go's arenaErrorPrefix): Go returns
// malloc'd strings with this prefix for missing/foreign sessions. A genuine
// JSON escape doc always starts with '{', so the prefix can never collide
// with a result; fn_call_arena/fn_set_arena strip it and throw.
#define TNB_ARENA_ERR "tnb-error:"

// throw_arena_error throws msg with the TNB_ARENA_ERR prefix stripped (the
// message body is what the JSON path's textError would have carried).
static void throw_arena_error(napi_env env, const char* msg) {
	if (strncmp(msg, TNB_ARENA_ERR, sizeof(TNB_ARENA_ERR) - 1) == 0) {
		msg += sizeof(TNB_ARENA_ERR) - 1;
	}
	napi_throw_error(env, NULL, msg);
}

static void finalize_instance(napi_env env, void* data, void* hint) {
	(void)hint;
	struct ShimInstance* i = (struct ShimInstance*)data;
	// Best-effort dispose of every session this env created: Go's
	// BridgeDisposeSession is idempotent (missing handle = no-op), so
	// double-disposing an already-disposed session is harmless.
	for (int k = 0; k < i->sessionCount; k++) BridgeDisposeSession(i->sessions[k]);
	free(i->sessions);
	for (int k = 0; k < i->arenaCount; k++) napi_delete_reference(env, i->arenas[k].ref);
	for (int k = 0; k < METHOD_CACHE_SIZE; k++) free(i->methodCache[k]);
	free(i->paramsBuf);
	free(i);
}

static struct ShimInstance* instance(napi_env env) {
	struct ShimInstance* i = NULL;
	napi_get_instance_data(env, (void**)&i);
	return i;
}

// Required string argument → fresh NUL-terminated buffer (caller frees).
// Returns NULL with nothing set if conversion fails (napi raises then).
static char* arg_string(napi_env env, napi_value v, bool* ok) {
	*ok = false;
	size_t len = 0;
	if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
	char* buf = (char*)malloc(len + 1);
	if (!buf) {
		napi_throw_error(env, NULL, "tnb bridge: out of memory");
		return NULL;
	}
	if (napi_get_value_string_utf8(env, v, buf, len + 1, NULL) != napi_ok) {
		free(buf);
		return NULL;
	}
	*ok = true;
	return buf;
}

#define METHOD_NAME_MAX 128

static unsigned method_hash(const char* s, size_t len) {
	unsigned h = 2166136261u;
	for (size_t i = 0; i < len; i++) { h ^= (unsigned char)s[i]; h *= 16777619u; }
	return h;
}

// Method argument → NUL-terminated string. *cached=true means cache-owned
// (never free); false means a per-call malloc the caller frees. NULL with
// nothing set on conversion failure (napi raises then).
static char* arg_method(napi_env env, napi_value v, bool* ok, bool* cached) {
	char buf[METHOD_NAME_MAX];
	size_t written = 0;
	*cached = false;
	*ok = false;
	// One read when the name fits (all real methods); fall back to the
	// two-read malloc path for anything longer.
	if (napi_get_value_string_utf8(env, v, buf, sizeof buf, &written) != napi_ok) return NULL;
	if (written >= sizeof buf) {
		// Longer than the cache read buffer: plain per-call conversion.
		return arg_string(env, v, ok);
	}
	char** methodCache = instance(env)->methodCache;
	unsigned h = method_hash(buf, written) % METHOD_CACHE_SIZE;
	for (unsigned i = 0; i < METHOD_CACHE_SIZE; i++) {
		unsigned slot = (h + i) % METHOD_CACHE_SIZE;
		char* entry = methodCache[slot];
		if (!entry) {
			char* copy = (char*)malloc(written + 1);
			if (!copy) {
				napi_throw_error(env, NULL, "tnb bridge: out of memory");
				return NULL;
			}
			memcpy(copy, buf, written + 1); // utf8 read NUL-terminates
			methodCache[slot] = copy;
			*cached = true;
			*ok = true;
			return copy;
		}
		if (memcmp(entry, buf, written + 1) == 0) {
			*cached = true;
			*ok = true;
			return entry;
		}
	}
	// Full table is only reachable with >256 distinct junk names — the caller
	// then pays the old per-call malloc for those.
	return arg_string(env, v, ok);
}

// Params argument → per-env scratch buffer (never freed by the caller;
// overwritten by the next call, which is fine because Go copies it during
// this call). NULL for null/undefined.
static char* arg_params(napi_env env, napi_value v, bool* ok) {
	napi_valuetype t = napi_undefined;
	if (napi_typeof(env, v, &t) != napi_ok) { *ok = false; return NULL; }
	if (t == napi_null || t == napi_undefined) { *ok = true; return NULL; }
	*ok = false;
	size_t len = 0;
	if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
	struct ShimInstance* i = instance(env);
	if (i->paramsBufLen < len + 1) {
		char* nb = (char*)realloc(i->paramsBuf, len + 1);
		if (!nb) {
			napi_throw_error(env, NULL, "tnb bridge: out of memory");
			return NULL;
		}
		i->paramsBuf = nb;
		i->paramsBufLen = len + 1;
	}
	if (napi_get_value_string_utf8(env, v, i->paramsBuf, len + 1, NULL) != napi_ok) return NULL;
	*ok = true;
	return i->paramsBuf;
}

// Session handle: accept Number or BigInt.
static int64_t arg_int64(napi_env env, napi_value v) {
	napi_valuetype t = napi_undefined;
	napi_typeof(env, v, &t);
	if (t == napi_bigint) {
		int64_t out = 0;
		bool lossless = false;
		napi_get_value_bigint_int64(env, v, &out, &lossless);
		return out;
	}
	double d = 0;
	napi_get_value_double(env, v, &d);
	return (int64_t)d;
}

static napi_value js_string(napi_env env, const char* s) {
	napi_value out = NULL;
	napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &out);
	return out;
}

// setLibPath(dir): undefined — hands the bundled-lib dir to Go before any
// session (issue #37: the only lib-path channel that works from worker
// threads). Go validates the dir and rejects conflicts; the error message
// comes back malloc'd and is freed after the throw.
static napi_value fn_set_lib_path(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	size_t argc = 1;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	bool ok;
	char* dir = arg_string(env, argv[0], &ok);
	if (!ok) return NULL;
	char* err = BridgeSetLibPath(dir);
	free(dir);
	if (err != NULL) {
		napi_throw_error(env, NULL, err);
		free(err);
		return NULL;
	}
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

// Session registry helpers: every session this env creates is recorded so
// finalize_instance can dispose the ones never explicitly disposed.
static void register_session(napi_env env, struct ShimInstance* i, int64_t session) {
	if (i->sessionCount == i->sessionCap) {
		int cap = i->sessionCap ? i->sessionCap * 2 : 8;
		int64_t* ns = (int64_t*)realloc(i->sessions, (size_t)cap * sizeof(int64_t));
		if (!ns) {
			napi_throw_error(env, NULL, "tnb bridge: out of memory");
			return;
		}
		i->sessions = ns;
		i->sessionCap = cap;
	}
	i->sessions[i->sessionCount++] = session;
}

static void unregister_session(struct ShimInstance* i, int64_t session) {
	for (int k = 0; k < i->sessionCount; k++) {
		if (i->sessions[k] == session) {
			i->sessions[k] = i->sessions[--i->sessionCount];
			return;
		}
	}
}

// newSession(cwd: string): number (session handle)
static napi_value fn_new_session(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	size_t argc = 1;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	bool ok;
	char* cwd = arg_string(env, argv[0], &ok);
	if (!ok) return NULL;
	long long handle = BridgeNewSession(cwd);
	free(cwd);
	register_session(env, instance(env), handle);
	napi_value out = NULL;
	napi_create_double(env, (double)handle, &out);
	return out;
}

// Shared argument extraction for call / callBinary.
// Returns false with any allocated memory already freed.
static bool call_args(napi_env env, napi_callback_info info, int64_t* session, char** method, bool* methodCached, char** params) {
	napi_value argv[3];
	size_t argc = 3;
	*method = NULL;
	*params = NULL;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	*session = arg_int64(env, argv[0]);
	bool ok;
	*method = arg_method(env, argv[1], &ok, methodCached);
	if (!ok) return false;
	*params = arg_params(env, argv[2], &ok);
	if (!ok) {
		if (!*methodCached) free(*method);
		*method = NULL;
		return false;
	}
	return true;
}

// call(session, method, paramsJson | null): string | boolean | null
// kind 0: JSON doc string (JS parses the payload itself); 1: null; 2/3: bool;
// 4: error message — thrown.
static napi_value fn_call(napi_env env, napi_callback_info info) {
	int64_t session;
	char* method;
	bool methodCached;
	char* params;
	if (!call_args(env, info, &session, &method, &methodCached, &params)) return NULL;
	struct BridgeText res = BridgeCall(session, method, params);
	if (!methodCached) free(method);
	switch (res.kind) {
	case 1: {
		napi_value nul;
		napi_get_null(env, &nul);
		return nul;
	}
	case 2:
	case 3: {
		napi_value b;
		napi_get_boolean(env, res.kind == 2, &b);
		return b;
	}
	case 4:
		napi_throw_error(env, NULL, res.data);
		return NULL;
	default:
		return js_string(env, res.data);
	}
}

// callBinary(session, method, paramsJson | null): Buffer | null
static napi_value fn_call_binary(napi_env env, napi_callback_info info) {
	int64_t session;
	char* method;
	bool methodCached;
	char* params;
	if (!call_args(env, info, &session, &method, &methodCached, &params)) return NULL;
	struct BridgeBinary res = BridgeCallBinary(session, method, params);
	if (!methodCached) free(method);
	if (res.kind == 4) {
		napi_throw_error(env, NULL, (const char*)res.data);
		return NULL;
	}
	if (res.len <= 0 || res.data == NULL) {
		napi_value nul;
		napi_get_null(env, &nul);
		return nul;
	}
	// V8-allocated buffer (sandbox-legal on every runtime) + one memcpy out of
	// the pinned Go slice — the single copy on the binary path. The pin is
	// released synchronously right after the copy: the slice never escapes to
	// a finalizer, so the release is deterministic and exactly-once.
	napi_value buf = NULL;
	void* out = NULL;
	if (napi_create_buffer(env, (size_t)res.len, &out, &buf) != napi_ok) {
		BridgeReleaseBinary(res.handle);
		return NULL;
	}
	memcpy(out, res.data, (size_t)res.len);
	BridgeReleaseBinary(res.handle);
	return buf;
}

// setArena(session, buffer): install the session's V8-allocated arena (part
// 3). The buffer is created JS-side (V8 memory — sandbox-legal); Go writes
// hot-path responses into it in place. The shim refs it so the pointer Go
// holds can never dangle, released with the session/env. A missing/foreign
// session is a loud error (BridgeSetArena's sentinel) — the registry is only
// touched after Go accepted the pointer, so a failed call never drops an
// existing entry while Go still points at the old buffer.
static napi_value fn_set_arena(napi_env env, napi_callback_info info) {
	napi_value argv[2];
	size_t argc = 2;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	bool isBuf = false;
	if (napi_is_buffer(env, argv[1], &isBuf) != napi_ok || !isBuf) {
		napi_throw_error(env, NULL, "tnb bridge: setArena expects a Buffer");
		return NULL;
	}
	void* data = NULL;
	size_t len = 0;
	if (napi_get_buffer_info(env, argv[1], &data, &len) != napi_ok) return NULL;
	int64_t session = arg_int64(env, argv[0]);
	struct ShimInstance* inst = instance(env);
	// Capacity first: a full table must fail before Go installs the pointer.
	if (inst->arenaCount >= SHIM_MAX_ARENAS) {
		napi_throw_error(env, NULL, "tnb bridge: too many arena sessions");
		return NULL;
	}
	// Install Go-side before mutating the registry: the buffer is rooted by
	// argv while this call runs, and a rejected session leaves every existing
	// registry entry (and Go's installed pointer) untouched and consistent.
	char* err = BridgeSetArena(session, data, (long long)len);
	if (err != NULL) {
		throw_arena_error(env, err);
		free(err);
		return NULL;
	}
	for (int k = 0; k < inst->arenaCount; k++) {
		if (inst->arenas[k].session == session) {
			napi_delete_reference(env, inst->arenas[k].ref);
			inst->arenas[k] = inst->arenas[--inst->arenaCount];
			break;
		}
	}
	napi_ref ref = NULL;
	if (napi_create_reference(env, argv[1], 1, &ref) != napi_ok) return NULL;
	inst->arenas[inst->arenaCount].session = session;
	inst->arenas[inst->arenaCount].ref = ref;
	inst->arenaCount++;
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

// callArena(session, method): one arena-capable hot query. The request record
// is read from the arena at offset 0; the response header is written back at
// the arena's response offset — the JS side decodes directly out of its own
// buffer (no copies either way). An oversize response escapes as the returned
// JSON string. A missing/foreign session returns a sentinel-prefixed error
// instead: it is thrown here, never surfaced to JS as a string (which the
// caller would decode as a stale arena response).
static napi_value fn_call_arena(napi_env env, napi_callback_info info) {
	napi_value argv[2];
	size_t argc = 2;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	int64_t session = arg_int64(env, argv[0]);
	bool ok, methodCached;
	char* method = arg_method(env, argv[1], &ok, &methodCached);
	if (!ok) return NULL;
	char* doc = BridgeCallArena(session, method);
	if (!methodCached) free(method);
	if (doc != NULL) {
		if (strncmp(doc, TNB_ARENA_ERR, sizeof(TNB_ARENA_ERR) - 1) == 0) {
			throw_arena_error(env, doc);
			free(doc);
			return NULL;
		}
		napi_value out = NULL;
		napi_create_string_utf8(env, doc, NAPI_AUTO_LENGTH, &out);
		free(doc);
		return out;
	}
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

// disposeSession(session): void
static napi_value fn_dispose_session(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	size_t argc = 1;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	int64_t session = arg_int64(env, argv[0]);
	// Release the session's arena ref with it — a pinned 4 MiB buffer per
	// disposed session is a heap leak on session-churning hosts.
	struct ShimInstance* inst = instance(env);
	for (int k = 0; k < inst->arenaCount; k++) {
		if (inst->arenas[k].session == session) {
			napi_delete_reference(env, inst->arenas[k].ref);
			inst->arenas[k] = inst->arenas[--inst->arenaCount];
			break;
		}
	}
	// Drop the registry entry so finalize_instance won't re-dispose (harmless
	// if it did — BridgeDisposeSession is idempotent — but keep it tidy).
	unregister_session(inst, session);
	BridgeDisposeSession(session);
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

static bool set_fn(napi_env env, napi_value exports, const char* name, napi_callback cb) {
	napi_value fn = NULL;
	if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) != napi_ok) return false;
	return napi_set_named_property(env, exports, name, fn) == napi_ok;
}

NAPI_MODULE_INIT() {
	pin_module_in_process();
	struct ShimInstance* inst = (struct ShimInstance*)calloc(1, sizeof(struct ShimInstance));
	if (!inst || napi_set_instance_data(env, inst, finalize_instance, NULL) != napi_ok) {
		napi_throw_error(env, NULL, "tnb bridge: out of memory");
		return NULL;
	}
	set_fn(env, exports, "setLibPath", fn_set_lib_path);
	set_fn(env, exports, "newSession", fn_new_session);
	set_fn(env, exports, "call", fn_call);
	set_fn(env, exports, "callBinary", fn_call_binary);
	set_fn(env, exports, "setArena", fn_set_arena);
	set_fn(env, exports, "callArena", fn_call_arena);
	set_fn(env, exports, "disposeSession", fn_dispose_session);
	return exports;
}
