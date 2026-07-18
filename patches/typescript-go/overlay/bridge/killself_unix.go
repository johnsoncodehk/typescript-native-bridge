//go:build !windows

package main

import (
	"os"
	"syscall"
)

// killSelf hard-kills this process, skipping Node's atexit (ResetStdio).
func killSelf() {
	_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
}
