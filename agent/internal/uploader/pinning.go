// Package uploader ships buffered activity to the backend.
//
// This file implements certificate pinning (docs/PLAN.md deviation D8).
//
// # What is pinned, and why not the leaf
//
// The obvious thing to pin is the server's own certificate. It is also wrong here: the API
// sits behind an ACM-issued certificate, and ACM rotates it — routinely at about 13 months,
// and early whenever AWS chooses. A fleet pinned to the leaf would fail to authenticate
// *everywhere, simultaneously*, on a day nobody scheduled, and the failure would look like a
// backend outage rather than an expiry.
//
// So the pin is the SHA-256 of the SubjectPublicKeyInfo of a **certificate authority** in the
// chain — by default Amazon Root CA 1 and Amazon Root CA 2. Two pins, not one, so either CA
// can be retired without an outage: verification succeeds if *any* certificate in the
// presented chain matches *any* configured pin.
//
// # What this does and does not buy
//
// Pinning to a public root is weaker than pinning a leaf: it narrows trust from "any of the
// ~150 CAs in the system store" to "Amazon's". That is the meaningful threat here — a
// corporate TLS-inspection proxy, or a compromised or coerced CA, presenting a valid
// certificate for the API's hostname. It does not defend against AWS itself, which is not a
// threat this design tries to address.
//
// The system's own chain verification still runs first. Pinning is an *additional* check, never
// a replacement: `InsecureSkipVerify` is never set, so an expired or wrong-hostname
// certificate is rejected before the pin is even consulted.
//
// # Turning it off
//
// There is one escape hatch, `WORKLENS_TLS_PINNING=off`, because a deployment behind a
// mandatory corporate inspection proxy genuinely cannot use pinning and the alternative is
// that the agent simply does not work. It logs a warning on every startup, deliberately —
// a silent downgrade would be worse than no pinning at all.
package uploader

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrPinMismatch is returned when a chain verifies against the system store but contains no
// certificate matching any configured pin.
var ErrPinMismatch = errors.New("uploader: no certificate in the chain matched a configured public key pin")

// Amazon's public roots, as base64 SHA-256 SPKI hashes.
//
// These are the values reported by:
//
//	openssl x509 -in AmazonRootCA1.pem -pubkey -noout \
//	  | openssl pkey -pubin -outform der \
//	  | openssl dgst -sha256 -binary | base64
//
// and are checked against testdata/AmazonRootCA*.pem on every test run, so a transcription
// error in a pin is caught here rather than as a fleet-wide connection failure.
//
// Roots are pinned rather than intermediates because AWS rotates intermediates more often than
// roots, and the whole point of D8 is a pin that does not need a fleet update on someone
// else's schedule. docs/SECURITY.md documents the rollover procedure.
// Each constant is verified against the corresponding certificate in testdata/ by
// TestPinConstantsMatchAmazonRoots, so a typo here fails the build rather than the fleet. The
// PEMs were fetched from https://www.amazontrust.com/repository/ and are public.
const (
	// AmazonRootCA1SPKI is the RSA-2048 root. Most AWS endpoints, including API Gateway with
	// an RSA certificate, chain to this one.
	AmazonRootCA1SPKI = "++MBgDH5WGvL9Bcn5Be30cRcL0f5O+NyoXuWtQdX1aI="
	// AmazonRootCA2SPKI is the RSA-4096 root.
	AmazonRootCA2SPKI = "f0KW/FtqTjs108NpYj42SrGvOB2PpxIVM8nWxjPqJGE="
	// AmazonRootCA3SPKI is the ECDSA P-256 root.
	AmazonRootCA3SPKI = "NqvDJlas/GRcYbcWE8S/IceH9cq77kg0jVhZeAPXq8k="
	// AmazonRootCA4SPKI is the ECDSA P-384 root.
	AmazonRootCA4SPKI = "9+ze1cZgR9KO1kZrVDxA4HQ6voHRCSVNz4RdTCx4U8U="
)

// DefaultPins is the pin set used when none is configured.
//
// All four Amazon roots, not just the RSA one the endpoint uses today. Trust is still narrowed
// from every CA in the system store to Amazon's four, which is the threat this addresses — and
// including the ECDSA roots means moving the endpoint to an ECDSA certificate, or AWS moving it
// for us, does not take the fleet offline. A pin set that needs updating whenever someone else
// changes a certificate type is a pin set that will eventually cause an outage.
func DefaultPins() []string {
	return []string{AmazonRootCA1SPKI, AmazonRootCA2SPKI, AmazonRootCA3SPKI, AmazonRootCA4SPKI}
}

// SPKIHash returns the base64 SHA-256 of a certificate's SubjectPublicKeyInfo.
//
// The SPKI is hashed rather than the whole certificate because it is the part that survives
// reissue: a CA renewing its certificate with the same key produces a different certificate
// hash but the same SPKI hash, so a pin on the SPKI does not break on a renewal that changed
// nothing security-relevant.
func SPKIHash(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// PinSet is a parsed, normalised set of acceptable SPKI hashes.
type PinSet struct {
	// hashes are base64 SHA-256 SPKI digests.
	hashes map[string]struct{}
	// enabled is false only when pinning was explicitly disabled.
	enabled bool
}

// NewPinSet parses and validates pins.
//
// Accepts base64 (the conventional form, as used by HPKP and by `openssl dgst -binary |
// base64`) and hex, because an operator reading a hash out of a browser's certificate viewer
// will have hex and should not have to convert it by hand.
func NewPinSet(pins []string) (*PinSet, error) {
	set := &PinSet{hashes: make(map[string]struct{}, len(pins)), enabled: true}

	for _, raw := range pins {
		pin := strings.TrimSpace(raw)
		if pin == "" {
			continue
		}
		// Tolerate the "sha256/" prefix from HPKP-style configuration.
		pin = strings.TrimPrefix(pin, "sha256/")
		pin = strings.TrimPrefix(pin, "sha256:")

		normalised, err := normalisePin(pin)
		if err != nil {
			return nil, err
		}
		set.hashes[normalised] = struct{}{}
	}

	if len(set.hashes) == 0 {
		return nil, errors.New(
			"uploader: no usable certificate pins were configured. Pinning must either have at " +
				"least one pin or be explicitly disabled with WORKLENS_TLS_PINNING=off; an empty " +
				"pin set would silently accept anything the system store trusts")
	}

	return set, nil
}

// DisabledPinSet returns a PinSet that accepts any system-trusted chain.
//
// Only for WORKLENS_TLS_PINNING=off. Constructed explicitly rather than represented by a nil
// or empty set, so "pinning is off" is always a deliberate value in the code and never the
// accidental result of a configuration that failed to load.
func DisabledPinSet() *PinSet {
	return &PinSet{hashes: nil, enabled: false}
}

// Enabled reports whether pinning will be enforced.
func (p *PinSet) Enabled() bool { return p != nil && p.enabled }

// Len reports how many pins are configured.
func (p *PinSet) Len() int {
	if p == nil {
		return 0
	}
	return len(p.hashes)
}

// Hashes returns the configured pins, for `agentctl doctor`.
func (p *PinSet) Hashes() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.hashes))
	for hash := range p.hashes {
		out = append(out, hash)
	}
	return out
}

// normalisePin converts a pin to canonical base64, rejecting anything that is not a 32-byte
// digest. A pin of the wrong length is almost always a truncated copy-paste, and accepting one
// produces a pin that can never match — which presents as a total outage.
//
// Both encodings are attempted and whichever yields exactly 32 bytes wins. Trying base64 first
// and returning its error is NOT sufficient, and the reason is easy to miss: a 64-character hex
// digest is also syntactically valid base64. "0001…1f" base64-decodes happily to 48 bytes, so a
// base64-first implementation rejects every hex pin with a baffling "decodes to 48 bytes"
// message — while the documentation invites hex, because that is the form a browser's
// certificate viewer shows.
func normalisePin(pin string) (string, error) {
	var lengths []int

	for _, decode := range []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		hex.DecodeString,
	} {
		decoded, err := decode(pin)
		if err != nil {
			continue
		}
		if len(decoded) == sha256.Size {
			return base64.StdEncoding.EncodeToString(decoded), nil
		}
		lengths = append(lengths, len(decoded))
	}

	if len(lengths) > 0 {
		return "", fmt.Errorf(
			"uploader: pin %q decodes to %v bytes, not %d; a SHA-256 SPKI pin is %d bytes and is "+
				"usually a truncated copy-paste when it is not",
			pin, lengths, sha256.Size, sha256.Size)
	}

	return "", fmt.Errorf("uploader: pin %q is neither base64 nor hex", pin)
}

// Matches reports whether any certificate in the chain matches any configured pin.
//
// Any-of-any is the correct relation. Requiring a specific position in the chain would break
// when AWS adds or removes an intermediate; requiring all pins to match is meaningless, since
// only one root can be in a given chain.
func (p *PinSet) Matches(chain []*x509.Certificate) bool {
	if !p.Enabled() {
		return true
	}
	for _, cert := range chain {
		if cert == nil {
			continue
		}
		if _, ok := p.hashes[SPKIHash(cert)]; ok {
			return true
		}
	}
	return false
}

// VerifyPeerCertificate builds the callback for tls.Config.
//
// Note which callback this is. `VerifyPeerCertificate` runs *after* the standard verification
// that `InsecureSkipVerify: false` performs, so by the time it is called the chain has already
// been checked against the system store, the hostname has been matched, and expiry has been
// enforced. This adds a requirement; it never removes one.
//
// `verifiedChains` is preferred over `rawCerts` because it contains the chain the system
// actually built, including any root supplied from the local store rather than sent by the
// server — and the root is what is pinned. When it is empty (which should not happen with
// standard verification enabled) the raw certificates are parsed as a fallback so the check
// still runs rather than silently passing.
func (p *PinSet) VerifyPeerCertificate(host string) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
		if !p.Enabled() {
			return nil
		}

		for _, chain := range verifiedChains {
			if p.Matches(chain) {
				return nil
			}
		}

		if len(verifiedChains) == 0 {
			parsed := make([]*x509.Certificate, 0, len(rawCerts))
			for _, raw := range rawCerts {
				cert, err := x509.ParseCertificate(raw)
				if err != nil {
					continue
				}
				parsed = append(parsed, cert)
			}
			if p.Matches(parsed) {
				return nil
			}
		}

		// The error names the pins that WERE presented, so an operator hitting a genuine CA
		// rotation can add the new pin without having to reproduce the failure with openssl.
		// Public certificate hashes are not secret.
		return fmt.Errorf("%w: host %s presented %s, expected one of %s",
			ErrPinMismatch, host, describePresented(rawCerts, verifiedChains), strings.Join(p.Hashes(), ", "))
	}
}

// describePresented summarises the chain for the mismatch error.
func describePresented(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) string {
	var parts []string

	for _, chain := range verifiedChains {
		for _, cert := range chain {
			if cert == nil {
				continue
			}
			parts = append(parts, fmt.Sprintf("%s (%s)", SPKIHash(cert), cert.Subject.CommonName))
		}
	}

	if len(parts) == 0 {
		for _, raw := range rawCerts {
			cert, err := x509.ParseCertificate(raw)
			if err != nil {
				continue
			}
			parts = append(parts, fmt.Sprintf("%s (%s)", SPKIHash(cert), cert.Subject.CommonName))
		}
	}

	if len(parts) == 0 {
		return "no parseable certificates"
	}
	return strings.Join(parts, ", ")
}

// TLSConfig builds the agent's TLS configuration.
//
// TLS 1.2 is the floor because that is what API Gateway's security policy enforces; 1.3 is
// preferred automatically. `InsecureSkipVerify` is never set — the pin is added on top of
// standard verification, not instead of it.
func (p *PinSet) TLSConfig(host string) *tls.Config {
	return &tls.Config{
		MinVersion:            tls.VersionTLS12,
		ServerName:            host,
		VerifyPeerCertificate: p.VerifyPeerCertificate(host),
	}
}
