package main

import (
	"bufio"
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

// sleepEnv makes this test binary sleep instead of running tests. A daemon made from it has an environment
// macOS lets other processes read, unlike Apple's restricted binaries such as /bin/sleep.
const sleepEnv = "RESOURCE_MONITOR_TEST_SLEEP=1"

func TestMain(m *testing.M) {
	if slices.Contains(os.Environ(), sleepEnv) {
		time.Sleep(time.Minute)
		return
	}
	os.Exit(m.Run())
}

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

func TestScanKeepsReparentedDescendants(t *testing.T) {
	shell := exec.Command("sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!; read _ || true")
	shell.Env = envWithInstance("")
	stdin, err := shell.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := shell.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shell.Wait() })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("read daemon pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse daemon pid %q: %v", line, err)
	}
	t.Cleanup(func() { killPID(pid) })

	scanner, err := NewScanner(t.Context(), int32(os.Getpid()), uniqueInstance(), -1)
	if err != nil {
		t.Fatal(err)
	}
	sample, _, err := scanner.Scan(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := findProcess(sample, int32(pid)); !ok || !p.Attached {
		t.Fatalf("sleep under the shell: found=%v attached=%v, want tracked and attached", ok, p.Attached)
	}

	stdin.Close()
	if err := shell.Wait(); err != nil {
		t.Fatal(err)
	}
	sample, _, err = scanner.Scan(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := findProcess(sample, int32(pid)); !ok || p.Attached {
		t.Errorf("sleep after its shell exited: found=%v attached=%v, want tracked and detached", ok, p.Attached)
	}
}

// startDaemon starts this test binary through a shell that exits right away, so the daemon is reparented away
// from the test.
func startDaemon(t *testing.T, env []string) int32 {
	t.Helper()
	cmd := exec.Command("sh", "-c", `"$1" </dev/null >/dev/null 2>&1 & echo $!`, "sh", os.Args[0])
	cmd.Env = append(env, sleepEnv)
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
