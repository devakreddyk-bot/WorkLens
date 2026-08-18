// Package signing implements the WorkLens device request signature.
//
// Every request the agent makes to the backend is signed. This is not a bearer token: a
// bearer token is replayable, so anyone who captures one request can resend it until the
// token expires, and shortening the expiry forces a refresh dance into an agent that is
// frequently offline. Signing each request instead authenticates the device *and* the body,
// and bounds replay to a few minutes.
//
// The wire format:
//
//	X-WL-Device:    <device uuid>
//	X-WL-Timestamp: <unix seconds>
//	X-WL-Nonce:     <32 lower-case hex characters — 128 bits from a CSPRNG>
//	X-WL-Signature: <64 lower-case hex characters — HMAC-SHA256 of the canonical request>
//
//	canonical = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" hex(sha256(BODY))
//
// Each element earns its place:
//
//   - METHOD and PATH stop a signature captured from one endpoint being replayed against
//     another. Without them a signed GET /v1/device/config could be resent as
//     POST /v1/device/events, since both have an empty body.
//   - TIMESTAMP bounds the replay window to the server's accepted skew (±300s).
//   - NONCE closes the window entirely: the server accepts a nonce once.
//   - The body hash makes the payload tamper-evident. Signing only headers would let anyone
//     who captured a request substitute a different body.
//
// # The contract with the server
//
// The verifier lives in backend/src/shared/signature.ts, in a different language, sharing no
// code with this file. Nothing in either codebase forces them to agree, and a divergence
// presents as "signature mismatch" on every request from every device with no indication of
// which side is wrong.
//
// So the agreement is pinned as data in contracts/signature-vectors.json, and
// signing_test.go asserts this implementation reproduces every vector. The TypeScript side
// has an equivalent test reading the same file. Either one drifting fails its own suite.
//
// In particular, and deliberately: the path is used **verbatim**. It is never normalised,
// decoded or re-encoded. Any normalisation rule would be one more thing that could differ
// between two implementations, so there is none — the agent signs exactly the bytes it puts
// in the request line.
package signing

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Header names carried on every signed request. Lower-case here; Go's http.Header
// canonicalises on the way out and the server matches case-insensitively.
const (
	HeaderDevice    = "X-WL-Device"
	HeaderTimestamp = "X-WL-Timestamp"
	HeaderNonce     = "X-WL-Nonce"
	HeaderSignature = "X-WL-Signature"
)

// NonceBytes is the nonce size before hex encoding. 128 bits makes an accidental collision
// impossible in practice, which matters because the server rejects a repeated nonce — a
// colliding nonce would look exactly like a replay attempt and drop a legitimate batch.
const NonceBytes = 16

// nonceHexLen and signatureHexLen are the encoded lengths, checked so a malformed value is
// rejected here rather than by the server.
const (
	nonceHexLen     = NonceBytes * 2
	signatureHexLen = sha256.Size * 2
)

// Request is everything the signature covers.
type Request struct {
	// Method is upper-cased before signing, so a caller passing "post" still verifies.
	Method string
	// Path is the request path exactly as it will appear on the wire, including any
	// percent-encoding. Never normalised. See the package doc.
	Path string
	// Timestamp is Unix seconds. The server rejects anything outside ±300s.
	Timestamp int64
	// Nonce is 32 lower-case hex characters, from GenerateNonce.
	Nonce string
	// Body is the exact request body. Signing must happen over the same bytes that are sent,
	// so callers must not re-serialise a payload after signing it.
	Body []byte
}

// CanonicalRequest builds the string that gets signed.
//
// The body appears only as a hex digest, never in the clear, which means the canonical
// string is safe to log while a request body — containing window titles — is not.
func CanonicalRequest(req Request) string {
	bodyHash := sha256.Sum256(req.Body)

	// A strings.Builder rather than fmt.Sprintf: this runs on every request, and the
	// concatenation is trivial enough that the allocation is the only cost worth avoiding.
	var sb strings.Builder
	sb.Grow(len(req.Method) + len(req.Path) + len(req.Nonce) + 2*sha256.Size + 32)

	sb.WriteString(strings.ToUpper(req.Method))
	sb.WriteByte('\n')
	sb.WriteString(req.Path)
	sb.WriteByte('\n')
	sb.WriteString(strconv.FormatInt(req.Timestamp, 10))
	sb.WriteByte('\n')
	sb.WriteString(req.Nonce)
	sb.WriteByte('\n')
	sb.WriteString(hex.EncodeToString(bodyHash[:]))

	return sb.String()
}

// Sign returns the lower-case hex HMAC-SHA256 of the canonical request.
//
// The secret is the device secret returned at enrolment. It is derived on the server from a
// root key and never stored there (docs/PLAN.md deviation D4), which is why the agent is the
// only place a copy exists and why it must never be logged.
func Sign(deviceSecret string, req Request) string {
	mac := hmac.New(sha256.New, []byte(deviceSecret))
	// Write to a hash never returns an error; the interface requires the signature.
	_, _ = mac.Write([]byte(CanonicalRequest(req)))
	return hex.EncodeToString(mac.Sum(nil))
}

// GenerateNonce returns 128 bits of cryptographically secure randomness as lower-case hex.
//
// An error here means the operating system's entropy source failed. That is not recoverable
// and must not be papered over with a weaker source: a predictable nonce lets an observer
// pre-compute the server's replay-detection key.
func GenerateNonce() (string, error) {
	buf := make([]byte, NonceBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("signing: could not read %d random bytes for a nonce: %w", NonceBytes, err)
	}
	return hex.EncodeToString(buf), nil
}

// Credentials is a device identity: the id the server knows it by and the secret it signs
// with. Kept together so a caller cannot accidentally sign with one device's secret while
// presenting another's id.
type Credentials struct {
	DeviceID string
	// Secret must never be logged. The agent's logger redacts by field name, but the
	// simplest protection is not passing this anywhere that logs.
	Secret string
}

// Headers produces the four headers for a signed request, generating a fresh nonce.
//
// The returned map is keyed by canonical header name, ready to be applied to an
// *http.Request. `now` is passed in rather than read so callers can be tested and so a single
// batch upload cannot straddle a second boundary between building and signing.
func Headers(creds Credentials, method, path string, body []byte, now time.Time) (map[string]string, error) {
	nonce, err := GenerateNonce()
	if err != nil {
		return nil, err
	}

	req := Request{
		Method:    method,
		Path:      path,
		Timestamp: now.Unix(),
		Nonce:     nonce,
		Body:      body,
	}

	return map[string]string{
		HeaderDevice:    creds.DeviceID,
		HeaderTimestamp: strconv.FormatInt(req.Timestamp, 10),
		HeaderNonce:     nonce,
		HeaderSignature: Sign(creds.Secret, req),
	}, nil
}

// ValidateNonce reports whether a nonce is the shape the server accepts.
//
// Used by tests and by agentctl doctor. The server rejects a malformed nonce with the same
// generic authentication error as a bad signature, so checking locally turns an opaque 401
// into an actionable message.
func ValidateNonce(nonce string) error {
	if len(nonce) != nonceHexLen {
		return fmt.Errorf("signing: nonce must be %d hex characters, got %d", nonceHexLen, len(nonce))
	}
	if _, err := hex.DecodeString(nonce); err != nil {
		return fmt.Errorf("signing: nonce is not valid hex: %w", err)
	}
	if strings.ToLower(nonce) != nonce {
		// The server matches on lower-case hex. Upper-case would verify locally and be
		// rejected remotely, which is the worst kind of mismatch to debug.
		return fmt.Errorf("signing: nonce must be lower-case hex")
	}
	return nil
}

// ValidateSignature reports whether a signature is the shape the server accepts.
func ValidateSignature(signature string) error {
	if len(signature) != signatureHexLen {
		return fmt.Errorf("signing: signature must be %d hex characters, got %d", signatureHexLen, len(signature))
	}
	if _, err := hex.DecodeString(signature); err != nil {
		return fmt.Errorf("signing: signature is not valid hex: %w", err)
	}
	if strings.ToLower(signature) != signature {
		return fmt.Errorf("signing: signature must be lower-case hex")
	}
	return nil
}
