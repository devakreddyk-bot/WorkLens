package logging

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Keys whose values never reach a log line, at any nesting depth. Matched case-insensitively
// as substrings, so `deviceSecret`, `device_secret` and `DEVICE_SECRET_B64` are all caught by
// "secret", and `X-WL-Signature` by "signature".
//
// This is the same list as REDACTED_KEY_PATTERNS in backend/src/shared/logger.ts. Keeping them
// identical matters: the agent signs requests and the backend verifies them, so the same field
// names appear on both sides of the wire and a name that is redacted in CloudWatch but not in
// the file on the laptop would be a hole in exactly the place nobody looks.
var redactedKeyPatterns = []string{
	"secret",
	"password",
	"token",
	"credential",
	"authorization",
	"signature",
	"apikey",
	"api_key",
	"privatekey",
	"private_key",
	"rootkey",
	"root_key",
	"cookie",
	"sessionid",
	"session_id",
}

// Keys holding personal data. Redacted unless Options.IncludeTitles is set.
//
// A window title is the most sensitive thing the agent handles. The employee agreed to the
// collection of titles into their timesheet; they did not agree to a plaintext file of them
// accumulating in a log directory nobody manages or retains deliberately.
var personalDataKeyPatterns = []string{
	"window_title",
	"windowtitle",
	"url_title",
	"urltitle",
	"page_title",
	"pagetitle",
}

// Replacement markers. Two of them, because "this was a credential" and "this was personal
// data" call for different reactions from whoever is reading the log.
const (
	redactedValue    = "[redacted]"
	redactedPersonal = "[redacted:personal-data]"
)

// Walk limits. A cyclic or pathologically large value must not be able to hang a log call or
// turn one line into a megabyte; the caps mirror backend/src/shared/logger.ts.
const (
	maxDepth        = 8
	maxItems        = 50
	maxStringLength = 2000
)

// MinSecretLength is the shortest literal AddSecret will register.
//
// Scrubbing a short string would replace unrelated text everywhere it happened to occur and
// leave a log that is both unreadable and misleading about what was removed. Every real secret
// in WorkLens — the derived device secret, an enrolment token, an HMAC signature — is far
// longer than this.
const MinSecretLength = 8

// redactor holds the literal values that must never appear in output.
//
// Key-based redaction handles structured values, but it cannot help once a secret has been
// interpolated into prose: fmt.Errorf("enrol %s: %w", token, err) produces a single string, and
// by the time the logger sees it the token is just characters in the middle of a sentence.
// This is the answer to that, and it is why AddSecret exists and is called from wherever
// credentials are loaded.
type redactor struct {
	mu sync.RWMutex
	// literals holds each registered secret and, alongside it, the form the secret takes
	// once JSON-escaped. The escaped form is what appears in the finished bytes when a
	// secret contains a quote or a backslash, so scrubbing only the raw form would miss it.
	literals []string
}

func newRedactor() *redactor { return &redactor{} }

// add registers a secret, reporting whether it was long enough to be usable.
func (r *redactor) add(secret string) bool {
	if len(secret) < MinSecretLength {
		return false
	}

	forms := []string{secret}
	if encoded, err := json.Marshal(secret); err == nil {
		if inner := string(encoded[1 : len(encoded)-1]); inner != secret {
			forms = append(forms, inner)
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for _, form := range forms {
		if !contains(r.literals, form) {
			r.literals = append(r.literals, form)
		}
	}
	return true
}

func contains(haystack []string, needle string) bool {
	for _, candidate := range haystack {
		if candidate == needle {
			return true
		}
	}
	return false
}

// scrubString removes every registered secret from s.
func (r *redactor) scrubString(s string) string {
	if s == "" {
		return s
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, literal := range r.literals {
		if strings.Contains(s, literal) {
			s = strings.ReplaceAll(s, literal, redactedValue)
		}
	}
	return s
}

// scrubBytes is scrubString over an encoded line.
func (r *redactor) scrubBytes(line []byte) []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.literals) == 0 {
		return line
	}
	out := string(line)
	for _, literal := range r.literals {
		if strings.Contains(out, literal) {
			out = strings.ReplaceAll(out, literal, redactedValue)
		}
	}
	return []byte(out)
}

// keyMatches reports whether key contains any of the patterns, case-insensitively.
func keyMatches(key string, patterns []string) bool {
	lower := strings.ToLower(key)
	for _, pattern := range patterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// redactField applies the key rules and then walks the value.
func (c *core) redactField(key string, value any) any {
	if keyMatches(key, redactedKeyPatterns) {
		return redactedValue
	}
	if !c.includeTitles && keyMatches(key, personalDataKeyPatterns) {
		return redactedPersonal
	}
	return c.redactValue(value, 0, map[visited]bool{})
}

// visited identifies a pointer already on the current path, so a cyclic structure terminates.
// The type is part of the key because a struct and its first field share an address.
type visited struct {
	ptr uintptr
	typ reflect.Type
}

// redactValue converts an arbitrary value into something json.Marshal can render, filtering as
// it goes.
//
// It deliberately does not consult json.Marshaler or fmt.Stringer. A type that formats itself
// could emit a secret its field names had hidden, and the whole point of this package is that
// there is no such path. Named types are reduced to their underlying kind instead, which keeps
// privacy.Reason readable as a string while giving it no say in the matter.
func (c *core) redactValue(value any, depth int, seen map[visited]bool) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return c.string(typed)
	case bool, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64, float32, float64:
		return typed
	case time.Duration:
		return typed.String()
	case time.Time:
		return typed.UTC().Format(time.RFC3339Nano)
	case []byte:
		// Key material moves around as bytes. Never log the bytes themselves.
		return fmt.Sprintf("[%d bytes]", len(typed))
	case error:
		// Error() has already flattened any wrapped chain into one string, so the scrub is
		// the only thing standing between a %w-wrapped secret and the log file.
		return c.string(typed.Error())
	}

	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		if rv.Kind() == reflect.Pointer {
			key := visited{ptr: rv.Pointer(), typ: rv.Type()}
			if seen[key] {
				return "[circular]"
			}
			seen[key] = true
			defer delete(seen, key)
		}
		return c.redactValue(rv.Elem().Interface(), depth, seen)

	case reflect.String:
		return c.string(rv.String())
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint()
	case reflect.Float32, reflect.Float64:
		return rv.Float()

	case reflect.Struct:
		if depth >= maxDepth {
			return "[max depth]"
		}
		return c.redactStruct(rv, depth, seen)

	case reflect.Map:
		if depth >= maxDepth {
			return "[max depth]"
		}
		key := visited{ptr: rv.Pointer(), typ: rv.Type()}
		if seen[key] {
			return "[circular]"
		}
		seen[key] = true
		defer delete(seen, key)
		return c.redactMap(rv, depth, seen)

	case reflect.Slice, reflect.Array:
		if depth >= maxDepth {
			return "[max depth]"
		}
		return c.redactList(rv, depth, seen)

	case reflect.Func, reflect.Chan, reflect.UnsafePointer:
		// None of these has any business in a log line, and printing a pointer would leak
		// nothing useful but a memory address.
		return "[" + rv.Kind().String() + "]"

	default:
		return fmt.Sprintf("[%s]", rv.Kind())
	}
}

// redactStruct walks exported fields, keyed by their JSON name where they have one.
//
// Unexported fields are skipped. That is a feature rather than a limitation: reading them
// would require unsafe access, and a type that keeps a secret private has already said it does
// not want it copied around.
func (c *core) redactStruct(rv reflect.Value, depth int, seen map[visited]bool) any {
	rt := rv.Type()
	out := make(map[string]any, rt.NumField())

	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if !field.IsExported() {
			continue
		}

		name := field.Name
		if tag, ok := field.Tag.Lookup("json"); ok {
			tagged := strings.Split(tag, ",")[0]
			if tagged == "-" {
				continue
			}
			if tagged != "" {
				name = tagged
			}
		}

		if keyMatches(name, redactedKeyPatterns) {
			out[name] = redactedValue
			continue
		}
		if !c.includeTitles && keyMatches(name, personalDataKeyPatterns) {
			out[name] = redactedPersonal
			continue
		}
		out[name] = c.redactValue(rv.Field(i).Interface(), depth+1, seen)
	}
	return out
}

// redactMap walks a map, applying the key rules to each entry's key. A map is the shape an
// HTTP header set arrives in, which is exactly where an Authorization value would be.
func (c *core) redactMap(rv reflect.Value, depth int, seen map[visited]bool) any {
	out := make(map[string]any, rv.Len())
	count := 0

	for iter := rv.MapRange(); iter.Next(); {
		if count >= maxItems {
			out["…"] = fmt.Sprintf("%d more keys", rv.Len()-count)
			break
		}
		count++

		key := mapKeyString(iter.Key())
		if keyMatches(key, redactedKeyPatterns) {
			out[key] = redactedValue
			continue
		}
		if !c.includeTitles && keyMatches(key, personalDataKeyPatterns) {
			out[key] = redactedPersonal
			continue
		}
		out[key] = c.redactValue(iter.Value().Interface(), depth+1, seen)
	}
	return out
}

func mapKeyString(key reflect.Value) string {
	switch key.Kind() {
	case reflect.String:
		return key.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(key.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(key.Uint(), 10)
	default:
		return fmt.Sprintf("%v", key.Interface())
	}
}

func (c *core) redactList(rv reflect.Value, depth int, seen map[visited]bool) any {
	length := rv.Len()
	limit := length
	if limit > maxItems {
		limit = maxItems
	}

	out := make([]any, 0, limit+1)
	for i := 0; i < limit; i++ {
		out = append(out, c.redactValue(rv.Index(i).Interface(), depth+1, seen))
	}
	if length > limit {
		out = append(out, fmt.Sprintf("…%d more", length-limit))
	}
	return out
}

// string scrubs registered secrets and then truncates, in that order.
//
// The order matters. Truncating first could cut a secret in half and leave the first half in
// the log, which is both a leak and one that no test looking for the whole value would catch.
func (c *core) string(value string) string {
	return truncate(c.redactor.scrubString(value))
}

func truncate(value string) string {
	if len(value) <= maxStringLength {
		return value
	}
	return value[:maxStringLength] + fmt.Sprintf("…[truncated %d]", len(value)-maxStringLength)
}
