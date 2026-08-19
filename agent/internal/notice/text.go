package notice

import (
	"fmt"
	"strings"
	"time"
)

// Caption is the window title of the first-run notice, and the heading the tray reuses when the
// employee asks to read it again.
const Caption = "WorkLens — what this computer records"

// Details are the facts the notice has to state, supplied by the caller.
//
// The notice is only defensible if every line of it is true of *this* installation, so the
// settings that change what is collected are parameters rather than prose. A notice that
// mentioned screenshots on a deployment with screenshots switched off would be teaching the
// people who read it that the notice is boilerplate, which is the opposite of the point.
//
// This struct deliberately does not import internal/config. The mapping from configuration to
// notice copy belongs to the caller, and keeping the dependency out means the notice text can
// be rendered by `agentctl` or a test with no configuration loaded at all.
type Details struct {
	// OrgName is the organisation doing the monitoring, as the employee would recognise it.
	OrgName string

	// ContactName and ContactEmail are who to ask about this. A notice that tells someone
	// they are being monitored and gives them nobody to ask has informed them of very little.
	ContactName  string
	ContactEmail string

	// DashboardURL is where the employee sees their own data.
	DashboardURL string

	// CaptureWindowTitles mirrors monitoring_config.capture_window_titles.
	CaptureWindowTitles bool

	// CaptureURLs mirrors monitoring_config.capture_urls.
	CaptureURLs bool

	// CaptureScreenshots mirrors monitoring_config.screenshot_enabled.
	CaptureScreenshots bool

	// BlurScreenshots mirrors monitoring_config.screenshot_blur.
	BlurScreenshots bool

	// ScreenshotInterval is how often a screenshot is taken, when they are enabled.
	ScreenshotInterval time.Duration

	// IdleThreshold is how long without keyboard or mouse activity counts as idle.
	IdleThreshold time.Duration

	// WorkHoursOnly mirrors monitoring_config.work_hours_only, and WorkHours describes the
	// window in a form a person reads, e.g. "09:00-17:30, Monday to Friday".
	WorkHoursOnly bool
	WorkHours     string
}

func (d Details) withDefaults() Details {
	if strings.TrimSpace(d.OrgName) == "" {
		d.OrgName = "your employer"
	}
	if d.IdleThreshold <= 0 {
		d.IdleThreshold = 5 * time.Minute
	}
	if d.ScreenshotInterval <= 0 {
		d.ScreenshotInterval = 15 * time.Minute
	}
	if strings.TrimSpace(d.WorkHours) == "" {
		d.WorkHours = "the working hours configured by your employer"
	}
	return d
}

// Text returns the notice the employee reads before anything is recorded.
//
// # Why this copy is written the way it is
//
// This is the document that makes the deployment defensible, so it is written to be read by the
// person being monitored rather than by a lawyer protecting the person doing the monitoring.
// Three rules govern it, and breaking any of them defeats the purpose:
//
//   - It names what is collected in concrete terms, including the uncomfortable part — window
//     titles are the most revealing thing WorkLens handles, and the notice says so rather than
//     burying it in "activity metadata".
//   - It states what is never collected as flat, checkable facts. Those promises are enforced
//     structurally, not by policy: scripts/check-privacy.sh fails the build if the source ever
//     references an API that could break one of them.
//   - No euphemisms, no "may", no "certain information". Hedged wording is what makes a notice
//     worthless, because a reader who cannot tell what it means learns only that they were not
//     meant to understand it.
//
// The text has no configuration of its own beyond Details: there is deliberately no way to
// shorten it, soften it, or replace it with a deployer's own wording.
func Text(details Details) string {
	d := details.withDefaults()

	var b strings.Builder

	line := func(format string, args ...any) {
		fmt.Fprintf(&b, format, args...)
		b.WriteString("\n")
	}

	line("This computer records how it is used.")
	line("")
	line("WorkLens is installed on this computer by %s. It records your working time and", d.OrgName)
	line("which applications you use, so that timesheets can be produced without anyone")
	line("having to reconstruct their week from memory.")
	line("")
	line("Please read this before you continue. Nothing is recorded until you acknowledge it.")
	line("")
	line("WHAT IS RECORDED")
	line("")
	line("  * The application you are working in — its name and the full path of its")
	line("    program file, for example C:\\Program Files\\...\\excel.exe.")

	if d.CaptureWindowTitles {
		line("")
		line("  * The title of the window you are working in. Window titles often contain")
		line("    document names, file names, and the subject lines of messages, so this is")
		line("    the most revealing thing WorkLens records. It is said plainly here so you")
		line("    can decide what you do on this computer with that in mind.")
	} else {
		line("")
		line("  * NOT the titles of your windows. Window-title recording is switched off on")
		line("    this computer, so only the application itself is recorded.")
	}

	if d.CaptureURLs {
		line("")
		line("  * When you are in a web browser, the website name shown in the browser's own")
		line("    window title, and that page's title. WorkLens reads the caption you can")
		line("    already see at the top of the window. It does not read your browsing")
		line("    history, and it never records the full address of a page, so a page's path")
		line("    and anything after the '?' are never collected.")
	}

	line("")
	line("  * Whether you are active or idle, and for how long. You count as idle after")
	line("    %s without keyboard or mouse activity. Idle time is recorded against", humanDuration(d.IdleThreshold))
	line("    no application at all, so your idle minutes cannot be used to work out")
	line("    what was on your screen.")

	if d.CaptureScreenshots {
		blur := "They are not blurred."
		if d.BlurScreenshots {
			blur = "They are blurred before they leave this computer, so text in them cannot be read."
		}
		line("")
		line("  * Screenshots of your screen, about every %s. %s", humanDuration(d.ScreenshotInterval), blur)
	} else {
		line("")
		line("  * NO screenshots. Screen capture is switched off on this computer.")
	}

	if d.WorkHoursOnly {
		line("")
		line("  * Only during %s. Outside those hours nothing is", d.WorkHours)
		line("    recorded, and nothing is stored on this computer to be sent later.")
	}

	line("")
	line("WHAT IS NEVER RECORDED")
	line("")
	line("  * What you type. WorkLens does not record key presses, and it does not read the")
	line("    text of anything you write. Nothing in it can: it uses no input-monitoring")
	line("    hook of any kind. The only thing it asks the operating system about your")
	line("    typing is how long ago the last key or mouse event happened — a single number,")
	line("    with no key in it.")
	line("")
	line("  * Passwords. This follows from the line above: there is no mechanism that could")
	line("    capture one.")
	line("")
	line("  * The contents of your clipboard. Nothing you copy or paste is read.")
	line("")
	line("  * Your camera and your microphone. WorkLens never turns either on, and the")
	line("    program does not contain the ability to.")
	line("")
	line("  * The contents of your files, your email, or your messages. WorkLens records")
	line("    that an application was in use, never what was inside it.")
	line("")
	line("  * Anything at all when you are on another computer, or on your own device.")
	line("    WorkLens runs on this computer only, under your own Windows account.")
	line("")
	line("YOU CAN SEE YOUR OWN DATA")
	line("")

	if strings.TrimSpace(d.DashboardURL) != "" {
		line("  Everything recorded about you is visible to you, in the same detail your")
		line("  manager sees it, at:")
		line("")
		line("      %s", strings.TrimSpace(d.DashboardURL))
		line("")
		line("  Sign in and open your own timesheets and activity. If something there looks")
		line("  wrong, say so — a timesheet you have not been able to check is not much use")
		line("  to either of you.")
	} else {
		line("  Everything recorded about you is visible to you, in the same detail your")
		line("  manager sees it, in the WorkLens dashboard. Ask the contact below for the")
		line("  address and your sign-in.")
	}

	line("")
	line("  WorkLens is always visible while it is running: there is a WorkLens icon in")
	line("  the notification area, and its menu shows what is being recorded right now and")
	line("  brings this notice back whenever you want to read it again.")
	line("")
	line("QUESTIONS, OR IF YOU DO NOT AGREE")
	line("")
	line("  %s", contactSentence(d))
	line("")
	line("  If you choose No, nothing will be recorded. WorkLens will start, show its icon,")
	line("  and stay idle until you acknowledge this notice — it will not record your")
	line("  activity in the meantime. Choosing No is a conversation to have with %s,", d.OrgName)
	line("  not a fault in this program.")
	line("")
	line("Do you acknowledge that you have read this notice?")

	return b.String()
}

// contactSentence names a person to ask, and says something true when nobody has been named.
func contactSentence(d Details) string {
	name := strings.TrimSpace(d.ContactName)
	email := strings.TrimSpace(d.ContactEmail)

	switch {
	case name != "" && email != "":
		return fmt.Sprintf("Ask %s (%s).", name, email)
	case email != "":
		return fmt.Sprintf("Ask %s.", email)
	case name != "":
		return fmt.Sprintf("Ask %s.", name)
	default:
		// Deliberately not silence. An installation that forgot to configure a contact should
		// read as an omission to the person in front of it, not as though no one is
		// accountable for what the program is doing.
		return fmt.Sprintf(
			"No contact has been configured for this installation, which is an oversight worth "+
				"reporting. Ask your manager, or whoever at %s installed this computer.", d.OrgName)
	}
}

// humanDuration renders a duration the way a person would say it. time.Duration.String would
// give "5m0s", which is fine in a log line and wrong in a sentence somebody has to read.
func humanDuration(d time.Duration) string {
	switch {
	case d >= time.Hour && d%time.Hour == 0:
		return plural(int(d/time.Hour), "hour")
	case d >= time.Minute && d%time.Minute == 0:
		return plural(int(d/time.Minute), "minute")
	case d >= time.Minute:
		minutes := int(d / time.Minute)
		seconds := int((d % time.Minute) / time.Second)
		return fmt.Sprintf("%s %s", plural(minutes, "minute"), plural(seconds, "second"))
	default:
		return plural(int(d/time.Second), "second")
	}
}

func plural(count int, unit string) string {
	if count == 1 {
		return "1 " + unit
	}
	return fmt.Sprintf("%d %ss", count, unit)
}
