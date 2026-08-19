package uploader

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPinConstantsMatchAmazonRoots is the test that makes hardcoded pins safe.
//
// A mistyped or truncated pin cannot be caught by review — it looks like every other base64
// string — and its consequence is that the entire fleet fails to connect, on the day it is
// deployed, with an error that resembles a backend outage. Checking the constants against the
// actual certificates turns that class of mistake into a failing test.
//
// The PEMs in testdata/ came from https://www.amazontrust.com/repository/ and are public
// certificate authority certificates, not secrets.
func TestPinConstantsMatchAmazonRoots(t *testing.T) {
	cases := []struct {
		file     string
		pin      string
		expectCN string
	}{
		{"AmazonRootCA1.pem", AmazonRootCA1SPKI, "Amazon Root CA 1"},
		{"AmazonRootCA2.pem", AmazonRootCA2SPKI, "Amazon Root CA 2"},
		{"AmazonRootCA3.pem", AmazonRootCA3SPKI, "Amazon Root CA 3"},
		{"AmazonRootCA4.pem", AmazonRootCA4SPKI, "Amazon Root CA 4"},
	}

	for _, tc := range cases {
		t.Run(tc.expectCN, func(t *testing.T) {
			cert := loadPEM(t, tc.file)

			if cert.Subject.CommonName != tc.expectCN {
				t.Fatalf("testdata/%s is %q, expected %q — has the wrong certificate been committed?",
					tc.file, cert.Subject.CommonName, tc.expectCN)
			}

			if got := SPKIHash(cert); got != tc.pin {
				t.Errorf("pin constant does not match the certificate\n"+
					"  constant: %s\n  actual:   %s\nRecompute with:\n"+
					"  openssl x509 -in %s -pubkey -noout | openssl pkey -pubin -outform der | "+
					"openssl dgst -sha256 -binary | base64", tc.pin, got, tc.file)
			}
		})
	}
}

func TestDefaultPinsCoverEveryAmazonRoot(t *testing.T) {
	// All four, including the ECDSA roots. A pin set that has to be updated when AWS changes a
	// certificate type is a pin set that will eventually cause an outage.
	pins := DefaultPins()
	if len(pins) != 4 {
		t.Fatalf("DefaultPins returned %d pins, want 4", len(pins))
	}

	set, err := NewPinSet(pins)
	if err != nil {
		t.Fatalf("the default pins are not a valid pin set: %v", err)
	}
	if set.Len() != 4 {
		t.Errorf("pin set holds %d pins, want 4 — are two of the constants identical?", set.Len())
	}

	for _, file := range []string{"AmazonRootCA1.pem", "AmazonRootCA2.pem", "AmazonRootCA3.pem", "AmazonRootCA4.pem"} {
		cert := loadPEM(t, file)
		if !set.Matches([]*x509.Certificate{cert}) {
			t.Errorf("the default pin set does not match %s", file)
		}
	}
}

func loadPEM(t *testing.T, name string) *x509.Certificate {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("could not read testdata/%s: %v", name, err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatalf("testdata/%s is not PEM", name)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("could not parse testdata/%s: %v", name, err)
	}
	return cert
}

// ---------------------------------------------------------------------------
// Pin parsing
// ---------------------------------------------------------------------------

func TestNewPinSetAcceptsBase64AndHex(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	asHex := hex.EncodeToString(raw)

	for name, pin := range map[string]string{
		"base64":                 b64,
		"hex":                    asHex,
		"base64 with sha256/":    "sha256/" + b64,
		"base64 with sha256:":    "sha256:" + b64,
		"base64 with whitespace": "  " + b64 + "  ",
	} {
		set, err := NewPinSet([]string{pin})
		if err != nil {
			t.Errorf("%s pin rejected: %v", name, err)
			continue
		}
		// Whichever form went in, it must normalise to the same value — otherwise a hex pin and
		// the equivalent base64 pin would be two different entries and one would never match.
		if got := set.Hashes(); len(got) != 1 || got[0] != b64 {
			t.Errorf("%s pin normalised to %v, want [%s]", name, got, b64)
		}
	}
}

func TestNewPinSetRejectsBadPins(t *testing.T) {
	// 0xFF rather than 0x00: the base64 of all-zero bytes is a run of "A" characters, which is
	// ALSO valid hex, so a zero-filled fixture is ambiguous rather than simply wrong. See
	// TestAmbiguousPinEncodingPrefersHex.
	cases := map[string][]string{
		// A truncated copy-paste is the realistic failure, and a pin that can never match
		// presents as a total outage.
		"too short":         {base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xFF}, 16))},
		"too long":          {base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xFF}, 48))},
		"not base64 or hex": {"this is definitely not a hash"},
		// An empty pin set with pinning enabled would silently accept anything the system store
		// trusts, which is the opposite of what configuring pins was meant to achieve.
		"empty list":  {},
		"only blanks": {"", "   "},
	}

	for name, pins := range cases {
		if _, err := NewPinSet(pins); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

// TestAmbiguousPinEncodingPrefersHex documents a genuine ambiguity rather than pretending it
// away.
//
// A 64-character string drawn only from [0-9A-Fa-f] is simultaneously valid hex (decoding to 32
// bytes) and valid base64 (decoding to 48). Both readings are legitimate, so one has to win, and
// hex does: a 64-character hex digest is the conventional way to write a SHA-256, and it is the
// form a browser certificate viewer produces. A 48-byte pin has no meaning here at all — SPKI
// pins are SHA-256 — so preferring hex resolves the ambiguity towards the only interpretation
// that could have been intended.
func TestAmbiguousPinEncodingPrefersHex(t *testing.T) {
	raw := bytes.Repeat([]byte{0xAB}, 32)
	asHex := hex.EncodeToString(raw) // 64 chars, all in the base64 alphabet

	set, err := NewPinSet([]string{asHex})
	if err != nil {
		t.Fatalf("an ambiguous 64-character hex pin was rejected: %v", err)
	}

	want := base64.StdEncoding.EncodeToString(raw)
	if got := set.Hashes(); len(got) != 1 || got[0] != want {
		t.Errorf("ambiguous pin normalised to %v, want [%s] — it was read as base64, not hex", got, want)
	}
}

func TestDisabledPinSetAcceptsAnything(t *testing.T) {
	set := DisabledPinSet()
	if set.Enabled() {
		t.Error("DisabledPinSet reports itself as enabled")
	}
	if !set.Matches(nil) {
		t.Error("a disabled pin set rejected an empty chain")
	}
	if !set.Matches([]*x509.Certificate{loadPEM(t, "AmazonRootCA1.pem")}) {
		t.Error("a disabled pin set rejected a chain")
	}
}

func TestNilPinSetIsNotEnabled(t *testing.T) {
	// Defensive: a nil set must behave as "not configured" rather than panicking, because the
	// alternative is the agent crashing on a configuration path.
	var set *PinSet
	if set.Enabled() {
		t.Error("a nil pin set reported itself enabled")
	}
	if set.Len() != 0 || set.Hashes() != nil {
		t.Error("a nil pin set reported pins")
	}
	if !set.Matches(nil) {
		t.Error("a nil pin set rejected a chain")
	}
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

func TestMatchesIsAnyOfAny(t *testing.T) {
	// Any certificate in the chain against any configured pin. Requiring a position in the
	// chain would break when AWS adds or removes an intermediate.
	ca1 := loadPEM(t, "AmazonRootCA1.pem")
	ca3 := loadPEM(t, "AmazonRootCA3.pem")

	set, err := NewPinSet([]string{AmazonRootCA3SPKI})
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}

	// The pinned certificate last in the chain, as a root would be.
	if !set.Matches([]*x509.Certificate{ca1, ca3}) {
		t.Error("a chain ending in the pinned root did not match")
	}
	// And first, in case the chain is ordered the other way.
	if !set.Matches([]*x509.Certificate{ca3, ca1}) {
		t.Error("a chain beginning with the pinned root did not match")
	}
	// A chain with none of the pins must not match.
	if set.Matches([]*x509.Certificate{ca1}) {
		t.Error("a chain with no pinned certificate matched")
	}
}

func TestMatchesToleratesNilEntries(t *testing.T) {
	set, _ := NewPinSet([]string{AmazonRootCA1SPKI})
	ca1 := loadPEM(t, "AmazonRootCA1.pem")
	if !set.Matches([]*x509.Certificate{nil, ca1, nil}) {
		t.Error("nil entries in the chain prevented a match")
	}
}

// ---------------------------------------------------------------------------
// The TLS callback, against a real handshake
// ---------------------------------------------------------------------------

// TestPinningRejectsAnUnpinnedServer is the end-to-end case: a TLS server whose certificate is
// perfectly valid but chains to a CA that is not pinned. This is the corporate
// TLS-inspection-proxy scenario the pin exists for.
func TestPinningRejectsAnUnpinnedServer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// The server's own certificate, trusted explicitly, so the handshake fails ONLY on the pin
	// and not on chain verification. Without this the test would pass for the wrong reason.
	certPool := x509.NewCertPool()
	certPool.AddCert(server.Certificate())

	set, err := NewPinSet(DefaultPins())
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:            tls.VersionTLS12,
		RootCAs:               certPool,
		VerifyPeerCertificate: set.VerifyPeerCertificate("127.0.0.1"),
	}}}

	_, err = client.Get(server.URL)
	if err == nil {
		t.Fatal("the handshake succeeded against a server that matches no pin")
	}
	if !strings.Contains(err.Error(), ErrPinMismatch.Error()) {
		t.Errorf("failure was not a pin mismatch: %v", err)
	}
	// The error must name what was presented, so a genuine CA rotation can be diagnosed without
	// reproducing the failure under openssl.
	if !strings.Contains(err.Error(), "expected one of") {
		t.Errorf("the mismatch error does not list the expected pins: %v", err)
	}
}

// TestPinningAcceptsAPinnedServer is the same handshake with the server's own key pinned, which
// proves the callback is not simply rejecting everything.
func TestPinningAcceptsAPinnedServer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	certPool := x509.NewCertPool()
	certPool.AddCert(server.Certificate())

	set, err := NewPinSet([]string{SPKIHash(server.Certificate())})
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:            tls.VersionTLS12,
		RootCAs:               certPool,
		VerifyPeerCertificate: set.VerifyPeerCertificate("127.0.0.1"),
	}}}

	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("the handshake failed against a pinned server: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status %d, want 200", resp.StatusCode)
	}
}

func TestDisabledPinningAcceptsAnUnpinnedServer(t *testing.T) {
	// The WORKLENS_TLS_PINNING=off escape hatch, for a deployment behind a mandatory inspection
	// proxy. It must actually work, or the flag is a lie.
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	certPool := x509.NewCertPool()
	certPool.AddCert(server.Certificate())

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:            tls.VersionTLS12,
		RootCAs:               certPool,
		VerifyPeerCertificate: DisabledPinSet().VerifyPeerCertificate("127.0.0.1"),
	}}}

	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("the handshake failed with pinning disabled: %v", err)
	}
	_ = resp.Body.Close()
}

// TestPinningIsAdditionalNotAReplacement proves the standard verification still runs: a server
// whose certificate is NOT in the client's root pool must be rejected even when its key is
// pinned. Pinning narrows trust; it must never widen it.
func TestPinningIsAdditionalNotAReplacement(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	set, err := NewPinSet([]string{SPKIHash(server.Certificate())})
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}

	// No RootCAs: the certificate is untrusted by the system store.
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:            tls.VersionTLS12,
		VerifyPeerCertificate: set.VerifyPeerCertificate("127.0.0.1"),
	}}}

	if _, err := client.Get(server.URL); err == nil {
		t.Fatal("an untrusted certificate was accepted because its key was pinned; " +
			"pinning must be an additional check, never a replacement for chain verification")
	}
}

func TestTLSConfigNeverSkipsVerification(t *testing.T) {
	cfg := DefaultPinSet(t).TLSConfig("api.example.com")

	if cfg.InsecureSkipVerify {
		t.Error("TLSConfig set InsecureSkipVerify; that would make the pin the ONLY check")
	}
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion = %x, want TLS 1.2 (API Gateway's floor)", cfg.MinVersion)
	}
	if cfg.ServerName != "api.example.com" {
		t.Errorf("ServerName = %q, want the API host", cfg.ServerName)
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Error("TLSConfig did not install the pin verification callback")
	}
}

func DefaultPinSet(t *testing.T) *PinSet {
	t.Helper()
	set, err := NewPinSet(DefaultPins())
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}
	return set
}

func TestVerifyPeerCertificateFallsBackToRawCerts(t *testing.T) {
	// With standard verification enabled, verifiedChains is always populated. The fallback
	// exists so that if it ever is not, the pin is still CHECKED rather than silently passing —
	// a check that quietly becomes a no-op is worse than no check.
	ca1 := loadPEM(t, "AmazonRootCA1.pem")
	set, _ := NewPinSet([]string{AmazonRootCA1SPKI})

	verify := set.VerifyPeerCertificate("api.example.com")

	if err := verify([][]byte{ca1.Raw}, nil); err != nil {
		t.Errorf("the raw-certificate fallback rejected a pinned certificate: %v", err)
	}

	other := loadPEM(t, "AmazonRootCA3.pem")
	if err := verify([][]byte{other.Raw}, nil); err == nil {
		t.Error("the raw-certificate fallback accepted an unpinned certificate")
	} else if !errors.Is(err, ErrPinMismatch) {
		t.Errorf("error is not ErrPinMismatch: %v", err)
	}
}

func TestSPKIHashIsStableAndDistinct(t *testing.T) {
	seen := map[string]string{}
	for _, name := range []string{"AmazonRootCA1.pem", "AmazonRootCA2.pem", "AmazonRootCA3.pem", "AmazonRootCA4.pem"} {
		cert := loadPEM(t, name)
		hash := SPKIHash(cert)

		if SPKIHash(cert) != hash {
			t.Errorf("%s: SPKIHash is not deterministic", name)
		}
		if decoded, err := base64.StdEncoding.DecodeString(hash); err != nil || len(decoded) != 32 {
			t.Errorf("%s: hash %q is not 32 base64-encoded bytes", name, hash)
		}
		if previous, dup := seen[hash]; dup {
			t.Errorf("%s and %s produced the same SPKI hash", name, previous)
		}
		seen[hash] = name
	}

	if len(seen) != 4 {
		t.Errorf("got %d distinct hashes across 4 roots", len(seen))
	}
}
