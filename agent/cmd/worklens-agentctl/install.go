package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/template"
	"time"
)

// TaskName is the scheduled task the agent runs under.
const TaskName = `WorkLens Agent`

// scheduledTaskXML is the task definition.
//
// # Why a scheduled task and not a service (docs/PLAN.md deviation D5)
//
// A Windows service runs in session 0, which has been isolated from interactive desktops since
// Vista. From there GetForegroundWindow returns the session-0 desktop's window (nothing useful),
// GetLastInputInfo reports session-0 input (never any), and a screen capture is blank. A
// service-based agent would report every employee as permanently idle — it would appear to work,
// and every timesheet would be empty.
//
// So the agent runs as a per-user task with a logon trigger, in the employee's own session. That is
// also the more transparent arrangement, which the product wants: a process the employee owns, at
// their own integrity level, with a tray icon they can see and a Task Manager entry they can end —
// rather than a SYSTEM service they can neither see nor stop.
//
// The settings below are chosen with that in mind:
//
//	RunLevel LeastPrivilege     No elevation. The agent needs none, and asking for it would make an
//	                            employee's own machine something they have less control over.
//	StopIfGoingOnBatteries      false. A laptop on battery is exactly when someone is working.
//	ExecutionTimeLimit PT0S     No limit; this is a long-running process, not a job.
//	RestartCount / Interval     Crash recovery. Three attempts a minute apart, then leave it — a
//	                            permanently crashing agent should stop rather than spin, and the
//	                            tray's absence is then the visible signal.
//	MultipleInstancesPolicy     IgnoreNew. Two agents would double every event.
const scheduledTaskXML = `<?xml version="1.0" encoding="{{.Encoding}}"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WorkLens transparent time-tracking agent. Runs in the signed-in user's own session, because a Windows service cannot observe the interactive desktop. Shows a system tray icon whenever it is running.</Description>
    <Author>WorkLens</Author>
    <URI>\{{.TaskName}}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{{.UserID}}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{{.UserID}}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{{.ExecutablePath}}</Command>
      {{if .Arguments}}<Arguments>{{.Arguments}}</Arguments>
      {{end}}<WorkingDirectory>{{.WorkingDirectory}}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`

type taskParams struct {
	TaskName         string
	UserID           string
	ExecutablePath   string
	Arguments        string
	WorkingDirectory string
	// Encoding must match how the rendered bytes are actually written. schtasks reads the
	// declaration and fails with an unhelpful "The task XML is malformed" when the two disagree,
	// so `install` renders UTF-16 and `--print` renders UTF-8 — which means the printed output can
	// be piped straight into schtasks, rather than looking correct and being rejected.
	Encoding string
}

// renderTaskXML produces the task definition.
//
// The caller sets params.Encoding to match what it will do with the result. Getting that wrong is
// not a cosmetic problem: schtasks reads the declaration and rejects a mismatch with only "The task
// XML is malformed" to go on.
func renderTaskXML(params taskParams) (string, error) {
	if params.Encoding == "" {
		// UTF-16 is the safe default because it is what the install path needs; a caller that
		// forgot would otherwise produce a file schtasks rejects.
		params.Encoding = "UTF-16"
	}

	tmpl, err := template.New("task").Parse(scheduledTaskXML)
	if err != nil {
		return "", fmt.Errorf("install: could not parse the task template: %w", err)
	}

	var out strings.Builder
	if err := tmpl.Execute(&out, params); err != nil {
		return "", fmt.Errorf("install: could not render the task definition: %w", err)
	}
	return out.String(), nil
}

// writeTaskFile writes the definition as UTF-16LE with a byte-order mark.
//
// schtasks reads the encoding from the declaration, so a UTF-8 file claiming UTF-16 fails with an
// unhelpful "The task XML is malformed". Converting at install time rather than committing a
// UTF-16 file keeps the template diffable.
func writeTaskFile(path, xml string) error {
	encoded := utf16LEWithBOM(xml)
	return os.WriteFile(path, encoded, 0o600)
}

// utf16LEWithBOM encodes a string as little-endian UTF-16 with a leading BOM.
//
// Written out rather than pulled from golang.org/x/text: it is fifteen lines, it runs once per
// install, and the agent's dependency list is deliberately short.
func utf16LEWithBOM(s string) []byte {
	out := make([]byte, 0, len(s)*2+2)
	out = append(out, 0xFF, 0xFE) // BOM

	for _, r := range s {
		if r > 0xFFFF {
			// Outside the basic multilingual plane: encode as a surrogate pair. A path can contain
			// an emoji, and silently mangling it would produce a task pointing at the wrong file.
			r -= 0x10000
			high := 0xD800 + (r >> 10)
			low := 0xDC00 + (r & 0x3FF)
			out = append(out, byte(high), byte(high>>8), byte(low), byte(low>>8))
			continue
		}
		out = append(out, byte(r), byte(r>>8))
	}
	return out
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	agentPath := fs.String("agent", "", "path to worklens-agent.exe (default: alongside this executable)")
	dataDir := fs.String("data-dir", "", "pass a data directory override to the agent")
	printOnly := fs.Bool("print", false, "print the task definition instead of registering it")
	_ = fs.Parse(args)

	executable, err := resolveAgentPath(*agentPath)
	if err != nil {
		return err
	}

	user := os.Getenv("USERNAME")
	if domain := os.Getenv("USERDOMAIN"); domain != "" && user != "" {
		user = domain + `\` + user
	}
	if user == "" {
		user = os.Getenv("USER")
	}
	if user == "" {
		return errors.New("install: could not determine the current user from USERNAME or USER")
	}

	arguments := ""
	if strings.TrimSpace(*dataDir) != "" {
		arguments = fmt.Sprintf(`--data-dir "%s"`, strings.TrimSpace(*dataDir))
	}

	params := taskParams{
		TaskName:         TaskName,
		UserID:           user,
		ExecutablePath:   executable,
		Arguments:        arguments,
		WorkingDirectory: filepath.Dir(executable),
	}

	if *printOnly {
		// UTF-8, so the printed definition can be redirected to a file and passed to schtasks
		// directly. Printing the UTF-16 form would render as mojibake in a terminal, and printing
		// UTF-8 under a UTF-16 declaration would be rejected — this is the only combination that
		// is both readable and usable.
		params.Encoding = "utf-8"
		xml, err := renderTaskXML(params)
		if err != nil {
			return err
		}
		fmt.Print(xml)
		return nil
	}

	params.Encoding = "UTF-16"
	xml, err := renderTaskXML(params)
	if err != nil {
		return err
	}

	if runtime.GOOS != "windows" {
		// Said plainly rather than pretending to succeed. A deployer scripting this on a build
		// machine needs to know nothing was registered.
		return fmt.Errorf(
			"install: scheduled tasks are a Windows feature; nothing was registered on %s.\n"+
				"  Use --print to see the definition this would install", runtime.GOOS)
	}

	taskFile := filepath.Join(os.TempDir(), fmt.Sprintf("worklens-task-%d.xml", time.Now().UnixNano()))
	if err := writeTaskFile(taskFile, xml); err != nil {
		return fmt.Errorf("install: could not write the task definition: %w", err)
	}
	defer func() { _ = os.Remove(taskFile) }()

	// /F replaces an existing task, which makes an upgrade a re-install rather than an
	// uninstall-then-install that leaves a window with no agent registered.
	output, err := exec.Command("schtasks", "/Create", "/TN", TaskName, "/XML", taskFile, "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("install: schtasks failed: %w\n%s", err, strings.TrimSpace(string(output)))
	}

	fmt.Printf("Registered the scheduled task %q for %s.\n", TaskName, user)
	fmt.Printf("  Agent: %s\n", executable)
	fmt.Printf("\nIt starts 30 seconds after each logon. To start it now without signing out:\n")
	fmt.Printf("  schtasks /Run /TN \"%s\"\n", TaskName)
	return nil
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	_ = fs.Parse(args)

	if runtime.GOOS != "windows" {
		return fmt.Errorf("uninstall: scheduled tasks are a Windows feature; nothing to remove on %s", runtime.GOOS)
	}

	output, err := exec.Command("schtasks", "/Delete", "/TN", TaskName, "/F").CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		// Already gone is a success: `uninstall` run twice, or as part of a cleanup script, must
		// not fail the script.
		if strings.Contains(strings.ToLower(text), "cannot find") {
			fmt.Printf("The scheduled task %q was not registered; nothing to do.\n", TaskName)
			return nil
		}
		return fmt.Errorf("uninstall: schtasks failed: %w\n%s", err, text)
	}

	fmt.Printf("Removed the scheduled task %q.\n", TaskName)
	fmt.Println("A running agent keeps running until the employee signs out or quits it from the tray.")
	return nil
}

// resolveAgentPath finds worklens-agent, defaulting to a sibling of this executable.
func resolveAgentPath(override string) (string, error) {
	if strings.TrimSpace(override) != "" {
		absolute, err := filepath.Abs(strings.TrimSpace(override))
		if err != nil {
			return "", fmt.Errorf("install: %w", err)
		}
		if _, err := os.Stat(absolute); err != nil {
			return "", fmt.Errorf("install: no agent executable at %s: %w", absolute, err)
		}
		return absolute, nil
	}

	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("install: could not locate this executable: %w", err)
	}

	name := "worklens-agent"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	candidate := filepath.Join(filepath.Dir(self), name)

	if _, err := os.Stat(candidate); err != nil {
		return "", fmt.Errorf(
			"install: no %s beside %s. Pass --agent with its path", name, filepath.Dir(self))
	}
	return candidate, nil
}

// osVersion returns a human-readable OS version for the enrolment record.
//
// Best-effort: it appears in the dashboard's device list to answer "which build is this?", and an
// empty string is better than failing an enrolment over it.
func osVersion() string {
	if runtime.GOOS != "windows" {
		return runtime.GOOS
	}

	// cmd's `ver` is present on every Windows since NT and needs no elevation, unlike WMI.
	output, err := exec.Command("cmd", "/c", "ver").Output()
	if err != nil {
		return "windows"
	}
	return strings.TrimSpace(strings.ReplaceAll(string(output), "\r\n", " "))
}
