package screenshot

import (
	"errors"
	"image"
	"testing"
)

// Capture itself is not exercised here: on a developer machine it would either prompt for a
// screen-recording permission or silently depend on one, which is not a property a unit test
// should have. The failure paths that actually matter in the field are tested through
// capturePrimary instead.
func TestCapturePrimary(t *testing.T) {
	okBounds := image.Rect(0, 0, 1920, 1080)
	captureErr := errors.New("display driver busy")

	tests := []struct {
		name      string
		displays  int
		bounds    image.Rectangle
		img       *image.RGBA
		captureFn error
		wantErr   error
		wantImage bool
	}{
		{
			name:      "primary display captured",
			displays:  1,
			bounds:    okBounds,
			img:       image.NewRGBA(okBounds),
			wantImage: true,
		},
		{
			name:     "lid closed, no displays at all",
			displays: 0,
			bounds:   okBounds,
			wantErr:  ErrNoDisplay,
		},
		{
			name:     "monitor disconnected between the two queries",
			displays: 1,
			bounds:   image.Rectangle{},
			wantErr:  ErrNoDisplay,
		},
		{
			name:      "capture fails",
			displays:  2,
			bounds:    okBounds,
			captureFn: captureErr,
			wantErr:   captureErr,
		},
		{
			name:     "capture returns nothing without failing",
			displays: 1,
			bounds:   okBounds,
			img:      nil,
			wantErr:  ErrNoDisplay,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			img, err := capturePrimary(
				func() int { return tc.displays },
				func(int) image.Rectangle { return tc.bounds },
				func(image.Rectangle) (*image.RGBA, error) { return tc.img, tc.captureFn },
			)

			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if img != nil {
					t.Error("an image was returned alongside an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantImage && img == nil {
				t.Error("no image returned")
			}
		})
	}
}
