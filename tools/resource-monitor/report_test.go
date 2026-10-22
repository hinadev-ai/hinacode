package main

import (
	"math"
	"testing"
	"time"
)

func TestBuildReport(t *testing.T) {
	start := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	const step = 5 * time.Second
	const steps = 30 * 60 / 5
	var samples []Sample
	for i := range steps {
		at := start.Add(time.Duration(i) * step)
		hours := at.Sub(start).Hours()
		growing := uint64((200 + 100*hours) * mb)
		if i == steps/2 {
			growing += 800 * mb
		}
		procs := []Process{
			{PID: 10, StartedAt: 1, Name: "growing", Attached: true, MemoryBytes: growing, CPUSeconds: float64(i) * 0.5},
			{PID: 11, StartedAt: 1, Name: "flat", Attached: true, MemoryBytes: 300 * mb},
		}
		if at.Sub(start) < 5*time.Minute {
			procs = append(procs, Process{PID: 12, StartedAt: 1, Name: "brief", Attached: true, MemoryBytes: 50 * mb})
		}
		procs = append(procs, Process{PID: 13, StartedAt: 1, Name: "lingering", Attached: true, MemoryBytes: 10 * mb})
		if i < steps/2 {
			procs = append(procs, Process{PID: 14, StartedAt: 1, Name: "daemon", Attached: i != 3, MemoryBytes: 10 * mb})
		}
		samples = append(samples, Sample{At: at, Memory: "pss", Processes: procs})
	}
	samples = append(samples, Sample{
		At:        start.Add(steps * step),
		Memory:    "pss",
		Final:     true,
		Processes: []Process{{PID: 13, StartedAt: 1, Name: "lingering", MemoryBytes: 10 * mb}},
	})

	r := buildReport(samples, reportOptions{warmup: 2 * time.Minute, minSpan: 10 * time.Minute, growthLimit: 50})
	byName := make(map[string]ProcessSummary)
	for _, p := range r.Processes {
		byName[p.Name] = p
	}

	growing := byName["growing"]
	if !growing.Growing || math.Abs(growing.GrowthMBPerHour-100) > 10 {
		t.Errorf("growing: flagged=%v slope=%.1f MB/h, want flagged near 100", growing.Growing, growing.GrowthMBPerHour)
	}
	if math.Abs(growing.CPUPercent-10) > 0.1 {
		t.Errorf("growing: cpu=%.2f%%, want 10%%", growing.CPUPercent)
	}
	if flat := byName["flat"]; flat.Growing || !flat.HasGrowth {
		t.Errorf("flat: flagged=%v hasGrowth=%v, want a slope that is not flagged", flat.Growing, flat.HasGrowth)
	}
	if brief := byName["brief"]; brief.HasGrowth {
		t.Errorf("brief: got slope %.1f, want none for a process seen 5 minutes", brief.GrowthMBPerHour)
	}
	if !byName["lingering"].Outlived {
		t.Error("process in the final sample is not outlived")
	}
	for _, name := range []string{"growing", "flat", "brief", "daemon"} {
		if byName[name].Outlived {
			t.Errorf("%s is outlived, want not", name)
		}
	}
	if !r.HasFinal || len(r.Growing()) != 1 || len(r.Outlived()) != 1 {
		t.Errorf("hasFinal=%v growing=%d outlived=%d, want true 1 1", r.HasFinal, len(r.Growing()), len(r.Outlived()))
	}
}

func TestOutlivedWithoutFinalSample(t *testing.T) {
	start := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	samples := []Sample{
		{At: start, Processes: []Process{
			{PID: 1, StartedAt: 1, Name: "main", Attached: true},
			{PID: 2, StartedAt: 1, Name: "orphan", Attached: true},
		}},
		{At: start.Add(5 * time.Second), Processes: []Process{
			{PID: 1, StartedAt: 1, Name: "main", Attached: true},
			{PID: 2, StartedAt: 1, Name: "orphan", Attached: false},
		}},
	}

	r := buildReport(samples, reportOptions{warmup: 2 * time.Minute, minSpan: 10 * time.Minute, growthLimit: 50})
	outlived := r.Outlived()
	if r.HasFinal || len(outlived) != 1 || outlived[0].Name != "orphan" {
		t.Errorf("hasFinal=%v outlived=%v, want only the process detached in the last sample", r.HasFinal, outlived)
	}
}
