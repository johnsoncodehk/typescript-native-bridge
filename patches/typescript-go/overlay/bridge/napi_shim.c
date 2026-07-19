// napi_shim.c — NAPI entry for the TNB cgo bridge (replaces the koffi FFI).
//
// Node loads bridge.node directly via require(); no FFI library needed.
//
// Marshalling contract (deliberately tiny — see the design discussion):
//   - Shapes: strings in, string-or-Buffer-or-bool-or-null out, int64 session
//     handle. Nothing else ever crosses the boundary.
//   - Inputs: method names are converted once and cached for the process
//     lifetime (lever 4); params strings convert into a per-env grow-once
//     scratch buffer (the call is synchronous and Go copies before return).
//     Neither path allocates per call.
//   - Text results: kind-tagged (0=JSON doc string, 1=null, 2/3=bool, 4=error
//     message — thrown). JSON docs live in a Go-owned reusable buffer
//     (resultBuf in bridge.go), copied into V8 by napi_create_string_utf8.
//     Null/bool results ride the tag so JS never parses a wrapper envelope.
//   - Binary results: Go pins the slice via runtime.Pinner and hands V8 a
//     view — zero copies. The pin releases from the external buffer's
//     finalizer on GC. External buffers exist since Node 8 (our engine floor
//     is Node 20), so no copy fallback exists: a create failure is a bug.
//     Go's GC is non-moving, so the view stays valid until release.
//   - Everything synchronous on the JS thread. No async NAPI, no callbacks,
//     no thread-safe functions.

#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// cgo-exported Go entry points (bridge.go).
struct BridgeText { char* data; long long kind; };
struct BridgeBinary { void* data; long long len; unsigned long long handle; long long kind; };
extern long long BridgeNewSession(char* cwd);
extern struct BridgeText BridgeCall(int64_t session, char* method, char* paramsJson);
extern struct BridgeBinary BridgeCallBinary(int64_t session, char* method, char* paramsJson);
extern void BridgeDisposeSession(int64_t session);
extern void BridgeReleaseBinary(unsigned long long handle);

// Per-env reusable scratch for params conversion. The bridge call is
// synchronous and Go copies the params (C.GoString) before returning, so one
// grow-on-demand buffer per env replaces a malloc/free pair per call.
struct ShimInstance {
	char* paramsBuf;
	size_t paramsBufLen;
};

static void finalize_instance(napi_env env, void* data, void* hint) {
	(void)env;
	(void)hint;
	struct ShimInstance* i = (struct ShimInstance*)data;
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

// Method-name C-string cache (issue #10 lever 4): RPC method names are a
// small, slowly-changing set, so each distinct name is converted once and
// kept for the process lifetime — repeat calls cost one utf8 read + a probe,
// skipping the per-call malloc/free. Entries are never freed, which also
// keeps their pointers stable for the lifetime of the process.
#define METHOD_CACHE_SIZE 256
#define METHOD_NAME_MAX 128
static char* methodCache[METHOD_CACHE_SIZE];

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

// Zero-copy release: the external buffer's finalizer runs on the env thread
// (cgo callbacks are thread-safe) and unpins via BridgeReleaseBinary. The
// registry in bridge.go is LoadAndDelete-idempotent, so release is exactly
// once by construction. External buffers exist since Node 8 — every supported
// runtime has them, so a create failure is a bug, not a case to degrade.
static void finalize_release(napi_env env, void* data, void* hint) {
	(void)env;
	(void)data;
	BridgeReleaseBinary((unsigned long long)(uintptr_t)hint);
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
	napi_value buf = NULL;
	// On failure buf stays NULL, which propagates the pending napi
	// exception — no status ceremony needed.
	napi_create_external_buffer(env, (size_t)res.len, res.data, finalize_release, (void*)(uintptr_t)res.handle, &buf);
	return buf;
}

// disposeSession(session): void
static napi_value fn_dispose_session(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	size_t argc = 1;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	BridgeDisposeSession(arg_int64(env, argv[0]));
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

static bool set_fn(napi_env env, napi_value exports, const char* name, napi_callback cb) {
	napi_value fn = NULL;
	if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) != napi_ok) return false;
	return napi_set_named_property(env, exports, name, fn) == napi_ok;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
	struct ShimInstance* inst = (struct ShimInstance*)calloc(1, sizeof(struct ShimInstance));
	if (!inst || napi_set_instance_data(env, inst, finalize_instance, NULL) != napi_ok) {
		napi_throw_error(env, NULL, "tnb bridge: out of memory");
		return NULL;
	}
	set_fn(env, exports, "newSession", fn_new_session);
	set_fn(env, exports, "call", fn_call);
	set_fn(env, exports, "callBinary", fn_call_binary);
	set_fn(env, exports, "disposeSession", fn_dispose_session);
	return exports;
}
