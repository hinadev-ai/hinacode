package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const usage = `usage:
  resource-monitor watch -root <pid> -instance <id> -out <file> [-interval 5s] [-grace 3s]
  resource-monitor report [-warmup 2m] [-min-span 10m] [-growth-limit 50] <log file or directory>
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "watch":
		return runWatch(args[1:], stderr)
	case "report":
		return runReport(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, usage)
		return 2
	}
}

type watchOptions struct {
	root     int32
	instance string
	out      string
	interval time.Duration
	grace    time.Duration
}

func runWatch(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("watch", flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.Int("root", 0, "pid of the HinaCode main process")
	instance := fs.String("instance", "", "value of HINACODE_INSTANCE that tags processes of this run")
	out := fs.String("out", "", "log file to write, one JSON sample per line")
	interval := fs.Duration("interval", 5*time.Second, "time between samples")
	grace := fs.Duration("grace", 3*time.Second, "wait after the root exits before the final sample")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *root <= 0 || *instance == "" || *out == "" || *interval <= 0 || *grace < 0 || fs.NArg() > 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	opts := watchOptions{root: int32(*root), instance: *instance, out: *out, interval: *interval, grace: *grace}
	if err := watch(context.Background(), opts, stderr); err != nil {
		fmt.Fprintf(stderr, "resource-monitor: %v\n", err)
		return 2
	}
	return 0
}

func watch(ctx context.Context, opts watchOptions, stderr io.Writer) error {
	scanner, err := NewScanner(ctx, opts.root, opts.instance, int32(os.Getpid()))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(opts.out), 0o755); err != nil {
		return fmt.Errorf("create log directory: %w", err)
	}
	f, err := os.Create(opts.out)
	if err != nil {
		return fmt.Errorf("create log: %w", err)
	}
	defer f.Close()
	// The file is unbuffered and Encode issues one write per sample, so each sample is on disk once written.
	enc := json.NewEncoder(f)

	for {
		sample, alive, err := scanner.Scan(ctx)
		if err != nil {
			return err
		}
		if !alive {
			break
		}
		if err := enc.Encode(sample); err != nil {
			return fmt.Errorf("write sample: %w", err)
		}
		time.Sleep(opts.interval)
	}

	time.Sleep(opts.grace)
	final, _, err := scanner.Scan(ctx)
	if err != nil {
		return err
	}
	final.Final = true
	if err := enc.Encode(final); err != nil {
		return fmt.Errorf("write final sample: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close log: %w", err)
	}
	printSurvivors(stderr, final.Processes)
	return nil
}

func printSurvivors(w io.Writer, survivors []Process) {
	if len(survivors) == 0 {
		return
	}
	noun := "processes"
	if len(survivors) == 1 {
		noun = "process"
	}
	fmt.Fprintf(w, "resource-monitor: %d %s outlived HinaCode\n", len(survivors), noun)
	for _, p := range survivors {
		fmt.Fprintf(w, "  %d  %s  %s\n", p.PID, p.Name, truncate(p.Command, 100))
	}
}

type reportOptions struct {
	warmup      time.Duration
	minSpan     time.Duration
	growthLimit float64
}

func runReport(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	fs.SetOutput(stderr)
	warmup := fs.Duration("warmup", 2*time.Minute, "ignore each process's memory for this long after it is first seen")
	minSpan := fs.Duration("min-span", 10*time.Minute, "skip the growth check for processes seen for less than this after warmup")
	growthLimit := fs.Float64("growth-limit", 50, "flag processes growing faster than this many MB per hour")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	path, err := resolveLog(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "resource-monitor: %v\n", err)
		return 2
	}
	samples, err := readSamples(path)
	if err != nil {
		fmt.Fprintf(stderr, "resource-monitor: %v\n", err)
		return 2
	}
	r := buildReport(samples, reportOptions{warmup: *warmup, minSpan: *minSpan, growthLimit: *growthLimit})
	if err := writeReport(stdout, path, r); err != nil {
		fmt.Fprintf(stderr, "resource-monitor: write report: %v\n", err)
		return 2
	}
	if len(r.Outlived()) > 0 || len(r.Growing()) > 0 {
		return 1
	}
	return 0
}

// resolveLog maps a directory to its newest log. The app names logs by ISO timestamp, so the newest sorts last.
func resolveLog(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return path, nil
	}
	logs, err := filepath.Glob(filepath.Join(path, "*.ndjson"))
	if err != nil {
		return "", fmt.Errorf("list logs in %s: %w", path, err)
	}
	if len(logs) == 0 {
		return "", fmt.Errorf("no .ndjson logs in %s", path)
	}
	slices.Sort(logs)
	return logs[len(logs)-1], nil
}

func readSamples(path string) ([]Sample, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var samples []Sample
	dec := json.NewDecoder(f)
	for {
		var s Sample
		err := dec.Decode(&s)
		// A monitor killed mid-write leaves a partial last line; the samples before it are still good.
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return samples, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		samples = append(samples, s)
	}
}
