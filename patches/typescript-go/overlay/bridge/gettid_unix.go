//go:build !windows

package main

/*
#include <pthread.h>
#include <stdint.h>

static uint64_t tidSelf() { return (uint64_t)(uintptr_t)pthread_self(); }
*/
import "C"

// currentTid identifies the calling OS thread. Used by the session-affinity
// guard: pthread_self is unique per thread for the process lifetime.
func currentTid() uint64 { return uint64(C.tidSelf()) }
