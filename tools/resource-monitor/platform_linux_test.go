package main

import (
	"os"
	"testing"

	"github.com/shirou/gopsutil/v4/process"
)

func TestProcessMemoryIsPSS(t *testing.T) {
	p, err := process.NewProcessWithContext(t.Context(), int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	bytes, kind, err := processMemory(t.Context(), p)
	if err != nil {
		t.Fatal(err)
	}
	if kind != "pss" || bytes == 0 {
		t.Errorf("processMemory = %d %q, want a positive pss", bytes, kind)
	}
}
