//go:build windows

package tray

import (
	"fmt"
	"sync"

	"fyne.io/systray"
)

// windowsController drives fyne.io/systray.
//
// This file contains no decisions. Every label, every status name and the tooltip are produced by
// the pure code in tray.go, so what an employee sees is determined by logic a test can exercise on
// any platform. What is left here is the binding: create the icon, hang menu items off it, and
// forward clicks.
type windowsController struct {
	callbacks Callbacks

	mu    sync.Mutex
	items struct {
		status    []*systray.MenuItem
		notice    *systray.MenuItem
		dashboard *systray.MenuItem
		quit      *systray.MenuItem
	}

	// pending holds the state set before the tray became ready. systray rejects menu changes
	// before onReady runs, and the agent legitimately has a state to show by then — dropping it
	// would leave the tray reading "Starting…" until the next sample.
	pending  *State
	ready    bool
	quitOnce sync.Once
}

// maxStatusLines bounds the informational block.
//
// systray menu items cannot be removed once added, only hidden, so the items are allocated up
// front and hidden when unused. Without a bound, a state with more lines than the last one would
// have to add items and the menu would grow every update.
const maxStatusLines = 8

func newPlatformController(callbacks Callbacks) (Controller, error) {
	return &windowsController{callbacks: callbacks}, nil
}

func (c *windowsController) Run(ready func()) error {
	onReady := func() {
		systray.SetTitle("WorkLens")
		systray.SetTooltip("WorkLens — starting…")
		systray.SetIcon(iconRecording)

		c.mu.Lock()
		for i := 0; i < maxStatusLines; i++ {
			item := systray.AddMenuItem("", "")
			// The informational lines are labels, not actions. Disabling them is what makes that
			// obvious rather than inviting a click that does nothing.
			item.Disable()
			item.Hide()
			c.items.status = append(c.items.status, item)
		}

		systray.AddSeparator()

		// Always present, even when nothing else is: an employee must be able to re-read what is
		// being collected at any time.
		c.items.notice = systray.AddMenuItem(ItemWhatIsRecorded,
			"Read again what this program records and what it never records")

		if c.callbacks.OnOpenDashboard != nil {
			c.items.dashboard = systray.AddMenuItem(ItemOpenDashboard,
				"Open your own timesheets and activity in a browser")
		}

		systray.AddSeparator()
		c.items.quit = systray.AddMenuItem(ItemQuit, "Stop WorkLens on this computer")

		pending := c.pending
		c.ready = true
		c.mu.Unlock()

		if pending != nil {
			c.SetState(*pending)
		}

		go c.watchClicks()

		if ready != nil {
			ready()
		}
	}

	onExit := func() {
		if c.callbacks.OnQuit != nil {
			c.callbacks.OnQuit()
		}
	}

	// systray.Run must own the main thread on Windows, which is why the Controller interface says
	// Run rather than Start: the caller has to give it the goroutine.
	systray.Run(onReady, onExit)
	return nil
}

// watchClicks forwards menu clicks. One goroutine per item, which is what systray's channel API
// gives; the channels are closed when the tray exits, so the goroutines end with it.
func (c *windowsController) watchClicks() {
	c.mu.Lock()
	notice, dashboard, quit := c.items.notice, c.items.dashboard, c.items.quit
	c.mu.Unlock()

	if notice != nil {
		go func() {
			for range notice.ClickedCh {
				if c.callbacks.OnShowNotice != nil {
					c.callbacks.OnShowNotice()
				}
			}
		}()
	}

	if dashboard != nil {
		go func() {
			for range dashboard.ClickedCh {
				if c.callbacks.OnOpenDashboard != nil {
					c.callbacks.OnOpenDashboard()
				}
			}
		}()
	}

	if quit != nil {
		go func() {
			for range quit.ClickedCh {
				c.Quit()
			}
		}()
	}
}

func (c *windowsController) SetState(state State) {
	c.mu.Lock()
	if !c.ready {
		// Held rather than dropped; applied in onReady.
		copied := state
		c.pending = &copied
		c.mu.Unlock()
		return
	}
	items := c.items.status
	c.mu.Unlock()

	systray.SetTooltip(state.Tooltip())

	// The icon follows Status.Recording() rather than a separate flag, so the icon cannot
	// contradict the label.
	if state.Status.Recording() {
		systray.SetIcon(iconRecording)
	} else {
		systray.SetIcon(iconPaused)
	}

	lines := state.MenuLines()
	for i, item := range items {
		if i < len(lines) {
			item.SetTitle(lines[i])
			item.Show()
			continue
		}
		item.Hide()
	}

	// A state with more lines than the menu can hold would silently lose the tail. Fold the
	// remainder into the last visible item rather than dropping it.
	if len(lines) > len(items) && len(items) > 0 {
		items[len(items)-1].SetTitle(fmt.Sprintf("%s (+%d more)",
			lines[len(items)-1], len(lines)-len(items)))
	}
}

func (c *windowsController) Quit() {
	// systray.Quit panics if called twice.
	c.quitOnce.Do(systray.Quit)
}
