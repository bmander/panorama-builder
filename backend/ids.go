package main

import (
	"crypto/rand"
	"encoding/base32"
	"regexp"
)

// 8 random bytes encoded as RFC4648 base32 (no padding, lowercase) → 13 chars.
// 64 bits of entropy is enough for collision-free hobby-scale IDs.
const idLen = 13

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)
var idRegexp = regexp.MustCompile(`^[A-Z2-7]{13}$`)

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand is documented as never failing
	}
	return idEncoding.EncodeToString(b[:])
}

func validID(s string) bool { return idRegexp.MatchString(s) }
