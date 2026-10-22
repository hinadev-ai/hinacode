package main

import (
	"context"
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/sys/unix"
)

const (
	defaultMemoryKind = "phys_footprint"
	rusageInfoV2      = 2
	// szomb is SZOMB from <sys/proc.h>.
	szomb = 5
)

// rusageInfoV2Struct mirrors struct rusage_info_v2 from <sys/resource.h>; proc_pid_rusage writes all of it.
type rusageInfoV2Struct struct {
	UUID                [16]byte
	UserTime            uint64
	SystemTime          uint64
	PkgIdleWkups        uint64
	InterruptWkups      uint64
	Pageins             uint64
	WiredSize           uint64
	ResidentSize        uint64
	PhysFootprint       uint64
	ProcStartAbstime    uint64
	ProcExitAbstime     uint64
	ChildUserTime       uint64
	ChildSystemTime     uint64
	ChildPkgIdleWkups   uint64
	ChildInterruptWkups uint64
	ChildPageins        uint64
	ChildElapsedAbstime uint64
	DiskIOBytesRead     uint64
	DiskIOBytesWritten  uint64
}

var loadProcPidRusage = sync.OnceValues(func() (func(pid int32, flavor int32, buffer unsafe.Pointer) int32, error) {
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("open libSystem: %w", err)
	}
	var procPidRusage func(pid int32, flavor int32, buffer unsafe.Pointer) int32
	purego.RegisterLibFunc(&procPidRusage, lib, "proc_pid_rusage")
	return procPidRusage, nil
})

// processMemory returns phys_footprint, the number Activity Monitor shows. Unlike RSS it includes compressed
// memory, so a leaking process the OS compresses still grows. It falls back to RSS when libproc refuses.
func processMemory(ctx context.Context, p *process.Process) (uint64, string, error) {
	if footprint, err := physFootprint(p.Pid); err == nil {
		return footprint, "phys_footprint", nil
	}
	info, err := p.MemoryInfoWithContext(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("read memory of %d: %w", p.Pid, err)
	}
	return info.RSS, "rss", nil
}

func physFootprint(pid int32) (uint64, error) {
	procPidRusage, err := loadProcPidRusage()
	if err != nil {
		return 0, err
	}
	var usage rusageInfoV2Struct
	if ret := procPidRusage(pid, rusageInfoV2, unsafe.Pointer(&usage)); ret != 0 {
		return 0, fmt.Errorf("proc_pid_rusage(%d) returned %d", pid, ret)
	}
	return usage.PhysFootprint, nil
}

// isZombie reads kinfo_proc directly, because gopsutil's Status runs ps on every call on macOS.
func isZombie(_ context.Context, p *process.Process) bool {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", int(p.Pid))
	return err == nil && info.Proc.P_stat == szomb
}
