package capture

import "testing"

// The titles in this table are the real shapes seen on a Windows desktop, including the ones
// that break naive parsing: an em-dash separator, a hyphen inside the page's own title, the
// zero-width space some Microsoft Edge builds put inside their product name, Edge's tab
// counter and profile segment, a filename whose extension collides with a country-code TLD,
// and titles with no separator at all.
func TestDeriveBrowserURL(t *testing.T) {
	// U+200B is written as an escape so it survives copy-paste and code review; in the wild
	// it is invisible, which is exactly why it broke suffix matching in the first place.
	const zwsp = "\u200b"

	tests := []struct {
		name      string
		appName   string
		title     string
		wantHost  string
		wantTitle string
	}{
		{
			name:      "chrome, hyphen separator, page title contains its own hyphens",
			appName:   "chrome.exe",
			title:     "GitHub - worklens/worklens: transparent employee time tracking - Google Chrome",
			wantHost:  "",
			wantTitle: "GitHub - worklens/worklens: transparent employee time tracking",
		},
		{
			name:      "chrome, host present in the page title",
			appName:   "chrome.exe",
			title:     "Lambda quotas - docs.aws.amazon.com - Google Chrome",
			wantHost:  "docs.aws.amazon.com",
			wantTitle: "Lambda quotas - docs.aws.amazon.com",
		},
		{
			name:      "chrome, full path to the executable",
			appName:   `C:\Program Files\Google\Chrome\Application\chrome.exe`,
			title:     "Reports - Google Chrome",
			wantHost:  "",
			wantTitle: "Reports",
		},
		{
			name:      "chrome, explicit URL in the title yields the host and nothing more",
			appName:   "chrome.exe",
			title:     "https://worklens.example.com/reports?from=2026-01-01 - Google Chrome",
			wantHost:  "worklens.example.com",
			wantTitle: "https://worklens.example.com/reports?from=2026-01-01",
		},
		{
			name:      "chrome, www is normalised away so site totals do not split",
			appName:   "chrome.exe",
			title:     "www.linkedin.com/feed - Google Chrome",
			wantHost:  "linkedin.com",
			wantTitle: "www.linkedin.com/feed",
		},
		{
			name:      "chrome, an email address is never a host",
			appName:   "chrome.exe",
			title:     "(2) Inbox (14) - alex@example-corp.com.au - Gmail - Google Chrome",
			wantHost:  "",
			wantTitle: "(2) Inbox (14) - alex@example-corp.com.au - Gmail",
		},
		{
			name:      "chrome, two candidate domains is ambiguous, so no host",
			appName:   "chrome.exe",
			title:     "worklens.io vs timedoctor.com — a comparison - Google Chrome",
			wantHost:  "",
			wantTitle: "worklens.io vs timedoctor.com — a comparison",
		},
		{
			name:      "chrome, the same host twice is not ambiguous",
			appName:   "chrome.exe",
			title:     "example.com login | example.com - Google Chrome",
			wantHost:  "example.com",
			wantTitle: "example.com login | example.com",
		},
		{
			name:      "chrome, a filename is not a host even when its extension is a TLD",
			appName:   "chrome.exe",
			title:     "readme.md - worklens/worklens - Google Chrome",
			wantHost:  "",
			wantTitle: "readme.md - worklens/worklens",
		},
		{
			name:      "chrome, a meeting code is not a host",
			appName:   "chrome.exe",
			title:     "Meet - abc-defg-hij - Google Chrome",
			wantHost:  "",
			wantTitle: "Meet - abc-defg-hij",
		},
		{
			name:      "chrome, no separator at all",
			appName:   "chrome.exe",
			title:     "Untitled",
			wantHost:  "",
			wantTitle: "Untitled",
		},
		{
			name:      "chrome, a brand new window showing only the browser name",
			appName:   "chrome.exe",
			title:     "Google Chrome",
			wantHost:  "",
			wantTitle: "",
		},
		{
			name:      "chrome, empty title",
			appName:   "chrome.exe",
			title:     "",
			wantHost:  "",
			wantTitle: "",
		},
		{
			name:      "edge, zero-width space inside the product name, tab counter and profile",
			appName:   "msedge.exe",
			title:     "Inbox (12) and 3 more pages - Personal - Microsoft" + zwsp + " Edge",
			wantHost:  "",
			wantTitle: "Inbox (12)",
		},
		{
			name:      "edge, zero-width space used instead of the space",
			appName:   "msedge.exe",
			title:     "docs.aws.amazon.com/lambda/latest - Microsoft" + zwsp + "Edge",
			wantHost:  "docs.aws.amazon.com",
			wantTitle: "docs.aws.amazon.com/lambda/latest",
		},
		{
			name:      "edge, tab counter with no profile segment",
			appName:   "msedge.exe",
			title:     "Dashboard and 2 more pages - Microsoft Edge",
			wantHost:  "",
			wantTitle: "Dashboard",
		},
		{
			name:      "edge, a page title that merely reads like the tab counter is left alone",
			appName:   "msedge.exe",
			title:     "Rules and 3 more pages of notes - Microsoft Edge",
			wantHost:  "",
			wantTitle: "Rules and 3 more pages of notes",
		},
		{
			name:      "firefox, em-dash separator, page title contains an em dash",
			appName:   "firefox.exe",
			title:     "Privacy Notice — Mozilla — Mozilla Firefox",
			wantHost:  "",
			wantTitle: "Privacy Notice — Mozilla",
		},
		{
			name:      "firefox, host only",
			appName:   "firefox.exe",
			title:     "news.ycombinator.com — Mozilla Firefox",
			wantHost:  "news.ycombinator.com",
			wantTitle: "news.ycombinator.com",
		},
		{
			name:      "brave",
			appName:   "brave.exe",
			title:     "Hacker News - Brave",
			wantHost:  "",
			wantTitle: "Hacker News",
		},
		{
			name:      "brave, full product name",
			appName:   "brave.exe",
			title:     "status.example.org - Brave Browser",
			wantHost:  "status.example.org",
			wantTitle: "status.example.org",
		},
		{
			name:      "opera",
			appName:   "opera.exe",
			title:     "Sprint board - jira.example.co.uk - Opera",
			wantHost:  "jira.example.co.uk",
			wantTitle: "Sprint board - jira.example.co.uk",
		},
		{
			name:      "vivaldi, window showing only the browser name",
			appName:   "vivaldi.exe",
			title:     "Vivaldi",
			wantHost:  "",
			wantTitle: "",
		},
		{
			name:      "chromium",
			appName:   "chromium.exe",
			title:     "Build 1234 - ci.example.in - Chromium",
			wantHost:  "ci.example.in",
			wantTitle: "Build 1234 - ci.example.in",
		},
		{
			name:      "a non-browser is never parsed, even when its title looks like one",
			appName:   "code.exe",
			title:     "sampler.go - worklens - Visual Studio Code",
			wantHost:  "",
			wantTitle: "",
		},
		{
			name:      "a non-browser whose title mentions a browser and a domain",
			appName:   "slack.exe",
			title:     "#engineering — chrome broke on docs.example.com - Google Chrome",
			wantHost:  "",
			wantTitle: "",
		},
		{
			name:      "a bare public suffix is not a site",
			appName:   "chrome.exe",
			title:     "Registry for co.uk - Google Chrome",
			wantHost:  "",
			wantTitle: "Registry for co.uk",
		},
		{
			name:      "a version number is not a host",
			appName:   "chrome.exe",
			title:     "Release 1.24.3 notes - Google Chrome",
			wantHost:  "",
			wantTitle: "Release 1.24.3 notes",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			host, pageTitle := DeriveBrowserURL(tc.appName, tc.title)
			if host != tc.wantHost {
				t.Errorf("host = %q, want %q", host, tc.wantHost)
			}
			if pageTitle != tc.wantTitle {
				t.Errorf("page title = %q, want %q", pageTitle, tc.wantTitle)
			}
		})
	}
}

func TestIsBrowser(t *testing.T) {
	browsers := []string{
		"chrome.exe", "CHROME.EXE", "msedge.exe", "firefox.exe", "brave.exe",
		"opera.exe", "vivaldi.exe", "chromium.exe",
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
	}
	for _, appName := range browsers {
		if !IsBrowser(appName) {
			t.Errorf("IsBrowser(%q) = false, want true", appName)
		}
	}

	// chromedriver and a browser-shaped installer are not browsers: they never show a page
	// title, and treating them as browsers would put their own captions into url_title.
	notBrowsers := []string{
		"", "code.exe", "explorer.exe", "chromedriver.exe", "ChromeSetup.exe",
		"firefox-installer.exe", "opera_autoupdate.exe",
	}
	for _, appName := range notBrowsers {
		if IsBrowser(appName) {
			t.Errorf("IsBrowser(%q) = true, want false", appName)
		}
	}
}

// The point of the method's documented limit: a title carries no path and no query, so
// nothing this function returns may contain one. Anything more would mean the agent had
// found a source of true URLs, which it deliberately does not have.
func TestHostNeverCarriesPathOrQuery(t *testing.T) {
	titles := []string{
		"https://worklens.example.com/reports?from=2026-01-01&to=2026-01-31 - Google Chrome",
		"example.com/admin/users?id=42 - Google Chrome",
		"http://intranet.example.co.in:8080/hr/salary - Microsoft Edge",
	}
	for _, title := range titles {
		host, _ := DeriveBrowserURL("chrome.exe", title)
		for _, bad := range []string{"/", "?", "&", "=", ":"} {
			if host != "" && contains(host, bad) {
				t.Errorf("host %q derived from %q contains %q", host, title, bad)
			}
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
