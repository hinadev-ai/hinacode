package main

import "time"

// Sample is one line of the log. The Electron side reads these field names, so they are a contract.
type Sample struct {
	At        time.Time `json:"at"`
	Root      int32     `json:"root"`
	Memory    string    `json:"memory"`
	Final     bool      `json:"final"`
	Processes []Process `json:"processes"`
}

type Process struct {
	PID         int32   `json:"pid"`
	PPID        int32   `json:"ppid"`
	StartedAt   int64   `json:"startedAt"`
	Name        string  `json:"name"`
	Role        string  `json:"role"`
	Command     string  `json:"command"`
	Attached    bool    `json:"attached"`
	CPUSeconds  float64 `json:"cpuSeconds"`
	MemoryBytes uint64  `json:"memoryBytes"`
}

// identity tells a process apart from a later one that reuses its pid.
type identity struct {
	pid       int32
	startedAt int64
}

func (p Process) identity() identity {
	return identity{pid: p.PID, startedAt: p.StartedAt}
}
