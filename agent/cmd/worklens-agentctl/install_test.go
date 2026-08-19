package main

import (
	"encoding/binary"
	"encoding/xml"
	"strings"
	"testing"
	"unicode/utf16"
)

// The task definition is the one part of the agent that cannot be exercised on this machine — it
// only means anything to schtasks on Windows. So the properties that matter are asserted here
// instead, because each of them has a specific consequence when it is wrong and none of them would
// be noticed until a rollout.

func testParams() taskParams {
	return taskParams{
		TaskName:         TaskName,
		UserID:           `EXAMPLE\asha`,
		ExecutablePath:   `C:\Program Files\WorkLens\worklens-agent.exe`,
		Arguments:        `--data-dir "C:\Users\asha\AppData\Local\WorkLens"`,
		WorkingDirectory: `C:\Program Files\WorkLens`,
		Encoding:         "utf-8",
	}
}

func TestTaskXMLIsWellFormed(t *testing.T) {
	rendered, err := renderTaskXML(testParams())
	if err != nil {
		t.Fatalf("renderTaskXML failed: %v", err)
	}

	var task struct {
		XMLName xml.Name
	}
	if err := xml.Unmarshal([]byte(rendered), &task); err != nil {
		t.Fatalf("the rendered definition is not valid XML: %v\n\n%s", err, rendered)
	}
	if task.XMLName.Local != "Task" {
		t.Errorf("root element is %q, want Task", task.XMLName.Local)
	}
}

func TestTaskXMLUsesALogonTriggerNotAService(t *testing.T) {
	// The whole of deviation D5. A service in session 0 cannot see the interactive desktop:
	// GetForegroundWindow returns nothing useful, GetLastInputInfo reports no input, and a screen
	// capture is blank — every employee would show as permanently idle.
	rendered, err := renderTaskXML(testParams())
	if err != nil {
		t.Fatalf("renderTaskXML failed: %v", err)
	}

	if !strings.Contains(rendered, "<LogonTrigger>") {
		t.Error("the task has no logon trigger")
	}
	if !strings.Contains(rendered, "<LogonType>InteractiveToken</LogonType>") {
		t.Error("the task does not run with an interactive token; it could not observe the desktop")
	}
}

func TestTaskRunsWithoutElevation(t *testing.T) {
	// The agent needs no elevation, and asking for it would make an employee's own machine
	// something they have less control over — while also putting a UAC prompt in the way of every
	// install.
	rendered, _ := renderTaskXML(testParams())
	if !strings.Contains(rendered, "<RunLevel>LeastPrivilege</RunLevel>") {
		t.Error("the task requests elevation")
	}
}

func TestTaskIsNotHidden(t *testing.T) {
	// A hidden scheduled task is how covert monitoring software installs itself. WorkLens is
	// visible by design, and that has to include being findable in Task Scheduler.
	rendered, _ := renderTaskXML(testParams())
	if !strings.Contains(rendered, "<Hidden>false</Hidden>") {
		t.Error("the task is hidden from Task Scheduler")
	}
}

func TestTaskSurvivesBatteryAndHasNoTimeLimit(t *testing.T) {
	rendered, _ := renderTaskXML(testParams())

	// A laptop on battery is exactly when somebody is working.
	if !strings.Contains(rendered, "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>") {
		t.Error("the task stops when the machine goes on battery")
	}
	if !strings.Contains(rendered, "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>") {
		t.Error("the task refuses to start on battery")
	}
	// PT0S means no limit. The default is 72 hours, after which Windows would kill a long-running
	// agent and the employee would simply stop being recorded.
	if !strings.Contains(rendered, "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>") {
		t.Error("the task has an execution time limit; Windows would eventually kill the agent")
	}
}

func TestTaskRefusesASecondInstance(t *testing.T) {
	// Two agents would double every event, and the server would deduplicate none of it: the client
	// event ids differ, so both copies are legitimate as far as it can tell.
	rendered, _ := renderTaskXML(testParams())
	if !strings.Contains(rendered, "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>") {
		t.Error("the task allows concurrent instances; every event would be recorded twice")
	}
}

func TestTaskRestartsOnFailureButGivesUp(t *testing.T) {
	rendered, _ := renderTaskXML(testParams())

	if !strings.Contains(rendered, "<RestartOnFailure>") {
		t.Error("the task does not restart after a crash")
	}
	// A bounded count on purpose: a permanently crashing agent should stop rather than spin, and
	// the absent tray icon then becomes the visible signal that something is wrong.
	if !strings.Contains(rendered, "<Count>3</Count>") {
		t.Error("the restart count is not bounded")
	}
}

func TestTaskEscapesPathsAndArguments(t *testing.T) {
	// A Windows path contains backslashes and Program Files contains a space; a domain user id
	// contains a backslash too. If any of these were mangled the task would point at nothing.
	params := testParams()
	rendered, err := renderTaskXML(params)
	if err != nil {
		t.Fatalf("renderTaskXML failed: %v", err)
	}

	var task struct {
		Actions struct {
			Exec struct {
				Command   string `xml:"Command"`
				Arguments string `xml:"Arguments"`
			} `xml:"Exec"`
		} `xml:"Actions"`
		Principals struct {
			Principal struct {
				UserID string `xml:"UserId"`
			} `xml:"Principal"`
		} `xml:"Principals"`
	}
	if err := xml.Unmarshal([]byte(rendered), &task); err != nil {
		t.Fatalf("could not parse the rendered definition: %v", err)
	}

	if task.Actions.Exec.Command != params.ExecutablePath {
		t.Errorf("Command = %q, want %q", task.Actions.Exec.Command, params.ExecutablePath)
	}
	if task.Actions.Exec.Arguments != params.Arguments {
		t.Errorf("Arguments = %q, want %q", task.Actions.Exec.Arguments, params.Arguments)
	}
	if task.Principals.Principal.UserID != params.UserID {
		t.Errorf("UserId = %q, want %q", task.Principals.Principal.UserID, params.UserID)
	}
}

func TestTaskOmitsAnEmptyArgumentsElement(t *testing.T) {
	// An empty <Arguments/> is accepted by schtasks but shows as a stray blank argument in Task
	// Scheduler, which looks like a mistake to anyone inspecting it.
	params := testParams()
	params.Arguments = ""

	rendered, err := renderTaskXML(params)
	if err != nil {
		t.Fatalf("renderTaskXML failed: %v", err)
	}
	if strings.Contains(rendered, "<Arguments>") {
		t.Error("an empty Arguments element was emitted")
	}
}

// ---------------------------------------------------------------------------
// The encoding, which is the part that actually bites
// ---------------------------------------------------------------------------

func TestDeclaredEncodingMatchesTheRequest(t *testing.T) {
	// schtasks reads the declaration and rejects a mismatch with only "The task XML is malformed"
	// to go on — so `install` renders UTF-16 and `--print` renders UTF-8, and neither may drift.
	for _, encoding := range []string{"utf-8", "UTF-16"} {
		params := testParams()
		params.Encoding = encoding

		rendered, err := renderTaskXML(params)
		if err != nil {
			t.Fatalf("renderTaskXML(%s) failed: %v", encoding, err)
		}
		if !strings.HasPrefix(rendered, `<?xml version="1.0" encoding="`+encoding+`"?>`) {
			t.Errorf("declaration does not name %s: %q", encoding, firstLine(rendered))
		}
	}
}

func TestEmptyEncodingDefaultsToUTF16(t *testing.T) {
	// The install path is the one that writes a file, so a caller that forgot must not produce
	// something schtasks rejects.
	params := testParams()
	params.Encoding = ""

	rendered, err := renderTaskXML(params)
	if err != nil {
		t.Fatalf("renderTaskXML failed: %v", err)
	}
	if !strings.Contains(firstLine(rendered), "UTF-16") {
		t.Errorf("an unset encoding did not default to UTF-16: %q", firstLine(rendered))
	}
}

func TestUTF16ConversionIsCorrect(t *testing.T) {
	input := "<Task>café</Task>"
	encoded := utf16LEWithBOM(input)

	if len(encoded) < 2 || encoded[0] != 0xFF || encoded[1] != 0xFE {
		t.Fatalf("no little-endian BOM: % x", encoded[:min(4, len(encoded))])
	}

	// Decode independently of the implementation.
	units := make([]uint16, 0, (len(encoded)-2)/2)
	for i := 2; i+1 < len(encoded); i += 2 {
		units = append(units, binary.LittleEndian.Uint16(encoded[i:i+2]))
	}
	if got := string(utf16.Decode(units)); got != input {
		t.Errorf("round trip produced %q, want %q", got, input)
	}
}

func TestUTF16ConversionHandlesSurrogatePairs(t *testing.T) {
	// A path can contain an emoji. Encoding one as a single 16-bit unit would silently produce a
	// task pointing at the wrong file.
	input := "C:\\Users\\asha\\🙂\\agent.exe"
	encoded := utf16LEWithBOM(input)

	units := make([]uint16, 0)
	for i := 2; i+1 < len(encoded); i += 2 {
		units = append(units, binary.LittleEndian.Uint16(encoded[i:i+2]))
	}

	if got := string(utf16.Decode(units)); got != input {
		t.Errorf("round trip produced %q, want %q", got, input)
	}
}

func firstLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
