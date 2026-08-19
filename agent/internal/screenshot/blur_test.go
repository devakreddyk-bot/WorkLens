package screenshot

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// checkerboard builds a hard-edged black-and-white fixture: the highest-contrast image that
// can exist at a given cell size, and a reasonable stand-in for what makes a screenshot
// sensitive — sharp edges, which is what text is.
func checkerboard(w, h, cell int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if ((x/cell)+(y/cell))%2 == 0 {
				img.Set(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
			} else {
				img.Set(x, y, color.RGBA{R: 0, G: 0, B: 0, A: 255})
			}
		}
	}
	return img
}

// luminanceVariance is the measure the blur assertion rests on. Variance of luminance is
// how much the image varies from its own average: a page of text has high variance, a flat
// wash has almost none, and a blur that silently did nothing would leave it unchanged.
func luminanceVariance(img *image.RGBA) float64 {
	b := img.Bounds()
	n := float64(b.Dx() * b.Dy())
	if n == 0 {
		return 0
	}

	var sum, sumSq float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			o := img.PixOffset(x, y)
			// Rec. 601 luma, which is what "how bright does this look" means to an eye.
			l := 0.299*float64(img.Pix[o]) + 0.587*float64(img.Pix[o+1]) + 0.114*float64(img.Pix[o+2])
			sum += l
			sumSq += l * l
		}
	}
	mean := sum / n
	return sumSq/n - mean*mean
}

// TestBlurDestroysDetail is the test that matters in this package.
//
// Blur is a privacy control: monitoring_config.screenshot_blur defaults to true, the
// dashboard labels every image with whether it was blurred, and an employee is told that
// with blur on, a screenshot shows what they were working in and not what it said. If Blur
// ever silently no-ops — a refactor that returns early, a pixel format it does not
// understand, a radius that ends up zero — legible, sensitive pixels reach the server and
// nothing else in the system notices. This test makes that failure impossible to ship.
func TestBlurDestroysDetail(t *testing.T) {
	const (
		width  = 256
		height = 256
		cell   = 8
		radius = 12
	)

	src := checkerboard(width, height, cell)
	before := luminanceVariance(src)

	out := Blur(src, radius)
	after := luminanceVariance(out)

	// A hard black/white checkerboard has a luminance variance of ~16,000 (roughly
	// (255/2)^2). The threshold is set at 1% of the measured before-variance: three box
	// passes at a radius larger than the cell size leave a near-uniform grey, and anything
	// that leaves more than 1% of the original variation has left recoverable structure.
	threshold := before * 0.01
	t.Logf("luminance variance: before=%.2f after=%.4f threshold=%.2f (%.4f%% retained)",
		before, after, threshold, 100*after/before)

	if before < 1000 {
		t.Fatalf("fixture is not high-contrast: variance %.2f", before)
	}
	if after >= threshold {
		t.Errorf("blur left too much detail: variance after = %.4f, want < %.2f", after, threshold)
	}
}

// A blur that returned its input unchanged would pass any test that only looked at the
// output's own properties, so this asserts the pixels actually moved.
func TestBlurIsNotTheIdentity(t *testing.T) {
	src := checkerboard(64, 64, 8)
	original := append([]uint8(nil), src.Pix...)

	out := Blur(src, 4)

	if bytes.Equal(out.Pix, original) {
		t.Fatal("Blur returned the input pixels unchanged")
	}
	if !bytes.Equal(src.Pix, original) {
		t.Error("Blur mutated its input; the caller's unblurred image must be left alone")
	}
}

// radius <= 0 means "blur disabled", which must still hand back a private copy: the caller
// goes on to encode and queue this image, and if it aliased the original then a later edit —
// or a second blur applied in place — would act on the unblurred buffer.
func TestBlurWithNonPositiveRadiusReturnsAnIndependentCopy(t *testing.T) {
	for _, radius := range []int{0, -1, -1000} {
		src := checkerboard(32, 32, 4)
		out := Blur(src, radius)

		if out == src {
			t.Fatalf("radius %d: returned the input image itself", radius)
		}
		if !bytes.Equal(out.Pix, src.Pix) {
			t.Errorf("radius %d: pixels were altered, want an exact copy", radius)
		}

		// Prove independence rather than assuming it.
		out.Pix[0] ^= 0xff
		if bytes.Equal(out.Pix, src.Pix) {
			t.Errorf("radius %d: the copy still shares its backing array with the input", radius)
		}
	}
}

// A radius far larger than the image is the case where an unclamped implementation reads
// outside its buffer. It has to converge on a flat average, not panic.
func TestBlurLargeRadiusOnSmallImage(t *testing.T) {
	for _, size := range []int{1, 2, 3, 4, 7} {
		for _, radius := range []int{5, 50, 5000} {
			src := checkerboard(size, size, 1)
			out := Blur(src, radius)

			if out.Rect.Dx() != size || out.Rect.Dy() != size {
				t.Fatalf("size %d radius %d: bounds changed to %v", size, radius, out.Rect)
			}
			if v := luminanceVariance(out); v > 1 {
				t.Errorf("size %d radius %d: variance %.4f, want a near-flat result", size, radius, v)
			}
		}
	}
}

// The platform layer hands over an *image.RGBA, but a fixture read back from disk is often
// *image.NRGBA or paletted. Blur must accept any image.Image rather than only the one shape
// it happens to be given today.
func TestBlurAcceptsOtherImageTypes(t *testing.T) {
	src := checkerboard(48, 48, 6)
	encoded, err := EncodePNG(src)
	if err != nil {
		t.Fatalf("EncodePNG: %v", err)
	}
	decoded, err := png.Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("png.Decode: %v", err)
	}

	before := luminanceVariance(toRGBA(decoded))
	after := luminanceVariance(Blur(decoded, 10))
	t.Logf("decoded fixture variance: before=%.2f after=%.4f", before, after)
	if after >= before*0.01 {
		t.Errorf("variance after = %.4f, want < %.2f", after, before*0.01)
	}
}

// An image whose bounds do not start at the origin (a sub-image, or a display whose bounds
// are offset because it sits to the right of the primary monitor) must blur correctly rather
// than producing a shifted or empty result.
func TestBlurHandlesNonZeroOriginBounds(t *testing.T) {
	full := checkerboard(64, 64, 8)
	sub := full.SubImage(image.Rect(16, 16, 48, 48))

	out := Blur(sub, 16)
	if out.Rect != image.Rect(0, 0, 32, 32) {
		t.Fatalf("bounds = %v, want a 32x32 image at the origin", out.Rect)
	}
	if v := luminanceVariance(out); v >= luminanceVariance(toRGBA(sub))*0.01 {
		t.Errorf("sub-image was not blurred: variance %.4f", v)
	}
}

func TestBlurPreservesOpacity(t *testing.T) {
	src := checkerboard(32, 32, 4)
	out := Blur(src, 5)
	for i := 3; i < len(out.Pix); i += 4 {
		if out.Pix[i] != 255 {
			t.Fatalf("alpha at %d = %d, want 255: a screenshot must stay opaque", i, out.Pix[i])
		}
	}
}

func TestEncodePNGRoundTrip(t *testing.T) {
	src := checkerboard(24, 24, 3)
	encoded, err := EncodePNG(src)
	if err != nil {
		t.Fatalf("EncodePNG: %v", err)
	}
	if len(encoded) == 0 {
		t.Fatal("EncodePNG returned no bytes")
	}

	cfg, err := png.DecodeConfig(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("DecodeConfig: %v", err)
	}
	if cfg.Width != 24 || cfg.Height != 24 {
		t.Errorf("decoded %dx%d, want 24x24", cfg.Width, cfg.Height)
	}
}

func TestEncodePNGRejectsNil(t *testing.T) {
	if _, err := EncodePNG(nil); err == nil {
		t.Fatal("expected an error for a nil image")
	}
}

func BenchmarkBlur1080p(b *testing.B) {
	src := checkerboard(1920, 1080, 16)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Blur(src, 12)
	}
}
