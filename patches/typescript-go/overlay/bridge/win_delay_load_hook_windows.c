// win_delay_load_hook_windows.c — delay-load notify hook for node.exe.
//
// Windows resolves PE imports by module file name: a static import of
// node.exe binds only when the host process image is literally named
// node.exe. Renamed hosts that export the same NAPI surface — VS Code's
// Code.exe, electron.exe — would make the loader load node.exe off disk as
// a dependency, which fails (ERROR_BAD_EXE_FORMAT, issue #44). The addon
// therefore delay-loads node.exe (build-bridge.js passes --delayload) and
// this hook answers dliNotePreLoadLibrary with the running process image,
// so napi_* always resolve from the host that loaded us. Same mechanism as
// node-gyp's win_delay_load_hook.cc ("allows compiled addons to work when
// the host executable is renamed").

#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook(unsigned event, DelayLoadInfo* info) {
	if (event != dliNotePreLoadLibrary) return NULL;
	if (_stricmp(info->szDll, "node.exe") != 0) return NULL;
	// libnode.dll first: shared-library node builds export napi_* there.
	HMODULE m = GetModuleHandleA("libnode.dll");
	if (m == NULL) m = GetModuleHandleA(NULL);
	return (FARPROC)m;
}

PfnDliHook __pfnDliNotifyHook2 = load_exe_hook;
