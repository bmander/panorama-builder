package main

import (
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
	"net/http"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WebP decoder for image.Decode
)

// Medium-resolution preview cap. The frontend asks for a fast first paint
// during station hydrate and fly-tweens; the full-res blob loads after.
const previewMaxWidth = 1200
const previewJPEGQuality = 82

// getBlobPreview serves a lazily-generated, max-1200-px-wide JPEG derived
// from blobs/<hash>. The variant is pure cache: deterministic from the
// immutable original, regenerable, never journaled.
func (s *Server) getBlobPreview(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if !blobHashRegexp.MatchString(hash) {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	if f, err := s.blobs.openPreviewByHash(hash); err == nil {
		defer f.Close()
		servePreviewFile(w, r, f)
		return
	}
	if err := s.generatePreview(hash); err != nil {
		writeError(w, err.status, err.msg)
		return
	}
	f, err := s.blobs.openPreviewByHash(hash)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "preview reopen")
		return
	}
	defer f.Close()
	servePreviewFile(w, r, f)
}

func servePreviewFile(w http.ResponseWriter, r *http.Request, f *os.File) {
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stat")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

type previewErr struct {
	status int
	msg    string
}

// generatePreview decodes blobs/<hash>, resizes to previewMaxWidth, encodes
// JPEG, and places it at previews/<hash>. Concurrent slow-path callers each
// produce identical bytes; whichever rename lands first wins.
func (s *Server) generatePreview(hash string) *previewErr {
	src, err := s.blobs.openByHash(hash)
	if err != nil {
		return &previewErr{http.StatusNotFound, "blob missing"}
	}
	defer src.Close()
	// image.Decode dispatches on magic bytes; JPEG, PNG, and WebP decoders
	// are registered via the side-effect imports at the top of this file.
	img, _, err := image.Decode(src)
	if err != nil {
		return &previewErr{http.StatusUnsupportedMediaType, "preview unsupported"}
	}
	out := resizeMaxWidth(img, previewMaxWidth)
	tmp, err := os.CreateTemp(filepath.Join(s.blobs.root, "tmp"), "preview-*")
	if err != nil {
		return &previewErr{http.StatusInternalServerError, "preview tmp"}
	}
	tmpPath := tmp.Name()
	encErr := jpeg.Encode(tmp, out, &jpeg.Options{Quality: previewJPEGQuality})
	closeErr := tmp.Close()
	if encErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		return &previewErr{http.StatusInternalServerError, "preview encode"}
	}
	if _, err := s.blobs.placePreviewAtHash(tmpPath, hash); err != nil {
		_ = os.Remove(tmpPath)
		return &previewErr{http.StatusInternalServerError, "preview place"}
	}
	return nil
}

// resizeMaxWidth returns an image whose width is min(maxW, srcW), preserving
// aspect ratio. Always produces a fresh RGBA so the JPEG encoder gets a
// uniform input regardless of the source's color model.
func resizeMaxWidth(src image.Image, maxW int) image.Image {
	b := src.Bounds()
	srcW, srcH := b.Dx(), b.Dy()
	newW := srcW
	if newW > maxW {
		newW = maxW
	}
	newH := srcH * newW / srcW
	if newH < 1 {
		newH = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.CatmullRom.Scale(dst, dst.Rect, src, b, draw.Over, nil)
	return dst
}
