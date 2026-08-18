package screenshot

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
)

// pngEncoder is shared across calls so its internal buffers are reused. png.Encoder is
// safe for concurrent use as long as its BufferPool is, and the zero BufferPool is.
var pngEncoder = png.Encoder{
	// Screenshots are large and mostly flat once blurred, which is exactly the case
	// DefaultCompression handles well. BestCompression buys a few percent for several
	// times the CPU, on a machine that belongs to someone trying to work.
	CompressionLevel: png.DefaultCompression,
}

// EncodePNG encodes img as PNG.
//
// PNG rather than JPEG because the screenshots table pins content_type to image/png for
// device uploads and because a lossy codec would add its own artefacts on top of the blur,
// making it impossible to tell from the stored image whether the blur was applied.
func EncodePNG(img image.Image) ([]byte, error) {
	if img == nil {
		return nil, fmt.Errorf("screenshot: encode: nil image")
	}

	var buf bytes.Buffer
	if err := pngEncoder.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("screenshot: encode png: %w", err)
	}
	return buf.Bytes(), nil
}
