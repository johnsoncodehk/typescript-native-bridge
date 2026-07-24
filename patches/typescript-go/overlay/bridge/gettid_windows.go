//go:build windows

package main

/*
#include <windows.h>
*/
import "C"

// currentTid identifies the calling OS thread. Used by the session-affinity
// guard: GetCurrentThreadId is unique per thread for the process lifetime.
func currentTid() uint64 { return uint64(C.GetCurrentThreadId()) }
