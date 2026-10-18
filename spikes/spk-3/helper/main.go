// spikes/spk-3/helper/main.go — THROWAWAY spike: run a process tree inside a Windows Job Object.
package main

import (
	"flag"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const memoryLimitExitCode = 137

func fail(err error, what string) {
	fmt.Fprintf(os.Stderr, "aiide-helper: %s: %v\n", what, err)
	os.Exit(70)
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "run" {
		fmt.Fprintln(os.Stderr, "usage: aiide-helper run [--mem-mb N] [--max-procs N] [--parent-pid N] -- <exe> [args...]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	memMB := fs.Uint64("mem-mb", 0, "job memory limit in MB (0 = none)")
	maxProcs := fs.Uint("max-procs", 0, "active process limit (0 = none)")
	parentPID := fs.Uint("parent-pid", 0, "terminate the job when this process exits")
	_ = fs.Parse(os.Args[2:])
	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "aiide-helper: missing command after --")
		os.Exit(2)
	}
	os.Exit(run(fs.Args(), *memMB, uint32(*maxProcs), uint32(*parentPID)))
}

func run(argv []string, memMB uint64, maxProcs uint32, parentPID uint32) int {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		fail(err, "CreateJobObject")
	}
	defer windows.CloseHandle(job) // KILL_ON_JOB_CLOSE: closing the last handle kills every process in the job

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if memMB > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_JOB_MEMORY
		info.JobMemoryLimit = uintptr(memMB * 1024 * 1024)
	}
	if maxProcs > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
		info.BasicLimitInformation.ActiveProcessLimit = maxProcs
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		fail(err, "SetInformationJobObject")
	}

	for _, h := range []windows.Handle{windows.Stdin, windows.Stdout, windows.Stderr} {
		_ = windows.SetHandleInformation(h, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT)
	}
	si := &windows.StartupInfo{
		Flags:     windows.STARTF_USESTDHANDLES,
		StdInput:  windows.Stdin,
		StdOutput: windows.Stdout,
		StdErr:    windows.Stderr,
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(argv))
	if err != nil {
		fail(err, "command line")
	}
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(nil, cmdLine, nil, nil, true,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT, nil, nil, si, &pi); err != nil {
		fail(err, "CreateProcess")
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		fail(err, "AssignProcessToJobObject")
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		fail(err, "ResumeThread")
	}

	handles := []windows.Handle{pi.Process}
	if parentPID != 0 {
		ph, err := windows.OpenProcess(windows.SYNCHRONIZE, false, parentPID)
		if err != nil {
			_ = windows.TerminateJobObject(job, 1)
			return 1
		}
		defer windows.CloseHandle(ph)
		handles = append(handles, ph)
	}
	ev, err := windows.WaitForMultipleObjects(handles, false, windows.INFINITE)
	if err != nil {
		fail(err, "WaitForMultipleObjects")
	}
	if ev == windows.WAIT_OBJECT_0+1 {
		_ = windows.TerminateJobObject(job, 1)
		return 1
	}
	var code uint32
	_ = windows.GetExitCodeProcess(pi.Process, &code)
	if memMB > 0 {
		var q windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		var n uint32
		if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&q)), uint32(unsafe.Sizeof(q)), &n); err == nil &&
			uint64(q.PeakJobMemoryUsed) >= memMB*1024*1024*98/100 {
			fmt.Fprintln(os.Stderr, "aiide-helper: job memory limit exceeded")
			return memoryLimitExitCode
		}
	}
	return int(code)
}
