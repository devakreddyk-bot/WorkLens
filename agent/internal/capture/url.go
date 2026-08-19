package capture

import (
	"net/url"
	"sort"
	"strings"
	"unicode"
)

// ---------------------------------------------------------------------------
// Browser-title URL derivation (docs/PLAN.md deviation D9)
//
// What this can do:      recover the page title, and sometimes the host.
// What this cannot do:   recover a URL. Not the path, not the query string, not the
//                        fragment. Those never appear in a window title.
//
// A browser puts "<page title> - <Browser>" in its title bar. That is the entire input.
// If the page's own title happens to contain a domain — many login pages, documentation
// sites and search-result pages do — the host can be read out of it. Most pages do not,
// and for those this function reports no host at all. It never infers one from the page
// title's wording, never guesses a likely site, and when a title contains two different
// candidate domains it reports none, because picking one would be a guess dressed up as
// data.
//
// The honest consequence, stated plainly in docs/AGENT.md: WorkLens' site totals are a
// partial view. A timesheet that says 40 minutes on "docs.aws.amazon.com" is right; the
// absence of a site does not mean the employee was not on one.
//
// True URL capture would need a browser extension feeding the agent the active tab's
// address. That is deliberately not built. It would take the collected data from "the
// caption the employee can already read in their own title bar" to "every address they
// visit, including the ones in the query string" — a different product with a different
// consent conversation.
// ---------------------------------------------------------------------------

// browserExecutables is the set of executables whose window titles are parsed as browser
// titles, keyed by the executable's stem (base name, lower-cased, ".exe" removed).
//
// Membership is decided by the executable and never by the title. Guessing from the title
// would misfire in both directions: a chat window discussing "Google Chrome" would be
// parsed as a browser, and a browser whose page title contains no recognisable suffix
// would not be. The executable is the one thing on a Windows desktop that reliably says
// what a program is.
var browserExecutables = map[string]struct{}{
	"chrome":   {},
	"msedge":   {},
	"firefox":  {},
	"brave":    {},
	"opera":    {},
	"vivaldi":  {},
	"chromium": {},
}

// browserTitleSuffixes are the product names browsers append to their window titles. It is
// built by buildTitleSuffixes so that the ordering and the space-free variants are derived
// rather than maintained by hand.
var browserTitleSuffixes = buildTitleSuffixes([]string{
	"Firefox Developer Edition",
	"Mozilla Firefox",
	"Google Chrome",
	"Microsoft Edge",
	"Brave Browser",
	"Chromium",
	"Firefox",
	"Vivaldi",
	"Opera GX",
	"Opera",
	"Brave",
	"Chrome",
	"Edge",
})

// buildTitleSuffixes returns names in the order stripBrowserSuffix must try them, together
// with a space-free variant of every multi-word name.
//
// The variants exist because of the zero-width space in Edge's title. Removing that
// character (see zeroWidthRunes) turns "Microsoft\u200b Edge" into "Microsoft Edge", which
// matches — but the builds that use the character *instead of* a space turn into
// "MicrosoftEdge", which would not. Deriving the variant covers both without a special case
// for Edge in the matching code.
//
// Longest-first ordering is what makes the matching correct: "Brave" would match the tail of
// " - Brave Browser" and leave " Browser" stuck to the page title, and "Chrome" would leave
// "Google" behind. Sorting by length rather than curating the order by hand means adding a
// browser to the list above cannot silently break the ones already in it.
func buildTitleSuffixes(names []string) []string {
	out := make([]string, 0, len(names)*2)
	seen := make(map[string]struct{}, len(names)*2)
	for _, name := range names {
		for _, variant := range []string{name, strings.ReplaceAll(name, " ", "")} {
			if _, dup := seen[variant]; dup {
				continue
			}
			seen[variant] = struct{}{}
			out = append(out, variant)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

// titleSeparators are the separators browsers place between the page title and their own
// name. Chrome and Edge use a hyphen, Firefox an em dash, and some localised builds an en
// dash. Each is surrounded by spaces, which is what keeps a hyphenated page title —
// "Invoice #42 - final" — from being mistaken for the separator.
var titleSeparators = []string{" - ", " — ", " – "}

// zeroWidthRunes are stripped from a title before anything else looks at it.
//
// This is not hygiene, it is a real bug fix: some Microsoft Edge builds render their
// product name with a zero-width space inside it, as "Microsoft\u200bEdge" or
// "Microsoft\u200b Edge". Without this normalisation the suffix never matches, every Edge
// window title keeps " - Microsoft Edge" glued to its page title, and every Edge page looks
// like a distinct page to the coalescer.
var zeroWidthRunes = map[rune]struct{}{
	'\u200b': {}, // zero-width space
	'\u200c': {}, // zero-width non-joiner
	'\u200d': {}, // zero-width joiner
	'\u2060': {}, // word joiner
	'\ufeff': {}, // zero-width no-break space / BOM
}

// IsBrowser reports whether appName is one of the browsers whose titles WorkLens parses.
// appName may be a base name ("chrome.exe") or a full path; both are accepted so callers do
// not have to remember which they hold.
func IsBrowser(appName string) bool {
	_, ok := browserExecutables[executableStem(appName)]
	return ok
}

// DeriveBrowserURL extracts a host and a page title from a browser window title.
//
// It returns ("", "") when appName is not a recognised browser. It returns a page title
// with an empty host whenever no domain can be read out of the title with confidence, which
// is the common case — see the block comment at the top of this file for why that is a
// property of the method rather than a shortcoming of this function.
//
// The page title returned is the browser's caption with the browser's own name, and Edge's
// "and N more pages" tab counter, removed.
func DeriveBrowserURL(appName, windowTitle string) (host, pageTitle string) {
	if !IsBrowser(appName) {
		return "", ""
	}

	normalized := normalizeTitle(windowTitle)
	if normalized == "" {
		return "", ""
	}

	pageTitle = stripTabCounter(stripBrowserSuffix(normalized))
	if pageTitle == "" {
		// A browser window showing nothing but its own name: a brand-new window before a
		// page has loaded. Real, and carries no page.
		return "", ""
	}

	return extractHost(pageTitle), pageTitle
}

// normalizeTitle removes zero-width characters, converts non-breaking spaces to ordinary
// ones (so that " - " matches when a browser or a page used U+00A0), collapses runs of
// whitespace, and trims the ends.
func normalizeTitle(title string) string {
	var b strings.Builder
	b.Grow(len(title))

	prevSpace := false
	for _, r := range title {
		if _, drop := zeroWidthRunes[r]; drop {
			continue
		}
		if r == '\u00a0' || unicode.IsSpace(r) {
			// Collapse here rather than in a second pass: a zero-width space between two
			// ordinary spaces would otherwise leave a double space behind after removal.
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// stripBrowserSuffix removes a trailing " - <Browser>" from a normalised title.
//
// Only a suffix is removed, and only one. A page title that contains " - " in the middle —
// "GitHub - worklens/worklens: transparent time tracking - Google Chrome" — keeps its own
// dash, because the match is anchored at the end of the string.
func stripBrowserSuffix(title string) string {
	for _, name := range browserTitleSuffixes {
		if strings.EqualFold(title, name) {
			return ""
		}
		for _, sep := range titleSeparators {
			tail := sep + name
			if len(title) > len(tail) && strings.EqualFold(title[len(title)-len(tail):], tail) {
				return strings.TrimSpace(title[:len(title)-len(tail)])
			}
		}
	}
	return title
}

// stripTabCounter removes Edge's "and N more pages" marker, plus the profile name Edge
// places after it.
//
// Edge titles read "<page> and 3 more pages - Personal - Microsoft Edge". After the browser
// suffix is gone, "<page> and 3 more pages - Personal" remains, and both parts have to go
// or the page title changes every time a tab is opened and the coalescer sees a new sample
// each interval.
//
// The profile name is only removed when it follows the tab counter. A trailing " - Personal"
// on its own is indistinguishable from part of the page's own title, and inventing a rule
// to strip it would silently truncate real titles.
func stripTabCounter(title string) string {
	lower := strings.ToLower(title)
	idx := strings.Index(lower, " and ")
	for idx >= 0 {
		if rest, ok := matchTabCounter(lower[idx:]); ok {
			// The counter matched; everything from " and " onward is browser chrome, except
			// that `rest` must be either empty or a single " - <profile>" segment.
			if rest == "" || isProfileSegment(rest) {
				return strings.TrimSpace(title[:idx])
			}
		}
		next := strings.Index(lower[idx+1:], " and ")
		if next < 0 {
			break
		}
		idx += 1 + next
	}
	return title
}

// matchTabCounter matches " and <digits> more page(s)|tab(s)" at the start of s and returns
// whatever follows it.
func matchTabCounter(s string) (rest string, ok bool) {
	const prefix = " and "
	if !strings.HasPrefix(s, prefix) {
		return "", false
	}
	s = s[len(prefix):]

	digits := 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return "", false
	}
	s = s[digits:]

	for _, noun := range []string{" more pages", " more page", " more tabs", " more tab"} {
		if strings.HasPrefix(s, noun) {
			return s[len(noun):], true
		}
	}
	return "", false
}

// isProfileSegment reports whether s is a single " - <name>" segment, which is the shape of
// the Edge profile name that follows the tab counter. The length bound and the ban on a
// further separator keep this from swallowing a page title.
func isProfileSegment(s string) bool {
	for _, sep := range titleSeparators {
		if !strings.HasPrefix(s, sep) {
			continue
		}
		name := s[len(sep):]
		if name == "" || len(name) > 60 {
			return false
		}
		for _, inner := range titleSeparators {
			if strings.Contains(name, inner) {
				return false
			}
		}
		return true
	}
	return false
}

// extractHost reads a hostname out of a page title, or returns "" when it cannot do so with
// confidence.
//
// The rules, in order of how much of the honesty of this feature rests on them:
//
//  1. A candidate must end in a top-level domain from hostTLDs below. Accepting any
//     dot-separated token would turn "readme.md" and "index.ts" — which appear in browser
//     titles constantly, because that is what a code host puts in its page title — into
//     hosts in someone's timesheet.
//  2. If the title yields two different candidates, none is returned. A search-results page
//     listing several domains gives no basis for choosing, and choosing anyway would be a
//     guess recorded as a fact.
//  3. Anything containing "@" is skipped. That is an email address, or userinfo in a URL,
//     and neither belongs in url_host.
func extractHost(pageTitle string) string {
	var found string
	for _, token := range splitCandidateTokens(pageTitle) {
		candidate := hostFromToken(token)
		if candidate == "" {
			continue
		}
		if found == "" {
			found = candidate
			continue
		}
		if found != candidate {
			return "" // rule 2: ambiguous, so report nothing.
		}
	}
	return found
}

// splitCandidateTokens breaks a title into pieces that could each be a URL or a bare host.
// Characters that can legally appear inside a URL stay inside a token; everything else is a
// boundary.
func splitCandidateTokens(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		switch r {
		case '.', '-', '/', ':', '?', '=', '&', '#', '%', '@', '_', '+', '~', '\'':
			return false
		}
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// hostFromToken returns the hostname a single token represents, or "".
func hostFromToken(token string) string {
	token = strings.Trim(token, ".-/:?=&#%'")
	if token == "" {
		return ""
	}

	lower := strings.ToLower(token)

	// An explicit http(s) URL in a title (some sites put one there, and so does a
	// "file not found" page) is the one case where the host is stated rather than inferred.
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		parsed, err := url.Parse(token)
		if err != nil {
			return ""
		}
		return normalizeHost(parsed.Hostname())
	}
	if strings.Contains(lower, "://") {
		return "" // some other scheme; not a web host.
	}
	if strings.Contains(lower, "@") {
		return "" // rule 3.
	}

	// Cut anything a bare "host/path" style token might carry after the host.
	if i := strings.IndexAny(lower, "/:?#"); i >= 0 {
		lower = lower[:i]
	}
	return normalizeHost(lower)
}

// normalizeHost validates a hostname and returns it in the canonical form stored in
// activity_events.url_host, or "" if it is not a plausible host.
//
// "www." is stripped so that the same site does not appear twice in a timesheet's site
// totals depending on whether the page's title happened to include the prefix.
func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if host == "" || len(host) > MaxURLHostLen {
		return ""
	}

	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return ""
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return ""
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return ""
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			isAllowed := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'
			if !isAllowed {
				return ""
			}
		}
	}

	if _, ok := hostTLDs[labels[len(labels)-1]]; !ok {
		return ""
	}

	// A bare TLD-looking pair such as "co.uk" is a public suffix, not a site.
	if len(labels) == 2 {
		if _, ok := publicSuffixSecondLevels[labels[0]]; ok {
			return ""
		}
	}

	host = strings.TrimPrefix(host, "www.")
	if strings.Count(host, ".") == 0 {
		// Stripping "www." from "www.com" would leave a bare TLD.
		return ""
	}
	return host
}

// hostTLDs is the allowlist a candidate's last label must appear in.
//
// It is deliberately a conservative allowlist rather than the full IANA list. The full list
// contains entries that collide with file extensions a browser tab title shows every day —
// .md, .rs, .ts, .sh, .zip, .mov, .pl, .so — and with an allow-everything rule
// "readme.md - worklens/worklens" becomes a visit to the host "readme.md". Those specific
// collisions are excluded below and the list is otherwise limited to TLDs that carry real
// traffic in a work context. A site on a TLD that is not here yields no host, which is the
// documented and preferred failure: silence rather than a wrong answer.
var hostTLDs = map[string]struct{}{
	// Generic
	"com": {}, "org": {}, "net": {}, "edu": {}, "gov": {}, "mil": {}, "int": {},
	"info": {}, "biz": {}, "name": {}, "pro": {},
	// Common modern generics
	"io": {}, "ai": {}, "app": {}, "dev": {}, "cloud": {}, "tech": {}, "online": {},
	"site": {}, "store": {}, "shop": {}, "blog": {}, "news": {}, "email": {}, "page": {},
	"live": {}, "work": {}, "team": {}, "systems": {}, "software": {}, "solutions": {},
	"agency": {}, "digital": {}, "finance": {}, "health": {}, "legal": {}, "media": {},
	"academy": {}, "careers": {}, "consulting": {}, "support": {}, "training": {},
	"xyz": {}, "co": {}, "tv": {}, "cc": {}, "gg": {},
	// Country codes seen in a work context. Codes that double as common file
	// extensions are intentionally absent; see the comment above.
	"in": {}, "uk": {}, "us": {}, "ca": {}, "au": {}, "nz": {}, "ie": {}, "de": {},
	"fr": {}, "es": {}, "it": {}, "nl": {}, "be": {}, "ch": {}, "at": {}, "se": {},
	"dk": {}, "fi": {}, "no": {}, "pt": {}, "gr": {}, "cz": {}, "ro": {}, "hu": {},
	"jp": {}, "cn": {}, "kr": {}, "sg": {}, "hk": {}, "tw": {}, "my": {}, "id": {},
	"ph": {}, "th": {}, "vn": {}, "ae": {}, "sa": {}, "il": {}, "tr": {}, "za": {},
	"ke": {}, "ng": {}, "eg": {}, "br": {}, "mx": {}, "ar": {}, "cl": {}, "pe": {},
	"eu": {}, "ru": {}, "ua": {}, "pk": {}, "bd": {}, "lk": {},
}

// publicSuffixSecondLevels are the second-level labels that make a two-label host a public
// suffix rather than a site: "co.uk" is not somewhere anyone visited, "bbc.co.uk" is.
var publicSuffixSecondLevels = map[string]struct{}{
	"co": {}, "com": {}, "net": {}, "org": {}, "gov": {}, "ac": {}, "edu": {},
	"ltd": {}, "plc": {}, "nic": {}, "res": {}, "gen": {}, "firm": {}, "ind": {},
}

// executableStem reduces an executable name or path to a lower-case stem: "chrome" from
// `C:\Program Files\Google\Chrome\Application\chrome.exe`. Both separators are handled
// because a path read from Win32 uses backslashes and a test fixture may not.
func executableStem(appName string) string {
	if i := strings.LastIndexAny(appName, `\/`); i >= 0 {
		appName = appName[i+1:]
	}
	appName = strings.ToLower(strings.TrimSpace(appName))
	return strings.TrimSuffix(appName, ".exe")
}
