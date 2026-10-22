package main

import (
	"maps"
	"slices"
	"testing"
)

func TestDescendants(t *testing.T) {
	rows := []procRow{
		{pid: 1, ppid: 0, startedAt: 0},
		{pid: 100, ppid: 1, startedAt: 1000},
		{pid: 101, ppid: 100, startedAt: 1100},
		{pid: 102, ppid: 101, startedAt: 1200},
		{pid: 103, ppid: 100, startedAt: 1000},
		// 104 reuses a pid whose original process was a child of 100, but it started before 100 did.
		{pid: 104, ppid: 100, startedAt: 900},
		{pid: 105, ppid: 104, startedAt: 1300},
		// 106 is the monitor itself; neither it nor its children count.
		{pid: 106, ppid: 100, startedAt: 1100},
		{pid: 107, ppid: 106, startedAt: 1400},
		{pid: 200, ppid: 1, startedAt: 500},
	}

	got := slices.Sorted(maps.Keys(descendants(rows, identity{pid: 100, startedAt: 1000}, 106)))
	want := []int32{100, 101, 102, 103}
	if !slices.Equal(got, want) {
		t.Errorf("descendants = %v, want %v", got, want)
	}
}

func TestDescendantsOfReplacedRoot(t *testing.T) {
	rows := []procRow{
		{pid: 100, ppid: 1, startedAt: 2000},
		{pid: 101, ppid: 100, startedAt: 2100},
	}
	if got := descendants(rows, identity{pid: 100, startedAt: 1000}, 0); len(got) != 0 {
		t.Errorf("descendants of a root whose pid was reused = %v, want none", got)
	}
}
