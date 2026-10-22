package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shirou/gopsutil/v4/process"
)

const maxCommandBytes = 512

// Scanner selects the processes that belong to one HinaCode run: the root's descendants, any process it has
// seen as a descendant before, and any process tagged with HINACODE_INSTANCE=<instance>.
type Scanner struct {
	root identity
	tag  string
	self int32
	// The environment the OS reports is fixed at exec. A process can only exec into the tag if it holds the tag
	// outside that environment, which only the root does, and the root's children are descendants. So one read
	// holds for the life of a process.
	tagged map[identity]bool
	// Descendants seen in an earlier scan stay tracked after they are reparented away. macOS hides the
	// environment of Apple's restricted binaries, such as /bin/sleep, so the tag alone misses them.
	known map[identity]bool
}

func NewScanner(ctx context.Context, root int32, instance string, self int32) (*Scanner, error) {
	// Without the cache gopsutil rereads /proc/stat for the boot time on every process.
	process.EnableBootTimeCache(true)
	p, err := process.NewProcessWithContext(ctx, root)
	if err != nil {
		return nil, fmt.Errorf("find root process %d: %w", root, err)
	}
	startedAt, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("read start time of root process %d: %w", root, err)
	}
	return &Scanner{
		root:   identity{pid: root, startedAt: startedAt},
		tag:    "HINACODE_INSTANCE=" + instance,
		self:   self,
		tagged: make(map[identity]bool),
		known:  make(map[identity]bool),
	}, nil
}

// Scan lists every process on the machine and returns a sample of the tracked ones, and whether the root still runs.
func (s *Scanner) Scan(ctx context.Context) (Sample, bool, error) {
	now := time.Now()
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return Sample{}, false, fmt.Errorf("list processes: %w", err)
	}

	rows := make([]procRow, 0, len(procs))
	byPID := make(map[int32]*process.Process, len(procs))
	for _, p := range procs {
		startedAt, err := p.CreateTimeWithContext(ctx)
		if err != nil {
			continue
		}
		ppid, err := p.PpidWithContext(ctx)
		if err != nil {
			continue
		}
		rows = append(rows, procRow{pid: p.Pid, ppid: ppid, startedAt: startedAt})
		byPID[p.Pid] = p
	}

	alive := s.rootAlive(ctx, rows, byPID)
	var tree map[int32]bool
	if alive {
		tree = descendants(rows, s.root, s.self)
	}

	sample := Sample{At: now.UTC().Truncate(time.Millisecond), Root: s.root.pid, Processes: []Process{}}
	seen := make(map[identity]bool, len(rows))
	kinds := make(map[string]int)
	for _, r := range rows {
		id := identity{pid: r.pid, startedAt: r.startedAt}
		seen[id] = true
		if r.pid == s.self || (!alive && id == s.root) {
			continue
		}
		p := byPID[r.pid]
		attached := tree[r.pid]
		if attached {
			s.known[id] = true
		}
		if !attached && !s.known[id] && !s.isTagged(ctx, p, id) {
			continue
		}
		// An exited process stays listed until its parent reaps it, and it still answers memory reads.
		if isZombie(ctx, p) {
			continue
		}
		proc, kind, err := s.describe(ctx, p, r, attached)
		if err != nil {
			continue
		}
		sample.Processes = append(sample.Processes, proc)
		kinds[kind]++
	}
	sample.Memory = dominantKind(kinds)

	for id := range s.tagged {
		if !seen[id] {
			delete(s.tagged, id)
		}
	}
	for id := range s.known {
		if !seen[id] {
			delete(s.known, id)
		}
	}
	return sample, alive, nil
}

func (s *Scanner) rootAlive(ctx context.Context, rows []procRow, byPID map[int32]*process.Process) bool {
	i := slices.IndexFunc(rows, func(r procRow) bool { return r.pid == s.root.pid })
	if i < 0 || rows[i].startedAt != s.root.startedAt {
		return false
	}
	return !isZombie(ctx, byPID[s.root.pid])
}

func (s *Scanner) isTagged(ctx context.Context, p *process.Process, id identity) bool {
	if tagged, ok := s.tagged[id]; ok {
		return tagged
	}
	env, err := p.EnvironWithContext(ctx)
	if err != nil {
		return false
	}
	s.tagged[id] = slices.Contains(env, s.tag)
	return s.tagged[id]
}

func (s *Scanner) describe(ctx context.Context, p *process.Process, r procRow, attached bool) (Process, string, error) {
	times, err := p.TimesWithContext(ctx)
	if err != nil {
		return Process{}, "", fmt.Errorf("read cpu times of %d: %w", r.pid, err)
	}
	memory, kind, err := processMemory(ctx, p)
	if err != nil {
		return Process{}, "", err
	}
	name, _ := p.NameWithContext(ctx)
	command, _ := p.CmdlineWithContext(ctx)
	role := chromiumRole(command)
	if (identity{pid: r.pid, startedAt: r.startedAt}) == s.root {
		role = "main"
	}
	return Process{
		PID:         r.pid,
		PPID:        r.ppid,
		StartedAt:   r.startedAt,
		Name:        name,
		Role:        role,
		Command:     truncate(command, maxCommandBytes),
		Attached:    attached,
		CPUSeconds:  times.User + times.System,
		MemoryBytes: memory,
	}, kind, nil
}

// chromiumRole reads the --type= switch that Chromium passes to its helper processes. It scans the joined
// command line because Chromium on Linux rewrites its argv into a single string.
func chromiumRole(command string) string {
	for _, field := range strings.Fields(command) {
		if role, ok := strings.CutPrefix(field, "--type="); ok {
			return role
		}
	}
	return ""
}

func dominantKind(kinds map[string]int) string {
	best := defaultMemoryKind
	for kind, n := range kinds {
		if n > kinds[best] {
			best = kind
		}
	}
	return best
}

// truncate cuts s to at most n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
