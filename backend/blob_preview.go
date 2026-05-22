package main

import (
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
	"io"
	"net/http"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WebP decoder for image.Decode
)

const previewMaxWidth = 1200
const previewJPEGQuality = 82

func (s *Server) getBlobPreview(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if !blobHashRegexp.MatchString(hash) {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	f, err := s.blobs.openPreviewByHash(hash)
	if err != nil {
		if status, msg := s.makePreview(hash); msg != "" {
			writeError(w, status, msg)
			return
		}
		f, err = s.blobs.openPreviewByHash(hash)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "preview reopen")
			return
		}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stat")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// makePreview returns ("", 0) on success. JPEG sources already within
// previewMaxWidth bypass decode/resize/encode via a byte copy — saves a
// full RGBA buffer for legacy thumbnail uploads.
func (s *Server) makePreview(hash string) (status int, msg string) {
	src, err := s.blobs.openByHash(hash)
	if err != nil {
		return http.StatusNotFound, "blob missing"
	}
	defer src.Close()
	cfg, format, err := image.DecodeConfig(src)
	if err != nil {
		return http.StatusUnsupportedMediaType, "preview unsupported"
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return http.StatusInternalServerError, "preview seek"
	}
	tmp, err := os.CreateTemp(filepath.Join(s.blobs.root, "tmp"), "preview-*")
	if err != nil {
		return http.StatusInternalServerError, "preview tmp"
	}
	tmpPath := tmp.Name()
	var werr error
	if format == "jpeg" && cfg.Width <= previewMaxWidth {
		_, werr = io.Copy(tmp, src)
	} else {
		img, _, derr := image.Decode(src)
		if derr != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return http.StatusUnsupportedMediaType, "preview unsupported"
		}
		werr = jpeg.Encode(tmp, resizeMaxWidth(img, previewMaxWidth), &jpeg.Options{Quality: previewJPEGQuality})
	}
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(tmpPath)
		return http.StatusInternalServerError, "preview encode"
	}
	if _, err := s.blobs.placePreviewAtHash(tmpPath, hash); err != nil {
		os.Remove(tmpPath)
		return http.StatusInternalServerError, "preview place"
	}
	return 0, ""
}

// checkImageDims inspects a just-written blob's header to reject decompression
// bombs before any pixel buffer is allocated downstream (preview path).
// Returns "" on accept; a non-empty message on reject.
//
// Fail-open on DecodeConfig errors: stdlib doesn't decode HEIC/AVIF, and the
// preview path will return 415 for unrecognized formats later. This check
// exists to gate recognized PNG/JPEG/WebP bombs, not to enforce format
// support.
func (s *Server) checkImageDims(hash string) string {
	f, err := s.blobs.openByHash(hash)
	if err != nil {
		return ""
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return ""
	}
	if int64(cfg.Width)*int64(cfg.Height) > s.maxImagePixels {
		return "image too large"
	}
	return ""
}

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
