//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"testing"

	"github.com/shirou/gopsutil/v4/process"
)

func TestIsZombie(t *testing.T) {
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Wait() })
	waitForZombie(t, int32(cmd.Process.Pid))

	self, err := process.NewProcessWithContext(t.Context(), int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	if isZombie(t.Context(), self) {
		t.Error("the running test process is reported as a zombie")
	}
}
