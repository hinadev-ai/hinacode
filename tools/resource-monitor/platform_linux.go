package main

import (
	"context"
	"fmt"
	"slices"

	"github.com/shirou/gopsutil/v4/process"
)

const defaultMemoryKind = "pss"

// processMemory returns the process's proportional set size, which splits pages shared between Chromium and
// Node processes instead of counting them in each. It falls back to RSS when smaps_rollup is unreadable.
func processMemory(ctx context.Context, p *process.Process) (uint64, string, error) {
	maps, err := p.MemoryMapsWithContext(ctx, true)
	if err == nil && len(*maps) == 1 {
		return (*maps)[0].Pss * 1024, "pss", nil // gopsutil reports smaps fields in kB
	}
	info, err := p.MemoryInfoWithContext(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("read memory of %d: %w", p.Pid, err)
	}
	return info.RSS, "rss", nil
}

func isZombie(ctx context.Context, p *process.Process) bool {
	status, err := p.StatusWithContext(ctx)
	return err == nil && slices.Contains(status, process.Zombie)
}
