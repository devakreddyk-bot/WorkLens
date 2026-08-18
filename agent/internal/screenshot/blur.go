package screenshot

import (
	"image"
	"image/draw"
)

// blurPasses is the number of box-blur passes applied per Blur call.
//
// Three is the standard choice: a single box blur is visibly boxy and leaves hard-edged
// text partially legible, while three successive box blurs approximate a Gaussian closely
// enough that no structure survives (this is the classic result that repeated box
// convolution converges on a Gaussian). Two passes still leave enough edge energy for
// large headings to be read; four costs more and looks the same as three.
const blurPasses = 3

// Blur returns a blurred copy of img using a three-pass box blur of the given radius.
//
// It is implemented here rather than taken from an image library because blur is a
// *privacy control* (docs/PLAN.md deviation D10). A dependency that silently changed
// behaviour — or a wrapper that no-oped on an unexpected pixel format — would ship
// legible, sensitive pixels to the server, and nothing in the system would notice. Seventy
// lines of separable box blur with a variance assertion over a known fixture
// (blur_test.go) is a better trade than an unmaintained dependency.
//
// The result is always a freshly allocated *image.RGBA and never aliases img, including
// when radius <= 0 and no blurring is performed. That matters more than it looks: the
// caller's next step is to encode and queue the image, and if a "blur" call could hand
// back the original buffer then a later in-place edit — or an in-place blur applied twice
// — would operate on the unblurred original.
//
// radius is measured in pixels either side of the centre pixel, so the box is 2*radius+1
// wide. A radius at or beyond the image dimensions is safe: sampling is clamped to the
// image bounds (edge-pixel replication), so no read ever leaves the buffer and the result
// simply converges on a flat average.
func Blur(img image.Image, radius int) *image.RGBA {
	out := toRGBA(img)
	if radius <= 0 {
		// Not an error: screenshot_blur = false is a legitimate configuration, and the
		// copy above is what keeps the contract above true.
		return out
	}

	w := out.Rect.Dx()
	h := out.Rect.Dy()
	if w <= 0 || h <= 0 {
		return out
	}

	// One scratch buffer, reused for all six sub-passes, so a 4K screenshot costs two
	// buffers rather than seven.
	scratch := image.NewRGBA(out.Rect)
	for i := 0; i < blurPasses; i++ {
		boxBlurHorizontal(out, scratch, radius)
		boxBlurVertical(scratch, out, radius)
	}
	return out
}

// toRGBA returns img as a newly allocated *image.RGBA whose bounds start at the origin.
//
// Normalising the origin means every loop below can index from 0 and the stride arithmetic
// has one form. draw.Draw handles the conversion from whatever concrete type the platform
// layer produced (kbinani returns *image.RGBA; a decoded PNG fixture in a test may be
// *image.NRGBA or a paletted image).
func toRGBA(img image.Image) *image.RGBA {
	b := img.Bounds()
	out := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Rect, img, b.Min, draw.Src)
	return out
}

// boxBlurHorizontal averages each pixel with its horizontal neighbours within radius,
// writing into dst. src and dst must have identical bounds and must not be the same image.
//
// The window sum is maintained incrementally — add the pixel entering the window, subtract
// the one leaving it — so the cost is independent of the radius. That is what makes a
// large blur radius on a 4K screenshot affordable on a laptop that is also doing the
// employee's actual work.
func boxBlurHorizontal(src, dst *image.RGBA, radius int) {
	w := src.Rect.Dx()
	h := src.Rect.Dy()
	window := 2*radius + 1

	for y := 0; y < h; y++ {
		rowStart := y * src.Stride

		// Seed the window for x = 0. Indices outside the row clamp to the first or last
		// pixel, which is edge-pixel replication: the alternative (treating outside as
		// black) darkens every border and would leave a visible frame on every screenshot.
		var sumR, sumG, sumB, sumA int
		for i := -radius; i <= radius; i++ {
			o := rowStart + clamp(i, 0, w-1)*4
			sumR += int(src.Pix[o+0])
			sumG += int(src.Pix[o+1])
			sumB += int(src.Pix[o+2])
			sumA += int(src.Pix[o+3])
		}

		for x := 0; x < w; x++ {
			d := y*dst.Stride + x*4
			dst.Pix[d+0] = uint8(sumR / window)
			dst.Pix[d+1] = uint8(sumG / window)
			dst.Pix[d+2] = uint8(sumB / window)
			dst.Pix[d+3] = uint8(sumA / window)

			// Slide: the pixel at x-radius leaves, the pixel at x+radius+1 enters.
			out := rowStart + clamp(x-radius, 0, w-1)*4
			in := rowStart + clamp(x+radius+1, 0, w-1)*4
			sumR += int(src.Pix[in+0]) - int(src.Pix[out+0])
			sumG += int(src.Pix[in+1]) - int(src.Pix[out+1])
			sumB += int(src.Pix[in+2]) - int(src.Pix[out+2])
			sumA += int(src.Pix[in+3]) - int(src.Pix[out+3])
		}
	}
}

// boxBlurVertical is boxBlurHorizontal along the other axis. Two separable one-dimensional
// passes cost O(width*height) instead of the O(width*height*radius^2) a two-dimensional
// kernel would, and produce the same result.
func boxBlurVertical(src, dst *image.RGBA, radius int) {
	w := src.Rect.Dx()
	h := src.Rect.Dy()
	window := 2*radius + 1

	for x := 0; x < w; x++ {
		col := x * 4

		var sumR, sumG, sumB, sumA int
		for i := -radius; i <= radius; i++ {
			o := clamp(i, 0, h-1)*src.Stride + col
			sumR += int(src.Pix[o+0])
			sumG += int(src.Pix[o+1])
			sumB += int(src.Pix[o+2])
			sumA += int(src.Pix[o+3])
		}

		for y := 0; y < h; y++ {
			d := y*dst.Stride + col
			dst.Pix[d+0] = uint8(sumR / window)
			dst.Pix[d+1] = uint8(sumG / window)
			dst.Pix[d+2] = uint8(sumB / window)
			dst.Pix[d+3] = uint8(sumA / window)

			out := clamp(y-radius, 0, h-1)*src.Stride + col
			in := clamp(y+radius+1, 0, h-1)*src.Stride + col
			sumR += int(src.Pix[in+0]) - int(src.Pix[out+0])
			sumG += int(src.Pix[in+1]) - int(src.Pix[out+1])
			sumB += int(src.Pix[in+2]) - int(src.Pix[out+2])
			sumA += int(src.Pix[in+3]) - int(src.Pix[out+3])
		}
	}
}

// clamp restricts v to [lo, hi]. It is the only thing standing between a large radius and
// an out-of-range read, so it is applied to every single sample index above rather than
// only to the loop edges.
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
