// napi_shim.c — NAPI entry for the TNB cgo bridge (replaces the koffi FFI).
//
// Node loads bridge.node directly via require(); no FFI library needed.
//
// Marshalling contract (deliberately tiny — see the design discussion):
//   - Shapes: strings in, string-or-Buffer out, int64 session handle. Nothing
//     else ever crosses the boundary (envelopes are JSON, parsed in JS).
//   - Inputs: JS strings are copied into shim-owned buffers (C.GoString copies
//     again on the Go side), freed before the shim returns.
//   - String results: Go-owned reusable buffer (resultBuf in bridge.go),
//     copied into V8 by napi_create_string_utf8. Nothing to free — Go keeps
//     ownership and recycles it on the next call.
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

// cgo-exported Go entry points (bridge.go).
struct BridgeBinary { void* data; long long len; unsigned long long handle; };
extern char* BridgeNewSession(char* cwd);
extern char* BridgeCall(int64_t session, char* method, char* paramsJson);
extern struct BridgeBinary BridgeCallBinary(int64_t session, char* method, char* paramsJson);
extern void BridgeDisposeSession(int64_t session);
extern void BridgeReleaseBinary(unsigned long long handle);

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

// Optional string argument: NULL for null/undefined.
static char* arg_string_opt(napi_env env, napi_value v, bool* ok) {
	napi_valuetype t = napi_undefined;
	if (napi_typeof(env, v, &t) != napi_ok) { *ok = false; return NULL; }
	if (t == napi_null || t == napi_undefined) { *ok = true; return NULL; }
	return arg_string(env, v, ok);
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

// newSession(cwd: string): string (JSON envelope with the session handle)
static napi_value fn_new_session(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	size_t argc = 1;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	bool ok;
	char* cwd = arg_string(env, argv[0], &ok);
	if (!ok) return NULL;
	char* out = BridgeNewSession(cwd);
	free(cwd);
	return js_string(env, out);
}

// Shared argument extraction for call / callBinary.
// Returns false with any allocated memory already freed.
static bool call_args(napi_env env, napi_callback_info info, int64_t* session, char** method, char** params) {
	napi_value argv[3];
	size_t argc = 3;
	*method = NULL;
	*params = NULL;
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	*session = arg_int64(env, argv[0]);
	bool ok;
	*method = arg_string(env, argv[1], &ok);
	if (!ok) return false;
	*params = arg_string_opt(env, argv[2], &ok);
	if (!ok) {
		free(*method);
		*method = NULL;
		return false;
	}
	return true;
}

// call(session, method, paramsJson | null): string (JSON envelope)
static napi_value fn_call(napi_env env, napi_callback_info info) {
	int64_t session;
	char* method;
	char* params;
	if (!call_args(env, info, &session, &method, &params)) return NULL;
	char* out = BridgeCall(session, method, params);
	free(method);
	free(params);
	return js_string(env, out);
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
	char* params;
	if (!call_args(env, info, &session, &method, &params)) return NULL;
	struct BridgeBinary res = BridgeCallBinary(session, method, params);
	free(method);
	free(params);
	if (res.len <= 0 || res.data == NULL) {
		napi_value nul;
		napi_get_null(env, &nul);
		return nul;
	}
	napi_value buf = NULL;
	// External buffers exist since Node 8/NAPIv1 — every supported runtime
	// (engines floor is Node 20) has them. A failure here is a real bug:
	// surface it via the pending napi exception instead of degrading.
	if (napi_create_external_buffer(env, (size_t)res.len, res.data, finalize_release, (void*)(uintptr_t)res.handle, &buf) != napi_ok) {
		return NULL;
	}
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
	set_fn(env, exports, "newSession", fn_new_session);
	set_fn(env, exports, "call", fn_call);
	set_fn(env, exports, "callBinary", fn_call_binary);
	set_fn(env, exports, "disposeSession", fn_dispose_session);
	return exports;
}
