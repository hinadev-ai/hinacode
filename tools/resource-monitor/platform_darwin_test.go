package main

import (
	"os"
	"testing"

	"github.com/shirou/gopsutil/v4/process"
)

func TestProcessMemoryIsPhysFootprint(t *testing.T) {
	p, err := process.NewProcessWithContext(t.Context(), int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	bytes, kind, err := processMemory(t.Context(), p)
	if err != nil {
		t.Fatal(err)
	}
	if kind != "phys_footprint" || bytes == 0 {
		t.Errorf("processMemory = %d %q, want a positive phys_footprint", bytes, kind)
	}
}
