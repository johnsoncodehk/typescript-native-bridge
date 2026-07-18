//go:build windows

package main

import "os"

// killSelf hard-kills this process (TerminateProcess on Windows — syscall.Kill
// does not exist there). Same intent as the Unix SIGKILL path: skip atexit.
func killSelf() {
	if p, err := os.FindProcess(os.Getpid()); err == nil {
		_ = p.Kill()
	}
}
