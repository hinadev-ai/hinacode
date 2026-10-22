package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWatchReportsSurvivorAfterRootExits(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	dir := t.TempDir()
	bin := filepath.Join(dir, "resource-monitor")
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	instance := uniqueInstance()
	root := exec.Command("sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!; read _")
	root.Env = envWithInstance(instance)
	rootIn, err := root.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	rootOut, err := root.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := root.Start(); err != nil {
		t.Fatal(err)
	}

	logDir := filepath.Join(dir, "logs")
	log := filepath.Join(logDir, "run.ndjson")
	var stderr bytes.Buffer
	watch := exec.CommandContext(ctx, bin, "watch",
		"-root", strconv.Itoa(root.Process.Pid),
		"-instance", instance,
		"-out", log,
		"-interval", "100ms",
		"-grace", "200ms")
	watch.Stderr = &stderr
	if err := watch.Start(); err != nil {
		t.Fatal(err)
	}

	line, err := bufio.NewReader(rootOut).ReadString('\n')
	if err != nil {
		t.Fatalf("read survivor pid: %v", err)
	}
	survivor, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse survivor pid %q: %v", line, err)
	}
	t.Cleanup(func() { killPID(survivor) })
	for {
		if data, _ := os.ReadFile(log); bytes.Contains(data, []byte("\n")) {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("watch never wrote a sample while the root ran")
		}
		time.Sleep(20 * time.Millisecond)
	}
	rootIn.Close()
	go root.Wait()

	if err := watch.Wait(); err != nil {
		t.Fatalf("watch: %v\n%s", err, stderr.String())
	}

	samples, err := readSamples(log)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) < 2 {
		t.Fatalf("got %d samples, want a regular sample and a final one", len(samples))
	}
	final := samples[len(samples)-1]
	if !final.Final {
		t.Error("last sample is not final")
	}
	if p, ok := findProcess(final, int32(survivor)); !ok || p.Attached {
		t.Errorf("survivor in final sample: found=%v attached=%v, want detached", ok, p.Attached)
	}
	if _, ok := findProcess(final, int32(root.Process.Pid)); ok {
		t.Error("final sample still lists the exited root")
	}
	if !strings.Contains(stderr.String(), "1 process outlived HinaCode") ||
		!strings.Contains(stderr.String(), strconv.Itoa(survivor)+"  sleep") {
		t.Errorf("stderr does not name the survivor %d:\n%s", survivor, stderr.String())
	}

	report := exec.CommandContext(ctx, bin, "report", logDir)
	out, err := report.Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("report exit: %v, want exit code 1\n%s", err, out)
	}
	if !strings.Contains(string(out), "Outlived HinaCode (1)") || !strings.Contains(string(out), strconv.Itoa(survivor)) {
		t.Errorf("report does not list survivor %d:\n%s", survivor, out)
	}
}

func TestReadSamplesIgnoresPartialLastLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.ndjson")
	line, err := json.Marshal(Sample{Root: 1, Memory: "pss", Processes: []Process{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(append(line, '\n'), line[:10]...), 0o644); err != nil {
		t.Fatal(err)
	}
	samples, err := readSamples(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Errorf("got %d samples, want 1", len(samples))
	}
}
