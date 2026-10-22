package main

import (
	"cmp"
	"fmt"
	"io"
	"slices"
	"strings"
	"text/tabwriter"
	"time"
)

const (
	mb = 1 << 20
	// Theil–Sen compares every pair of points, so cap the points to keep it fast on long runs.
	maxSlopePoints = 240
	largestCount   = 10
)

type Report struct {
	From      time.Time
	To        time.Time
	Samples   int
	Memory    []string
	HasFinal  bool
	Processes []ProcessSummary
}

type ProcessSummary struct {
	PID        int32
	StartedAt  int64
	Name       string
	Role       string
	Command    string
	FirstSeen  time.Time
	LastSeen   time.Time
	LastMemory uint64
	PeakMemory uint64
	CPUPercent float64
	// GrowthMBPerHour is meaningful only when HasGrowth is true.
	GrowthMBPerHour float64
	HasGrowth       bool
	// Outlived means detached from the root in the log's last sample: still running after the app quit when
	// that sample is final, or orphaned right now when the app still runs. A process that was orphaned for a
	// while and then exited is not a leak.
	Outlived bool
	Growing  bool
}

func (r Report) Outlived() []ProcessSummary {
	out := filter(r.Processes, func(p ProcessSummary) bool { return p.Outlived })
	slices.SortFunc(out, func(a, b ProcessSummary) int { return cmp.Compare(b.PeakMemory, a.PeakMemory) })
	return out
}

func (r Report) Growing() []ProcessSummary {
	out := filter(r.Processes, func(p ProcessSummary) bool { return p.Growing })
	slices.SortFunc(out, func(a, b ProcessSummary) int { return cmp.Compare(b.GrowthMBPerHour, a.GrowthMBPerHour) })
	return out
}

func (r Report) Largest() []ProcessSummary {
	out := slices.Clone(r.Processes)
	slices.SortFunc(out, func(a, b ProcessSummary) int { return cmp.Compare(b.PeakMemory, a.PeakMemory) })
	return out[:min(len(out), largestCount)]
}

type memoryPoint struct {
	at    time.Time
	bytes uint64
}

func buildReport(samples []Sample, opts reportOptions) Report {
	var r Report
	r.Samples = len(samples)
	if len(samples) == 0 {
		return r
	}
	r.From = samples[0].At
	r.To = samples[len(samples)-1].At

	byID := make(map[identity]*ProcessSummary)
	var order []identity
	points := make(map[identity][]memoryPoint)
	firstCPU := make(map[identity]float64)
	lastCPU := make(map[identity]float64)
	for _, s := range samples {
		if !slices.Contains(r.Memory, s.Memory) {
			r.Memory = append(r.Memory, s.Memory)
		}
		r.HasFinal = r.HasFinal || s.Final
		for _, p := range s.Processes {
			id := p.identity()
			sum, ok := byID[id]
			if !ok {
				sum = &ProcessSummary{PID: p.PID, StartedAt: p.StartedAt, FirstSeen: s.At}
				byID[id] = sum
				order = append(order, id)
				firstCPU[id] = p.CPUSeconds
			}
			sum.Name, sum.Role, sum.Command = p.Name, p.Role, p.Command
			sum.LastSeen = s.At
			sum.LastMemory = p.MemoryBytes
			sum.PeakMemory = max(sum.PeakMemory, p.MemoryBytes)
			lastCPU[id] = p.CPUSeconds
			points[id] = append(points[id], memoryPoint{at: s.At, bytes: p.MemoryBytes})
		}
	}

	for _, p := range samples[len(samples)-1].Processes {
		if !p.Attached {
			byID[p.identity()].Outlived = true
		}
	}

	for _, id := range order {
		sum := byID[id]
		if seen := sum.LastSeen.Sub(sum.FirstSeen).Seconds(); seen > 0 {
			sum.CPUPercent = (lastCPU[id] - firstCPU[id]) / seen * 100
		}
		sum.GrowthMBPerHour, sum.HasGrowth = growthMBPerHour(points[id], opts.warmup, opts.minSpan)
		sum.Growing = sum.HasGrowth && sum.GrowthMBPerHour > opts.growthLimit
		r.Processes = append(r.Processes, *sum)
	}
	return r
}

// growthMBPerHour fits a Theil–Sen slope, the median of all pairwise slopes, so a GC pause or a one-off
// spike does not move it. It skips the warmup after the process is first seen and reports no slope when
// the remaining points span less than minSpan.
func growthMBPerHour(points []memoryPoint, warmup, minSpan time.Duration) (float64, bool) {
	if len(points) == 0 {
		return 0, false
	}
	start := points[0].at.Add(warmup)
	i := slices.IndexFunc(points, func(p memoryPoint) bool { return !p.at.Before(start) })
	if i < 0 {
		return 0, false
	}
	points = points[i:]
	if points[len(points)-1].at.Sub(points[0].at) < minSpan {
		return 0, false
	}
	points = downsample(points, maxSlopePoints)

	var slopes []float64
	for i := range points {
		for j := i + 1; j < len(points); j++ {
			hours := points[j].at.Sub(points[i].at).Hours()
			if hours <= 0 {
				continue
			}
			slopes = append(slopes, (float64(points[j].bytes)-float64(points[i].bytes))/mb/hours)
		}
	}
	if len(slopes) == 0 {
		return 0, false
	}
	slices.Sort(slopes)
	mid := len(slopes) / 2
	if len(slopes)%2 == 1 {
		return slopes[mid], true
	}
	return (slopes[mid-1] + slopes[mid]) / 2, true
}

func downsample(points []memoryPoint, n int) []memoryPoint {
	if len(points) <= n {
		return points
	}
	out := make([]memoryPoint, n)
	for k := range n {
		out[k] = points[k*(len(points)-1)/(n-1)]
	}
	return out
}

func filter[T any](items []T, keep func(T) bool) []T {
	var out []T
	for _, item := range items {
		if keep(item) {
			out = append(out, item)
		}
	}
	return out
}

func writeReport(w io.Writer, path string, r Report) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "File\t%s\n", path)
	if r.Samples > 0 {
		fmt.Fprintf(tw, "Covered\t%s to %s (%s)\n",
			r.From.UTC().Format(time.RFC3339), r.To.UTC().Format(time.RFC3339), r.To.Sub(r.From).Round(time.Second))
	}
	fmt.Fprintf(tw, "Samples\t%d\n", r.Samples)
	fmt.Fprintf(tw, "Memory\t%s\n", strings.Join(r.Memory, ", "))
	if !r.HasFinal {
		fmt.Fprintf(tw, "Final\tnone: HinaCode is still running or the monitor stopped early\n")
	}

	outlived := r.Outlived()
	fmt.Fprintf(tw, "\nOutlived HinaCode (%d)\n", len(outlived))
	writeTable(tw, outlived, "PID\tNAME\tROLE\tLAST MB\tPEAK MB\tCOMMAND", func(p ProcessSummary) string {
		return fmt.Sprintf("%d\t%s\t%s\t%s\t%s\t%s",
			p.PID, p.Name, orDash(p.Role), formatMB(p.LastMemory), formatMB(p.PeakMemory), shortCommand(p.Command))
	})

	growing := r.Growing()
	fmt.Fprintf(tw, "\nGrowing (%d)\n", len(growing))
	writeTable(tw, growing, "PID\tNAME\tROLE\tMB/HOUR\tLAST MB\tCOMMAND", func(p ProcessSummary) string {
		return fmt.Sprintf("%d\t%s\t%s\t%+.1f\t%s\t%s",
			p.PID, p.Name, orDash(p.Role), p.GrowthMBPerHour, formatMB(p.LastMemory), shortCommand(p.Command))
	})

	fmt.Fprintf(tw, "\nLargest\n")
	writeTable(tw, r.Largest(), "PID\tNAME\tROLE\tPEAK MB\tLAST MB\tCPU %\tMB/HOUR\tCOMMAND", func(p ProcessSummary) string {
		growth := "-"
		if p.HasGrowth {
			growth = fmt.Sprintf("%+.1f", p.GrowthMBPerHour)
		}
		return fmt.Sprintf("%d\t%s\t%s\t%s\t%s\t%.1f\t%s\t%s",
			p.PID, p.Name, orDash(p.Role), formatMB(p.PeakMemory), formatMB(p.LastMemory), p.CPUPercent, growth,
			shortCommand(p.Command))
	})
	return tw.Flush()
}

func writeTable(w io.Writer, rows []ProcessSummary, header string, row func(ProcessSummary) string) {
	if len(rows) == 0 {
		fmt.Fprintln(w, "  none")
		return
	}
	fmt.Fprintf(w, "  %s\n", header)
	for _, p := range rows {
		fmt.Fprintf(w, "  %s\n", row(p))
	}
}

func formatMB(bytes uint64) string {
	return fmt.Sprintf("%.1f", float64(bytes)/mb)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func shortCommand(command string) string {
	if short := truncate(command, 80); short != command {
		return short + "..."
	}
	return command
}
