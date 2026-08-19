//go:build windows

package notice

import (
	"fmt"

	syswin "golang.org/x/sys/windows"
)

// The two MessageBox return values this code cares about. golang.org/x/sys/windows exports the
// MB_* input flags but not the IDYES/IDNO results, so they are named here rather than left as
// bare numbers at the comparison.
const (
	idYes = 6
	idNo  = 7
)

// messageBoxPresenter shows the notice with MessageBoxW.
//
// A plain message box, not a custom window, and that is a deliberate choice rather than a corner
// cut. The notice has to appear at logon, before anything else the agent does, on a machine whose
// display configuration and DPI are unknown, and it has to be impossible to mistake for something
// dismissable. MessageBoxW is drawn by the operating system, needs no window class, no message
// loop and no toolkit, cannot fail to lay out its own text, and — because it is modal — cannot be
// left half-answered while capture waits. A bespoke window would look better and would put a GUI
// framework into a binary whose whole design is one static executable with no runtime.
//
// The agent runs as a per-user logon task rather than a service (deviation D5 in docs/PLAN.md),
// so it has an interactive desktop to draw on. A service in session 0 would not, which is one
// more reason that deviation exists.
type messageBoxPresenter struct {
	caption string
}

// NewPresenter returns the notice presenter for this operating system.
func NewPresenter() (Presenter, error) {
	return messageBoxPresenter{caption: Caption}, nil
}

// Present shows the notice and waits for the employee to answer.
//
// The buttons are Yes and No, and No is the default. Both halves of that matter: declining has to
// be possible, or the "acknowledgment" is a click-through that evidences nothing, and the default
// must not be Yes, because a message box that appears while somebody is typing must not be able
// to consent to monitoring on their behalf when they hit Return.
//
// A Yes/No box has no close button and ignores Escape, so the only two ways out are the two
// answers. Any error, and any unexpected return value, is reported as "not accepted": there is no
// path through this function where a failure to ask counts as agreement.
func (p messageBoxPresenter) Present(text string) (bool, error) {
	textPtr, err := syswin.UTF16PtrFromString(text)
	if err != nil {
		return false, fmt.Errorf("notice: the notice text cannot be shown as a Windows string: %w", err)
	}
	captionPtr, err := syswin.UTF16PtrFromString(p.caption)
	if err != nil {
		return false, fmt.Errorf("notice: the notice caption cannot be shown as a Windows string: %w", err)
	}

	// MB_SETFOREGROUND and MB_TOPMOST because this appears during logon, when Explorer is
	// still starting windows of its own and would otherwise cover it. MB_SYSTEMMODAL for the
	// same reason: the one thing that must not happen is the notice sitting unnoticed behind
	// another window while the employee wonders why the agent has not started.
	flags := uint32(syswin.MB_YESNO |
		syswin.MB_ICONINFORMATION |
		syswin.MB_DEFBUTTON2 |
		syswin.MB_SETFOREGROUND |
		syswin.MB_TOPMOST |
		syswin.MB_SYSTEMMODAL)

	result, err := syswin.MessageBox(0, textPtr, captionPtr, flags)
	if result == 0 {
		// Zero means the box could not be created at all — no desktop, or the window station
		// is not interactive. Never treat it as an answer.
		if err == nil {
			err = fmt.Errorf("notice: MessageBoxW could not be shown")
		}
		return false, fmt.Errorf("notice: could not show the notice: %w", err)
	}

	switch result {
	case idYes:
		return true, nil
	case idNo:
		return false, nil
	default:
		return false, fmt.Errorf("notice: unexpected answer %d from the notice window", result)
	}
}
