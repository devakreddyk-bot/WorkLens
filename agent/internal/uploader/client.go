package uploader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/worklens/worklens/agent/internal/signing"
	"github.com/worklens/worklens/agent/internal/store"
)

// Logger is the logging surface the uploader needs.
//
// Declared here rather than importing internal/logging so this package has no dependency on a
// logging implementation — the caller passes whatever it uses, and tests pass a recorder.
type Logger interface {
	Debug(msg string, fields ...any)
	Info(msg string, fields ...any)
	Warn(msg string, fields ...any)
	Error(msg string, fields ...any)
}

// nopLogger is used when no logger is supplied, so the uploader never has to nil-check.
type nopLogger struct{}

func (nopLogger) Debug(string, ...any) {}
func (nopLogger) Info(string, ...any)  {}
func (nopLogger) Warn(string, ...any)  {}
func (nopLogger) Error(string, ...any) {}

// Maximum response body read from the server.
//
// Bounded because an agent must not be made to allocate arbitrary memory by whatever answers on
// the other end of the socket — a captive portal returning a 20 MB login page is the realistic
// case, not an attack.
const maxResponseBytes = 1 << 20

// Options configures a Client.
type Options struct {
	// BaseURL is the API root including the stage, e.g. https://host/v1
	BaseURL string
	// Credentials signs every request. Zero for the enrolment call, which has no secret yet.
	Credentials signing.Credentials
	// Pins is the certificate pin set. Never nil in production; use DisabledPinSet to turn
	// pinning off explicitly.
	Pins *PinSet
	// HTTPClient overrides the constructed client. Tests use this; production leaves it nil so
	// the pinned TLS configuration is applied.
	HTTPClient *http.Client
	// MaxAttempts bounds one upload's retries before the batch is released back to the buffer.
	MaxAttempts int
	// BaseBackoff is the first retry delay; it doubles from there.
	BaseBackoff time.Duration
	// MaxBackoff caps the delay.
	MaxBackoff time.Duration
	// Now and Sleep are injected so retry behaviour is testable without real time passing.
	Now   func() time.Time
	Sleep func(context.Context, time.Duration) error
	// Rand supplies backoff jitter. Injected so a test sees deterministic delays.
	Rand func() float64
	// Logger receives progress and failures.
	Logger Logger
	// UserAgent identifies the agent build to the server, which is what makes "every device on
	// 0.1.3 is failing" a one-line log query.
	UserAgent string
}

// Defaults. Five attempts over roughly 30 seconds of backoff: enough to ride out a Lambda cold
// start or an RDS failover, short enough that the batch returns to the buffer and the next cycle
// tries again rather than one goroutine blocking for minutes.
const (
	DefaultMaxAttempts = 5
	DefaultBaseBackoff = time.Second
	DefaultMaxBackoff  = 5 * time.Minute
)

// Client talks to the device API.
type Client struct {
	baseURL   *url.URL
	basePath  string
	creds     signing.Credentials
	http      *http.Client
	opts      Options
	log       Logger
	userAgent string
}

// NewClient builds a client, applying the pinned TLS configuration unless an HTTP client is
// supplied.
func NewClient(opts Options) (*Client, error) {
	if opts.BaseURL == "" {
		return nil, errors.New("uploader: no base URL")
	}

	parsed, err := url.Parse(strings.TrimRight(opts.BaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("uploader: base URL %q is not a URL: %w", opts.BaseURL, err)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("uploader: base URL %q has no host", opts.BaseURL)
	}

	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = DefaultMaxAttempts
	}
	if opts.BaseBackoff <= 0 {
		opts.BaseBackoff = DefaultBaseBackoff
	}
	if opts.MaxBackoff <= 0 {
		opts.MaxBackoff = DefaultMaxBackoff
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Sleep == nil {
		opts.Sleep = sleepWithContext
	}
	if opts.Rand == nil {
		opts.Rand = rand.Float64
	}
	if opts.Logger == nil {
		opts.Logger = nopLogger{}
	}
	if opts.UserAgent == "" {
		opts.UserAgent = "worklens-agent"
	}

	httpClient := opts.HTTPClient
	if httpClient == nil {
		pins := opts.Pins
		if pins == nil {
			return nil, errors.New(
				"uploader: no pin set. Pass DefaultPins via NewPinSet, or DisabledPinSet() to " +
					"turn pinning off explicitly — a nil pin set would silently accept anything " +
					"the system store trusts")
		}

		transport := &http.Transport{
			TLSClientConfig: pins.TLSConfig(parsed.Hostname()),
			// Modest pool: one agent makes a handful of requests a minute.
			MaxIdleConns:        2,
			MaxConnsPerHost:     4,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 15 * time.Second,
			// A laptop moves between networks constantly; a stale keep-alive to an old gateway
			// otherwise costs a full timeout on the first request after a change.
			DisableKeepAlives: false,
			ForceAttemptHTTP2: true,
		}

		httpClient = &http.Client{
			Transport: transport,
			// Generous: a large batch over hotel wifi is slow but succeeding, and giving up on it
			// only means doing the same work again later.
			Timeout: 60 * time.Second,
		}
	}

	return &Client{
		baseURL:   parsed,
		basePath:  parsed.Path,
		creds:     opts.Credentials,
		http:      httpClient,
		opts:      opts,
		log:       opts.Logger,
		userAgent: opts.UserAgent,
	}, nil
}

// WithCredentials returns a copy of the client that signs with the given credential.
//
// Used after enrolment, so the enrolling client (which has no secret) does not have to be rebuilt
// along with its TLS configuration and connection pool.
func (c *Client) WithCredentials(creds signing.Credentials) *Client {
	clone := *c
	clone.creds = creds
	return &clone
}

// APIError is a structured error response from the server.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	RequestID  string
	// RetryAfter is the server's requested delay, from the Retry-After header.
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.RequestID != "" {
		return fmt.Sprintf("uploader: %s (HTTP %d, code %s, request %s)",
			e.Message, e.StatusCode, e.Code, e.RequestID)
	}
	return fmt.Sprintf("uploader: %s (HTTP %d, code %s)", e.Message, e.StatusCode, e.Code)
}

// Error codes the agent reacts to differently from a generic failure. They mirror
// backend/src/shared/errors.ts.
const (
	CodeDeviceRevoked          = "DEVICE_REVOKED"
	CodeTimestampOutOfWindow   = "TIMESTAMP_OUT_OF_WINDOW"
	CodeReplayedRequest        = "REPLAYED_REQUEST"
	CodeInvalidSignature       = "INVALID_SIGNATURE"
	CodeQuotaExceeded          = "QUOTA_EXCEEDED"
	CodeFeatureDisabled        = "FEATURE_DISABLED"
	CodeEnrollmentTokenUsed    = "ENROLLMENT_TOKEN_USED"
	CodeEnrollmentTokenExpired = "ENROLLMENT_TOKEN_EXPIRED"
	CodeValidationFailed       = "VALIDATION_FAILED"
)

// Revoked reports whether the device has been revoked, which the agent treats as terminal: it
// stops capturing and says so in the tray, rather than retrying a credential that will never work
// again.
func (e *APIError) Revoked() bool { return e.Code == CodeDeviceRevoked }

// ClockSkew reports whether the failure was a rejected timestamp, which is a support problem
// (the laptop's clock is wrong) rather than an authentication failure. `agentctl doctor` reports
// it as such.
func (e *APIError) ClockSkew() bool { return e.Code == CodeTimestampOutOfWindow }

// Retryable reports whether another attempt could plausibly succeed.
//
// The distinction matters because retrying a permanent failure wastes battery and fills logs,
// while giving up on a transient one loses data. The rules:
//
//   - 5xx and 429: retry. The server said so, or is briefly unwell.
//   - 408 and 425: retry. Both are explicitly "try again".
//   - 401/403: do NOT retry, with one exception. A revoked device or a bad signature will fail
//     identically forever. A rejected *timestamp* is different: it is retried, because the clock
//     may be corrected by NTP between attempts.
//   - 4xx otherwise: do not retry. A malformed batch is malformed on the next attempt too.
func (e *APIError) Retryable() bool {
	if e.Code == CodeTimestampOutOfWindow {
		return true
	}
	if e.Revoked() {
		return false
	}

	switch {
	case e.StatusCode >= 500:
		return true
	case e.StatusCode == http.StatusTooManyRequests,
		e.StatusCode == http.StatusRequestTimeout,
		e.StatusCode == http.StatusTooEarly:
		return true
	default:
		return false
	}
}

// retryableNetworkError reports whether a transport-level failure is worth another attempt.
//
// Almost all of them are: a laptop's network is unreliable by nature. The exception is a pin
// mismatch, which is a deliberate security refusal — retrying it would hammer the endpoint while
// never succeeding, and would obscure the actual problem in the logs.
func retryableNetworkError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrPinMismatch) {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	// A TLS or DNS failure arrives as an opaque *url.Error; treat it as transient, because a
	// captive portal produces exactly this and clears up when the user signs in.
	var urlErr *url.Error
	return errors.As(err, &urlErr)
}

// doSigned performs one signed request with retries.
//
// The nonce is regenerated on every attempt, deliberately. Reusing it would make the second
// attempt look like a replay to the server and be rejected — which is precisely the bug that
// would turn a single network blip into permanently stuck data.
func (c *Client) doSigned(ctx context.Context, method, path string, payload any, extraHeaders map[string]string) ([]byte, error) {
	var body []byte
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("uploader: could not encode the request body: %w", err)
		}
		body = encoded
	}

	var lastErr error

	for attempt := 1; attempt <= c.opts.MaxAttempts; attempt++ {
		responseBody, err := c.attempt(ctx, method, path, body, extraHeaders)
		if err == nil {
			return responseBody, nil
		}
		lastErr = err

		// A cancelled context means the agent is shutting down; stop immediately rather than
		// sleeping through a shutdown the user asked for.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		var apiErr *APIError
		switch {
		case errors.As(err, &apiErr):
			if !apiErr.Retryable() {
				return nil, err
			}
		case retryableNetworkError(err):
			// Retry.
		default:
			return nil, err
		}

		if attempt == c.opts.MaxAttempts {
			break
		}

		delay := c.backoff(attempt)
		// The server's Retry-After wins when it is longer: it knows more than the agent about
		// when it will be ready, and ignoring it turns a rate limit into a hammering loop.
		if apiErr != nil && apiErr.RetryAfter > delay {
			delay = apiErr.RetryAfter
		}

		c.log.Warn("upload attempt failed, retrying",
			"attempt", attempt, "of", c.opts.MaxAttempts, "delay", delay.String(), "error", err.Error())

		if err := c.opts.Sleep(ctx, delay); err != nil {
			return nil, err
		}
	}

	return nil, fmt.Errorf("uploader: gave up after %d attempts: %w", c.opts.MaxAttempts, lastErr)
}

// attempt performs exactly one request.
func (c *Client) attempt(ctx context.Context, method, path string, body []byte, extraHeaders map[string]string) ([]byte, error) {
	// The signature covers the path as the server sees it, which is the stage-relative path —
	// including the stage prefix from the base URL, because API Gateway reports event.path that
	// way. Getting this wrong produces a signature mismatch on every request, so it is derived in
	// exactly one place.
	signedPath := c.basePath + path

	request, err := http.NewRequestWithContext(ctx, method, c.baseURL.String()+path, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("uploader: could not build the request: %w", err)
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", c.userAgent)
	for name, value := range extraHeaders {
		request.Header.Set(name, value)
	}

	// Unsigned only for enrolment, which has no secret yet.
	if c.creds.DeviceID != "" && c.creds.Secret != "" {
		headers, err := signing.Headers(c.creds, method, signedPath, body, c.opts.Now())
		if err != nil {
			return nil, err
		}
		for name, value := range headers {
			request.Header.Set(name, value)
		}
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() {
		// Drain before closing so the connection can be reused. Without this, every request
		// opens a new TLS connection, which on a metered link is a real cost.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		_ = response.Body.Close()
	}()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("uploader: could not read the response: %w", err)
	}

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return responseBody, nil
	}

	return nil, parseAPIError(response, responseBody)
}

// parseAPIError turns a non-2xx response into an APIError.
func parseAPIError(response *http.Response, body []byte) *APIError {
	apiErr := &APIError{
		StatusCode: response.StatusCode,
		Code:       "UNKNOWN",
		Message:    strings.TrimSpace(http.StatusText(response.StatusCode)),
		RetryAfter: parseRetryAfter(response.Header.Get("Retry-After")),
	}

	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		apiErr.Code = envelope.Error.Code
		apiErr.Message = envelope.Error.Message
		apiErr.RequestID = envelope.Error.RequestID
	} else if len(body) > 0 {
		// A gateway, a proxy or a captive portal answered instead of the API. Keep a short
		// excerpt: enough to recognise an HTML login page, not enough to fill the log.
		excerpt := strings.TrimSpace(string(body))
		if len(excerpt) > 200 {
			excerpt = excerpt[:200] + "…"
		}
		if excerpt != "" {
			apiErr.Message = fmt.Sprintf("%s: %s", apiErr.Message, excerpt)
		}
	}

	return apiErr
}

// parseRetryAfter accepts both forms the header may take: delta-seconds and an HTTP date.
func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}

	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}

	if when, err := http.ParseTime(value); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return 0
}

// backoff returns the delay before the given attempt's retry.
//
// Exponential with full jitter. The jitter is not decoration: an entire office's agents come back
// at the same moment after a wifi outage, and identical backoff would have all of them retry in
// the same instant, repeatedly. Full jitter spreads them across the window.
func (c *Client) backoff(attempt int) time.Duration {
	exponent := math.Pow(2, float64(attempt-1))
	delay := time.Duration(float64(c.opts.BaseBackoff) * exponent)
	if delay > c.opts.MaxBackoff || delay <= 0 {
		delay = c.opts.MaxBackoff
	}
	jittered := time.Duration(c.opts.Rand() * float64(delay))
	// Never zero: a zero delay is a busy loop.
	if jittered < time.Millisecond {
		jittered = time.Millisecond
	}
	return jittered
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// EnrollRequest is the body of POST /v1/device/enroll.
type EnrollRequest struct {
	Token              string `json:"token"`
	Hostname           string `json:"hostname"`
	OS                 string `json:"os"`
	OSVersion          string `json:"os_version"`
	AgentVersion       string `json:"agent_version"`
	MachineFingerprint string `json:"machine_fingerprint"`
}

// EnrollResponse is what the server returns on successful enrolment. The secret appears here and
// nowhere else: it is written straight to credentials.json and never logged.
type EnrollResponse struct {
	DeviceID      string          `json:"device_id"`
	DeviceSecret  string          `json:"device_secret"`
	OrgID         string          `json:"org_id"`
	EmployeeID    string          `json:"employee_id"`
	KeyVersion    int             `json:"key_version"`
	ConfigVersion int             `json:"config_version"`
	Config        json.RawMessage `json:"config"`
}

// Enroll consumes a single-use enrolment token.
func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (EnrollResponse, error) {
	body, err := c.doSigned(ctx, http.MethodPost, "/device/enroll", req, nil)
	if err != nil {
		return EnrollResponse{}, err
	}

	var response EnrollResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return EnrollResponse{}, fmt.Errorf("uploader: enrolment response was not valid JSON: %w", err)
	}
	if response.DeviceID == "" || response.DeviceSecret == "" {
		return EnrollResponse{}, errors.New("uploader: enrolment response contained no credential")
	}
	return response, nil
}

// FetchConfig returns the organisation's monitoring configuration as raw JSON.
//
// Raw so this package does not depend on internal/config, which would make the dependency cycle
// config → uploader → config. The caller unmarshals it.
func (c *Client) FetchConfig(ctx context.Context) (json.RawMessage, error) {
	body, err := c.doSigned(ctx, http.MethodGet, "/device/config", nil, nil)
	if err != nil {
		return nil, err
	}
	return body, nil
}

// eventPayload is one activity event on the wire. Field names match the ingest schema.
type eventPayload struct {
	ClientEventID   string  `json:"client_event_id"`
	EventType       string  `json:"event_type"`
	CapturedAt      string  `json:"captured_at"`
	DurationSeconds int     `json:"duration_seconds"`
	IsIdle          bool    `json:"is_idle"`
	AppName         *string `json:"app_name,omitempty"`
	AppExe          *string `json:"app_exe,omitempty"`
	WindowTitle     *string `json:"window_title,omitempty"`
	URLHost         *string `json:"url_host,omitempty"`
	URLTitle        *string `json:"url_title,omitempty"`
	Detail          *string `json:"detail,omitempty"`
}

type ingestRequest struct {
	Events []eventPayload `json:"events"`
}

// IngestResult is the server's answer to an event batch.
type IngestResult struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	// Duplicate is true when the whole batch was already processed — the server recognised the
	// idempotency key. The agent deletes its local copy on this exactly as it would on a fresh
	// accept, which is what makes a retry after a timeout free.
	Duplicate bool `json:"duplicate"`
}

// IdempotencyKey derives the batch key from the events it contains.
//
// sha256 over the sorted client event ids. Sorted so the key does not depend on the order the
// buffer happened to return rows in: a retry that claims the same events in a different order
// must produce the same key, or the server treats it as a new batch and the deduplication does
// nothing.
func IdempotencyKey(events []store.Event) string {
	ids := make([]string, 0, len(events))
	for _, event := range events {
		ids = append(ids, event.ClientEventID)
	}
	sort.Strings(ids)

	digest := sha256.New()
	for _, id := range ids {
		digest.Write([]byte(id))
		// A separator, so that ["ab","c"] and ["a","bc"] cannot hash identically.
		digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// UploadEvents sends a batch of buffered events.
func (c *Client) UploadEvents(ctx context.Context, events []store.Event) (IngestResult, error) {
	if len(events) == 0 {
		return IngestResult{}, nil
	}

	payload := ingestRequest{Events: make([]eventPayload, 0, len(events))}
	for _, event := range events {
		payload.Events = append(payload.Events, toPayload(event))
	}

	headers := map[string]string{"Idempotency-Key": IdempotencyKey(events)}

	body, err := c.doSigned(ctx, http.MethodPost, "/device/events", payload, headers)
	if err != nil {
		return IngestResult{}, err
	}

	var result IngestResult
	if err := json.Unmarshal(body, &result); err != nil {
		return IngestResult{}, fmt.Errorf("uploader: ingest response was not valid JSON: %w", err)
	}
	return result, nil
}

// toPayload converts a buffered event to its wire form.
//
// Empty strings become omitted fields rather than "", because the server distinguishes "no
// application" from "an application named the empty string", and its idle-attribution CHECK is
// written against NULL.
func toPayload(event store.Event) eventPayload {
	payload := eventPayload{
		ClientEventID:   event.ClientEventID,
		EventType:       string(event.Type),
		CapturedAt:      event.CapturedAt.UTC().Format(time.RFC3339Nano),
		DurationSeconds: int(event.Duration.Seconds()),
		IsIdle:          event.IsIdle,
	}

	payload.AppName = optional(event.AppName)
	payload.AppExe = optional(event.AppExe)
	payload.WindowTitle = optional(event.WindowTitle)
	payload.URLHost = optional(event.URLHost)
	payload.URLTitle = optional(event.URLTitle)
	payload.Detail = optional(event.Detail)

	return payload
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// PresignRequest asks for a constrained upload URL for one screenshot.
type PresignRequest struct {
	CapturedAt string `json:"captured_at"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ByteCount  int64  `json:"byte_count"`
	SHA256     string `json:"sha256"`
	Blurred    bool   `json:"blurred"`
}

// PresignResponse carries the URL and the headers that must accompany the PUT.
type PresignResponse struct {
	ScreenshotID string            `json:"screenshot_id"`
	UploadURL    string            `json:"upload_url"`
	S3Key        string            `json:"s3_key"`
	Headers      map[string]string `json:"headers"`
}

// PresignScreenshot requests an upload URL. A FEATURE_DISABLED error means the organisation has
// screenshots switched off, which the caller treats as "discard this image", not as a failure.
func (c *Client) PresignScreenshot(ctx context.Context, req PresignRequest) (PresignResponse, error) {
	body, err := c.doSigned(ctx, http.MethodPost, "/device/screenshots", req, nil)
	if err != nil {
		return PresignResponse{}, err
	}

	var response PresignResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return PresignResponse{}, fmt.Errorf("uploader: presign response was not valid JSON: %w", err)
	}
	if response.UploadURL == "" || response.ScreenshotID == "" {
		return PresignResponse{}, errors.New("uploader: presign response contained no upload URL")
	}
	return response, nil
}

// CompleteScreenshot confirms an upload landed in S3.
func (c *Client) CompleteScreenshot(ctx context.Context, screenshotID string) error {
	_, err := c.doSigned(ctx, http.MethodPost,
		"/device/screenshots/"+url.PathEscape(screenshotID)+"/complete", struct{}{}, nil)
	return err
}

// HeartbeatRequest reports liveness and health.
//
// The counters are validated and logged by the server rather than stored: `devices` has no column
// for them, and inventing one is a schema decision rather than a handler's.
type HeartbeatRequest struct {
	AgentVersion   string `json:"agent_version"`
	BufferedEvents int64  `json:"buffered_events"`
	BufferedBytes  int64  `json:"buffered_bytes"`
	DroppedEvents  int64  `json:"dropped_events"`
	ConfigVersion  int    `json:"config_version"`
}

// Heartbeat reports that the agent is alive, which is what makes "this laptop has not checked in
// since Tuesday" visible on the dashboard.
func (c *Client) Heartbeat(ctx context.Context, req HeartbeatRequest) error {
	_, err := c.doSigned(ctx, http.MethodPost, "/device/heartbeat", req, nil)
	return err
}

// AcknowledgeNotice records that the employee accepted the first-run notice.
//
// No body: a client-supplied timestamp would be self-reported, and this column is the deployer's
// evidence that a person was actually informed.
func (c *Client) AcknowledgeNotice(ctx context.Context) error {
	_, err := c.doSigned(ctx, http.MethodPost, "/device/notice-ack", struct{}{}, nil)
	return err
}

// UploadScreenshotBytes PUTs an image to a presigned URL.
//
// Not signed with the device credential: the URL itself carries the authorisation, and the headers
// the server returned must be applied exactly. The presign constrains Content-Length,
// Content-Type and the SSE-KMS header, so a mismatch here is rejected by S3 — which is the point
// of a constrained presign, and why the headers are passed through rather than reconstructed.
func (c *Client) UploadScreenshotBytes(ctx context.Context, presigned PresignResponse, image io.Reader, size int64) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, presigned.UploadURL, image)
	if err != nil {
		return fmt.Errorf("uploader: could not build the screenshot upload request: %w", err)
	}
	request.ContentLength = size

	for name, value := range presigned.Headers {
		request.Header.Set(name, value)
	}
	if request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", "image/png")
	}

	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("uploader: screenshot upload failed: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		_ = response.Body.Close()
	}()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return &APIError{
			StatusCode: response.StatusCode,
			Code:       "S3_UPLOAD_FAILED",
			Message:    strings.TrimSpace(string(body)),
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After")),
		}
	}
	return nil
}
