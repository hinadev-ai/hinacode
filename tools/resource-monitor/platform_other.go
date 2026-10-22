//go:build !linux && !darwin

package main

import (
	"context"
	"fmt"

	"github.com/shirou/gopsutil/v4/process"
)

const defaultMemoryKind = "rss"

func processMemory(ctx context.Context, p *process.Process) (uint64, string, error) {
	info, err := p.MemoryInfoWithContext(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("read memory of %d: %w", p.Pid, err)
	}
	return info.RSS, "rss", nil
}

func isZombie(context.Context, *process.Process) bool {
	return false
}
