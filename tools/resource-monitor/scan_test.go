package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

func TestScanTracksChildrenAndTaggedDaemons(t *testing.T) {
	instance := uniqueInstance()

	child := exec.Command("sleep", "60")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		child.Process.Kill()
		child.Wait()
	})
	tagged := startDaemon(t, envWithInstance(instance))
	untagged := startDaemon(t, envWithInstance(""))
	exited := exec.Command("true")
	if err := exited.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { exited.Wait() })
	waitForZombie(t, int32(exited.Process.Pid))

	scanner, err := NewScanner(t.Context(), int32(os.Getpid()), instance, -1)
	if err != nil {
		t.Fatal(err)
	}
	sample, alive, err := scanner.Scan(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !alive {
		t.Fatal("Scan reports the test process as gone")
	}

	if p, ok := findProcess(sample, int32(child.Process.Pid)); !ok || !p.Attached {
		t.Errorf("child: found=%v attached=%v, want tracked and attached", ok, p.Attached)
	}
	if p, ok := findProcess(sample, tagged); !ok || p.Attached {
		t.Errorf("tagged daemon: found=%v attached=%v, want tracked and detached", ok, p.Attached)
	}
	if _, ok := findProcess(sample, untagged); ok {
		t.Error("untagged daemon is tracked")
	}
	if _, ok := findProcess(sample, int32(exited.Process.Pid)); ok {
		t.Error("exited, unreaped child is tracked")
	}
	if p, ok := findProcess(sample, int32(os.Getpid())); !ok || p.Role != "main" {
		t.Errorf("root: found=%v role=%q, want tracked with role main", ok, p.Role)
	}
}

func waitForZombie(t *testing.T, pid int32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	p, err := process.NewProcessWithContext(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	for !isZombie(ctx, p) {
		if ctx.Err() != nil {
			t.Fatalf("process %d never became a zombie", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startDaemon starts a sleep through a shell that exits right away, so the sleep is reparented away from the test.
func startDaemon(t *testing.T, env []string) int32 {
	t.Helper()
	cmd := exec.Command("sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("parse daemon pid %q: %v", out, err)
	}
	t.Cleanup(func() { killPID(pid) })
	return int32(pid)
}

// envWithInstance returns this process's environment with HINACODE_INSTANCE replaced, or removed when
// instance is empty, since the tests may run inside HinaCode.
func envWithInstance(instance string) []string {
	env := slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "HINACODE_INSTANCE=") })
	if instance != "" {
		env = append(env, "HINACODE_INSTANCE="+instance)
	}
	return env
}

func uniqueInstance() string {
	return fmt.Sprintf("test-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func findProcess(s Sample, pid int32) (Process, bool) {
	i := slices.IndexFunc(s.Processes, func(p Process) bool { return p.PID == pid })
	if i < 0 {
		return Process{}, false
	}
	return s.Processes[i], true
}

func killPID(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}
