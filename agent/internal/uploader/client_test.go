package uploader

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/worklens/worklens/agent/internal/signing"
	"github.com/worklens/worklens/agent/internal/store"
)

// recordedRequest captures what the server saw, so the tests can assert on signing headers,
// idempotency keys and bodies rather than only on the outcome.
type recordedRequest struct {
	Method  string
	Path    string
	Headers http.Header
	Body    string
}

type stubServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
	handler  func(w http.ResponseWriter, r *http.Request, attempt int)
	attempts int32
}

func newStubServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, attempt int)) *stubServer {
	t.Helper()
	stub := &stubServer{handler: handler}
	stub.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := int(atomic.AddInt32(&stub.attempts, 1))
		body, _ := io.ReadAll(r.Body)

		stub.mu.Lock()
		stub.requests = append(stub.requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Headers: r.Header.Clone(), Body: string(body),
		})
		stub.mu.Unlock()

		stub.handler(w, r, attempt)
	}))
	t.Cleanup(stub.Close)
	return stub
}

func (s *stubServer) recorded() []recordedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]recordedRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

const (
	testDeviceID = "9a594a02-afe7-4537-b57a-f771875c3c87"
	testSecret   = "dGVzdC1zZWNyZXQtbm90LWEtcmVhbC1kZXZpY2Utc2VjcmV0"
)

// newTestClient builds a client against a stub, with time and sleeping injected so retry
// behaviour is exercised without any real delay.
func newTestClient(t *testing.T, stub *stubServer, mutate func(*Options)) (*Client, *[]time.Duration) {
	t.Helper()

	var slept []time.Duration
	opts := Options{
		BaseURL:     stub.URL + "/v1",
		Credentials: signing.Credentials{DeviceID: testDeviceID, Secret: testSecret},
		HTTPClient:  stub.Client(),
		BaseBackoff: time.Second,
		MaxBackoff:  time.Minute,
		Now:         func() time.Time { return time.Unix(1760000000, 0) },
		// Deterministic jitter, so a test can assert on the delay sequence.
		Rand: func() float64 { return 1.0 },
		Sleep: func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			return nil
		},
	}
	if mutate != nil {
		mutate(&opts)
	}

	client, err := NewClient(opts)
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}
	return client, &slept
}

func testEvents(n int) []store.Event {
	events := make([]store.Event, 0, n)
	for i := 0; i < n; i++ {
		events = append(events, store.Event{
			ClientEventID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i),
			Type:          store.EventWindowSample,
			CapturedAt:    time.Unix(1760000000, 0).Add(time.Duration(i) * time.Minute),
			Duration:      60 * time.Second,
			AppName:       "code.exe",
		})
	}
	return events
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

func TestNewClientRequiresAnExplicitPinDecision(t *testing.T) {
	// A nil pin set must not mean "no pinning". Pinning off has to be an explicit
	// DisabledPinSet(), or a configuration that failed to load would silently accept anything the
	// system store trusts.
	_, err := NewClient(Options{BaseURL: "https://api.example.com/v1"})
	if err == nil {
		t.Fatal("a client was built with no pin set and no HTTP client")
	}
	if !strings.Contains(err.Error(), "DisabledPinSet") {
		t.Errorf("the error does not point at the explicit opt-out: %v", err)
	}

	pins, err := NewPinSet(DefaultPins())
	if err != nil {
		t.Fatalf("NewPinSet failed: %v", err)
	}
	if _, err := NewClient(Options{BaseURL: "https://api.example.com/v1", Pins: pins}); err != nil {
		t.Errorf("a client with pins was rejected: %v", err)
	}
}

func TestNewClientRejectsABadBaseURL(t *testing.T) {
	for _, bad := range []string{"", "not a url", "/no/host"} {
		if _, err := NewClient(Options{BaseURL: bad, Pins: DisabledPinSet()}); err == nil {
			t.Errorf("base URL %q was accepted", bad)
		}
	}
}

// ---------------------------------------------------------------------------
// Signing on the wire
// ---------------------------------------------------------------------------

func TestRequestsCarryVerifiableSignatureHeaders(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"accepted":1,"duplicates":0}`))
	})
	client, _ := newTestClient(t, stub, nil)

	if _, err := client.UploadEvents(context.Background(), testEvents(1)); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	recorded := stub.recorded()
	if len(recorded) != 1 {
		t.Fatalf("%d requests recorded, want 1", len(recorded))
	}
	request := recorded[0]

	for _, header := range []string{signing.HeaderDevice, signing.HeaderTimestamp, signing.HeaderNonce, signing.HeaderSignature} {
		if request.Headers.Get(header) == "" {
			t.Errorf("%s was not sent", header)
		}
	}

	// Recompute the signature the way the server will. This is the check that catches a wrong
	// signed path — the single most likely cause of a fleet-wide authentication failure.
	expected := signing.Sign(testSecret, signing.Request{
		Method:    http.MethodPost,
		Path:      "/v1/device/events",
		Timestamp: 1760000000,
		Nonce:     request.Headers.Get(signing.HeaderNonce),
		Body:      []byte(request.Body),
	})
	if got := request.Headers.Get(signing.HeaderSignature); got != expected {
		t.Errorf("signature does not verify against the path the server sees\n got: %s\nwant: %s", got, expected)
	}
}

func TestSignedPathIncludesTheStagePrefix(t *testing.T) {
	// API Gateway reports event.path including the stage, so the agent must sign it that way. If
	// this is wrong, every request fails with an opaque 401.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{}`))
	})
	client, _ := newTestClient(t, stub, nil)

	if err := client.Heartbeat(context.Background(), HeartbeatRequest{AgentVersion: "0.1.0"}); err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}

	request := stub.recorded()[0]
	if request.Path != "/v1/device/heartbeat" {
		t.Fatalf("request path = %q", request.Path)
	}

	expected := signing.Sign(testSecret, signing.Request{
		Method: http.MethodPost, Path: "/v1/device/heartbeat", Timestamp: 1760000000,
		Nonce: request.Headers.Get(signing.HeaderNonce), Body: []byte(request.Body),
	})
	if request.Headers.Get(signing.HeaderSignature) != expected {
		t.Error("the signed path does not include the stage prefix")
	}
}

func TestEnrolmentIsSentUnsigned(t *testing.T) {
	// There is no secret yet, so signing is impossible; the token is the credential.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"device_id":"d","device_secret":"s","org_id":"o","employee_id":"e","key_version":1}`))
	})

	client, err := NewClient(Options{
		BaseURL:    stub.URL + "/v1",
		HTTPClient: stub.Client(),
		Now:        func() time.Time { return time.Unix(1760000000, 0) },
	})
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}

	if _, err := client.Enroll(context.Background(), EnrollRequest{Token: "wlen_test"}); err != nil {
		t.Fatalf("Enroll failed: %v", err)
	}

	if got := stub.recorded()[0].Headers.Get(signing.HeaderSignature); got != "" {
		t.Errorf("enrolment carried a signature header %q with no credential to sign with", got)
	}
}

func TestEachRetryUsesAFreshNonce(t *testing.T) {
	// Reusing the nonce would make the second attempt look like a replay and be rejected — which
	// would turn a single network blip into permanently stuck data.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, attempt int) {
		if attempt < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":"SERVICE_UNAVAILABLE","message":"try again"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"accepted":1,"duplicates":0}`))
	})
	client, _ := newTestClient(t, stub, nil)

	if _, err := client.UploadEvents(context.Background(), testEvents(1)); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	recorded := stub.recorded()
	if len(recorded) != 3 {
		t.Fatalf("%d attempts, want 3", len(recorded))
	}

	seen := map[string]struct{}{}
	for i, request := range recorded {
		nonce := request.Headers.Get(signing.HeaderNonce)
		if _, dup := seen[nonce]; dup {
			t.Errorf("attempt %d reused nonce %s", i+1, nonce)
		}
		seen[nonce] = struct{}{}
	}
}

func TestIdempotencyKeyIsStableAcrossRetries(t *testing.T) {
	// The key must NOT change between attempts, or the server sees a new batch each time and its
	// deduplication does nothing.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, attempt int) {
		if attempt < 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"accepted":2,"duplicates":0}`))
	})
	client, _ := newTestClient(t, stub, nil)

	if _, err := client.UploadEvents(context.Background(), testEvents(2)); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	recorded := stub.recorded()
	first := recorded[0].Headers.Get("Idempotency-Key")
	if first == "" {
		t.Fatal("no Idempotency-Key was sent")
	}
	for i, request := range recorded[1:] {
		if got := request.Headers.Get("Idempotency-Key"); got != first {
			t.Errorf("attempt %d changed the idempotency key: %s != %s", i+2, got, first)
		}
	}
}

// ---------------------------------------------------------------------------
// The idempotency key itself
// ---------------------------------------------------------------------------

func TestIdempotencyKeyIsOrderIndependent(t *testing.T) {
	// A retry may claim the same events in a different order. If the key depended on that order,
	// the server would treat the retry as a new batch.
	events := testEvents(5)
	shuffled := []store.Event{events[3], events[0], events[4], events[1], events[2]}

	if IdempotencyKey(events) != IdempotencyKey(shuffled) {
		t.Error("the idempotency key changed when the events were reordered")
	}
}

func TestIdempotencyKeyDistinguishesDifferentBatches(t *testing.T) {
	five := testEvents(5)
	if IdempotencyKey(five) == IdempotencyKey(five[:4]) {
		t.Error("a batch and its subset produced the same key")
	}
	if IdempotencyKey(five) == IdempotencyKey(testEvents(6)) {
		t.Error("different batches produced the same key")
	}
}

func TestIdempotencyKeyIsNotConfusedByConcatenation(t *testing.T) {
	// Without a separator, ["ab","c"] and ["a","bc"] would hash identically and two genuinely
	// different batches would deduplicate against each other, silently discarding one.
	first := []store.Event{{ClientEventID: "ab"}, {ClientEventID: "c"}}
	second := []store.Event{{ClientEventID: "a"}, {ClientEventID: "bc"}}

	if IdempotencyKey(first) == IdempotencyKey(second) {
		t.Error("two different batches hashed to the same key")
	}
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

func TestRetryableStatusCodes(t *testing.T) {
	cases := map[int]bool{
		500: true, 502: true, 503: true, 504: true,
		429: true, 408: true, 425: true,
		400: false, 401: false, 403: false, 404: false, 409: false, 413: false, 422: false,
	}
	for status, want := range cases {
		err := &APIError{StatusCode: status, Code: "X"}
		if got := err.Retryable(); got != want {
			t.Errorf("HTTP %d: Retryable() = %v, want %v", status, got, want)
		}
	}
}

func TestRevokedDeviceIsNotRetried(t *testing.T) {
	// A revoked credential will fail identically forever; retrying wastes battery and fills logs.
	err := &APIError{StatusCode: 403, Code: CodeDeviceRevoked}
	if err.Retryable() {
		t.Error("a revoked device was treated as retryable")
	}
	if !err.Revoked() {
		t.Error("Revoked() did not recognise the code")
	}
}

func TestClockSkewIsRetriedDespiteBeingA401(t *testing.T) {
	// The one 4xx worth retrying: NTP may correct the clock between attempts. It is also reported
	// distinctly, because a wrong clock is a support call rather than an auth failure.
	err := &APIError{StatusCode: 401, Code: CodeTimestampOutOfWindow}
	if !err.Retryable() {
		t.Error("a rejected timestamp was not retried; the clock may be corrected by NTP")
	}
	if !err.ClockSkew() {
		t.Error("ClockSkew() did not recognise the code")
	}
}

func TestPinMismatchIsNeverRetried(t *testing.T) {
	// A deliberate security refusal. Retrying would hammer the endpoint while never succeeding and
	// bury the real problem in the logs.
	if retryableNetworkError(fmt.Errorf("dial: %w", ErrPinMismatch)) {
		t.Error("a pin mismatch was treated as a transient network error")
	}
	if retryableNetworkError(context.Canceled) {
		t.Error("a cancelled context was treated as retryable")
	}
}

func TestPermanentFailureStopsImmediately(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":"VALIDATION_FAILED","message":"bad batch","requestId":"req-1"}}`))
	})
	client, slept := newTestClient(t, stub, nil)

	_, err := client.UploadEvents(context.Background(), testEvents(1))
	if err == nil {
		t.Fatal("a 400 was treated as success")
	}

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error is not an APIError: %v", err)
	}
	if apiErr.Code != CodeValidationFailed || apiErr.RequestID != "req-1" {
		t.Errorf("the error envelope was not parsed: %+v", apiErr)
	}
	if len(stub.recorded()) != 1 {
		t.Errorf("%d attempts made; a malformed batch is malformed on the next attempt too", len(stub.recorded()))
	}
	if len(*slept) != 0 {
		t.Errorf("slept %v before giving up on a permanent failure", *slept)
	}
}

func TestGivesUpAfterMaxAttempts(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusBadGateway)
	})
	client, slept := newTestClient(t, stub, func(o *Options) { o.MaxAttempts = 3 })

	if _, err := client.UploadEvents(context.Background(), testEvents(1)); err == nil {
		t.Fatal("a permanently failing server was treated as success")
	}

	if got := len(stub.recorded()); got != 3 {
		t.Errorf("%d attempts, want 3", got)
	}
	// Two sleeps for three attempts: it must not sleep after the final one.
	if got := len(*slept); got != 2 {
		t.Errorf("%d sleeps for 3 attempts, want 2", got)
	}
}

func TestBackoffGrowsExponentially(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	client, slept := newTestClient(t, stub, func(o *Options) {
		o.MaxAttempts = 5
		o.BaseBackoff = time.Second
		o.MaxBackoff = time.Hour
	})

	_, _ = client.UploadEvents(context.Background(), testEvents(1))

	// Rand is pinned at 1.0, so full jitter yields the undiluted exponential sequence.
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second}
	if len(*slept) != len(want) {
		t.Fatalf("slept %v, want %d delays", *slept, len(want))
	}
	for i := range want {
		if (*slept)[i] != want[i] {
			t.Errorf("delay %d = %v, want %v", i, (*slept)[i], want[i])
		}
	}
}

func TestBackoffIsCapped(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	client, slept := newTestClient(t, stub, func(o *Options) {
		o.MaxAttempts = 6
		o.BaseBackoff = time.Minute
		o.MaxBackoff = 90 * time.Second
	})

	_, _ = client.UploadEvents(context.Background(), testEvents(1))

	for i, delay := range *slept {
		if delay > 90*time.Second {
			t.Errorf("delay %d was %v, above the 90s cap", i, delay)
		}
	}
}

func TestJitterIsApplied(t *testing.T) {
	// Full jitter is not decoration: a whole office's agents return at the same moment after a
	// wifi outage, and identical backoff would have them retry in lockstep, repeatedly.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	client, slept := newTestClient(t, stub, func(o *Options) {
		o.MaxAttempts = 4
		o.BaseBackoff = 10 * time.Second
		o.Rand = func() float64 { return 0.25 }
	})

	_, _ = client.UploadEvents(context.Background(), testEvents(1))

	// A quarter of the exponential delay.
	want := []time.Duration{2500 * time.Millisecond, 5 * time.Second, 10 * time.Second}
	for i := range want {
		if (*slept)[i] != want[i] {
			t.Errorf("jittered delay %d = %v, want %v", i, (*slept)[i], want[i])
		}
	}
}

func TestRetryAfterOverridesBackoffWhenLonger(t *testing.T) {
	// The server knows more than the agent about when it will be ready; ignoring Retry-After turns
	// a rate limit into a hammering loop.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, attempt int) {
		if attempt == 1 {
			w.Header().Set("Retry-After", "42")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"QUOTA_EXCEEDED","message":"slow down"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"accepted":1,"duplicates":0}`))
	})
	client, slept := newTestClient(t, stub, nil)

	if _, err := client.UploadEvents(context.Background(), testEvents(1)); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	if len(*slept) != 1 || (*slept)[0] != 42*time.Second {
		t.Errorf("slept %v, want a single 42s delay from Retry-After", *slept)
	}
}

func TestRetryAfterAcceptsAnHTTPDate(t *testing.T) {
	if got := parseRetryAfter("120"); got != 2*time.Minute {
		t.Errorf("delta-seconds: got %v", got)
	}
	future := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	if got := parseRetryAfter(future); got <= 0 || got > 31*time.Second {
		t.Errorf("HTTP date: got %v, want about 30s", got)
	}
	// A past date, an empty header and a negative value must all mean "no delay specified"
	// rather than a negative sleep.
	for _, value := range []string{"", "-5", time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat), "garbage"} {
		if got := parseRetryAfter(value); got != 0 {
			t.Errorf("Retry-After %q gave %v, want 0", value, got)
		}
	}
}

func TestContextCancellationStopsRetrying(t *testing.T) {
	// Shutdown must be prompt: sleeping through a cancellation the user asked for is a hang.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})

	ctx, cancel := context.WithCancel(context.Background())
	client, _ := newTestClient(t, stub, func(o *Options) {
		o.MaxAttempts = 10
		o.Sleep = func(context.Context, time.Duration) error {
			cancel()
			return context.Canceled
		}
	})

	_, err := client.UploadEvents(ctx, testEvents(1))
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	if got := len(stub.recorded()); got > 2 {
		t.Errorf("%d attempts after cancellation, want at most 2", got)
	}
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

func TestEmptyFieldsAreOmittedNotSentAsEmptyStrings(t *testing.T) {
	// The server distinguishes "no application" from "an application named the empty string", and
	// its idle-attribution CHECK is written against NULL. Sending "" would be rejected.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"accepted":1,"duplicates":0}`))
	})
	client, _ := newTestClient(t, stub, nil)

	idle := store.Event{
		ClientEventID: "00000000-0000-4000-8000-000000000001",
		Type:          store.EventIdleState,
		CapturedAt:    time.Unix(1760000000, 0),
		Duration:      5 * time.Minute,
		IsIdle:        true,
	}

	if _, err := client.UploadEvents(context.Background(), []store.Event{idle}); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	body := stub.recorded()[0].Body
	for _, field := range []string{"app_name", "app_exe", "window_title", "url_host", "url_title"} {
		if strings.Contains(body, field) {
			t.Errorf("%s was sent for an idle event; it must be omitted so the server sees NULL", field)
		}
	}

	var payload struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("the request body is not valid JSON: %v", err)
	}
	if len(payload.Events) != 1 {
		t.Fatalf("%d events in the payload, want 1", len(payload.Events))
	}
	if payload.Events[0]["is_idle"] != true {
		t.Error("is_idle was not sent as true")
	}
}

func TestCapturedAtIsSentAsUTCRFC3339(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"accepted":1}`))
	})
	client, _ := newTestClient(t, stub, nil)

	melbourne, err := time.LoadLocation("Australia/Melbourne")
	if err != nil {
		t.Fatalf("LoadLocation failed: %v", err)
	}
	event := store.Event{
		ClientEventID: "00000000-0000-4000-8000-000000000001",
		Type:          store.EventWindowSample,
		CapturedAt:    time.Date(2026, 8, 19, 9, 30, 0, 0, melbourne),
		Duration:      time.Minute,
	}

	if _, err := client.UploadEvents(context.Background(), []store.Event{event}); err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}

	// Sent in UTC so the server stores an unambiguous instant regardless of the laptop's zone.
	if !strings.Contains(stub.recorded()[0].Body, "2026-08-18T23:30:00Z") {
		t.Errorf("captured_at was not normalised to UTC: %s", stub.recorded()[0].Body)
	}
}

func TestUploadEventsWithNoEventsMakesNoRequest(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		t.Error("a request was made for an empty batch")
	})
	client, _ := newTestClient(t, stub, nil)

	result, err := client.UploadEvents(context.Background(), nil)
	if err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}
	if result.Accepted != 0 {
		t.Errorf("Accepted = %d for an empty batch", result.Accepted)
	}
}

func TestDuplicateBatchIsReportedToTheCaller(t *testing.T) {
	// The agent deletes its local copy on this exactly as on a fresh accept — that is what makes
	// a retry after a timeout free rather than a source of double counting.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"accepted":0,"duplicates":5,"duplicate":true}`))
	})
	client, _ := newTestClient(t, stub, nil)

	result, err := client.UploadEvents(context.Background(), testEvents(5))
	if err != nil {
		t.Fatalf("UploadEvents failed: %v", err)
	}
	if !result.Duplicate || result.Duplicates != 5 {
		t.Errorf("result = %+v, want Duplicate with 5 duplicates", result)
	}
}

// ---------------------------------------------------------------------------
// Other endpoints
// ---------------------------------------------------------------------------

func TestFeatureDisabledOnPresignIsPermanent(t *testing.T) {
	// Screenshots are switched off for this organisation. The caller discards the image; retrying
	// would fail identically until someone changes a setting.
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"FEATURE_DISABLED","message":"screenshots are disabled"}}`))
	})
	client, _ := newTestClient(t, stub, nil)

	_, err := client.PresignScreenshot(context.Background(), PresignRequest{SHA256: "x"})
	if err == nil {
		t.Fatal("a disabled feature was treated as success")
	}

	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != CodeFeatureDisabled {
		t.Fatalf("unexpected error: %v", err)
	}
	if apiErr.Retryable() {
		t.Error("FEATURE_DISABLED was treated as retryable")
	}
	if len(stub.recorded()) != 1 {
		t.Errorf("%d attempts for a permanent failure", len(stub.recorded()))
	}
}

func TestScreenshotUploadAppliesTheServersHeadersExactly(t *testing.T) {
	// The presign constrains Content-Length, Content-Type and the SSE-KMS header. S3 rejects a
	// mismatch, which is the point of a constrained presign — so the headers are passed through
	// rather than reconstructed.
	var received http.Header
	var receivedLength int64
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Clone()
		receivedLength = r.ContentLength
		w.WriteHeader(http.StatusOK)
	}))
	defer s3.Close()

	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{}`))
	})
	client, _ := newTestClient(t, stub, nil)

	image := strings.NewReader("pretend-png-bytes")
	err := client.UploadScreenshotBytes(context.Background(), PresignResponse{
		ScreenshotID: "s1",
		UploadURL:    s3.URL + "/screenshots/s1.png",
		Headers: map[string]string{
			"Content-Type":                                "image/png",
			"x-amz-server-side-encryption":                "aws:kms",
			"x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:ap-south-1:000000000000:key/abc",
		},
	}, image, int64(image.Len()))
	if err != nil {
		t.Fatalf("UploadScreenshotBytes failed: %v", err)
	}

	if got := received.Get("x-amz-server-side-encryption"); got != "aws:kms" {
		t.Errorf("the SSE-KMS header was not forwarded: %q", got)
	}
	if got := received.Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q", got)
	}
	if receivedLength != 17 {
		t.Errorf("Content-Length = %d, want 17", receivedLength)
	}
	// The device signature must NOT be on an S3 request: the URL carries the authorisation.
	if received.Get(signing.HeaderSignature) != "" {
		t.Error("the device signature was sent to S3")
	}
}

func TestEnrolResponseWithoutACredentialIsRejected(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"device_id":"d"}`))
	})
	client, err := NewClient(Options{
		BaseURL: stub.URL + "/v1", HTTPClient: stub.Client(),
		Now: func() time.Time { return time.Unix(1760000000, 0) },
	})
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}

	if _, err := client.Enroll(context.Background(), EnrollRequest{Token: "wlen_x"}); err == nil {
		t.Error("an enrolment response with no secret was accepted")
	}
}

func TestNonJSONErrorBodyIsSummarisedNotSwallowed(t *testing.T) {
	// A captive portal answering with an HTML login page is the realistic case. The excerpt is
	// what makes that recognisable in a log instead of a bare "HTTP 502".
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><body>Sign in to hotel wifi</body></html>"))
	})
	client, _ := newTestClient(t, stub, func(o *Options) { o.MaxAttempts = 1 })

	_, err := client.UploadEvents(context.Background(), testEvents(1))
	if err == nil {
		t.Fatal("an HTML error page was treated as success")
	}
	if !strings.Contains(err.Error(), "hotel wifi") {
		t.Errorf("the error does not include an excerpt of the body: %v", err)
	}
}

func TestWithCredentialsDoesNotMutateTheOriginal(t *testing.T) {
	stub := newStubServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{}`))
	})
	client, _ := newTestClient(t, stub, nil)

	updated := client.WithCredentials(signing.Credentials{DeviceID: "other", Secret: "other-secret"})

	if client.creds.DeviceID != testDeviceID {
		t.Error("WithCredentials mutated the original client")
	}
	if updated.creds.DeviceID != "other" {
		t.Error("WithCredentials did not apply the new credential")
	}
	// The connection pool and TLS configuration must be shared, not rebuilt.
	if updated.http != client.http {
		t.Error("WithCredentials rebuilt the HTTP client, discarding the connection pool")
	}
}
