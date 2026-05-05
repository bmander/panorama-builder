package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Patch holds a JSON object decoded as raw values, so handlers can
// distinguish "key absent" (preserve column) from "key present, value null"
// (clear column to NULL). A *float64 / *string / *time.Time field on a
// generated struct collapses both to nil and can't carry that signal.
type Patch struct{ raw map[string]json.RawMessage }

// nullLiteral is the byte form of a JSON null value (after the decoder
// strips whitespace, RawMessage holds it verbatim).
var nullLiteral = []byte("null")

// parsePatch reads a JSON object body into a Patch. Writes a 400 and
// returns ok=false on malformed input.
func parsePatch(w http.ResponseWriter, r *http.Request) (Patch, bool) {
	var raw map[string]json.RawMessage
	if err := decodeBody(w, r, &raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return Patch{}, false
	}
	return Patch{raw: raw}, true
}

// Has reports whether the key was present in the JSON body.
func (p Patch) Has(key string) bool {
	_, ok := p.raw[key]
	return ok
}

// IsNull reports whether the key was present and explicitly null.
func (p Patch) IsNull(key string) bool {
	v, ok := p.raw[key]
	return ok && bytes.Equal(bytes.TrimSpace(v), nullLiteral)
}

func decodeValue[T any](raw json.RawMessage, key string) (T, error) {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

// Float64 decodes a present, non-null float. Returns present=false if the
// key is absent. Returns an error if present but not a JSON number.
func (p Patch) Float64(key string) (val float64, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return 0, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return 0, true, fmt.Errorf("%s: must not be null", key)
	}
	v, err := decodeValue[float64](raw, key)
	return v, true, err
}

// NullableFloat64 decodes a present float that may be null. Returns
// present=true with val=nil when the key is explicitly null.
func (p Patch) NullableFloat64(key string) (val *float64, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return nil, true, nil
	}
	v, err := decodeValue[float64](raw, key)
	if err != nil {
		return nil, true, err
	}
	return &v, true, nil
}

func (p Patch) String(key string) (val string, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return "", false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return "", true, fmt.Errorf("%s: must not be null", key)
	}
	v, err := decodeValue[string](raw, key)
	return v, true, err
}

func (p Patch) NullableString(key string) (val *string, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return nil, true, nil
	}
	v, err := decodeValue[string](raw, key)
	if err != nil {
		return nil, true, err
	}
	return &v, true, nil
}

func (p Patch) Bool(key string) (val bool, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return false, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return false, true, fmt.Errorf("%s: must not be null", key)
	}
	v, err := decodeValue[bool](raw, key)
	return v, true, err
}

func (p Patch) NullableTime(key string) (val *time.Time, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return nil, true, nil
	}
	v, err := decodeValue[time.Time](raw, key)
	if err != nil {
		return nil, true, err
	}
	return &v, true, nil
}

// NullableID decodes an id-shaped string that may be null. Validates the id
// regex when non-null.
func (p Patch) NullableID(key string) (val *string, present bool, err error) {
	raw, ok := p.raw[key]
	if !ok {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return nil, true, nil
	}
	v, err := decodeValue[string](raw, key)
	if err != nil {
		return nil, true, err
	}
	if !validID(v) {
		return nil, true, fmt.Errorf("%s: invalid id", key)
	}
	return &v, true, nil
}

// UpdateBuilder accumulates SET fragments and positional args for a
// dynamic UPDATE. The id parameter is always $1; SET fragments start at $2.
type UpdateBuilder struct {
	sets []string
	args []any
}

func newUpdateBuilder(id string) *UpdateBuilder {
	return &UpdateBuilder{args: []any{id}}
}

// Set adds `col = $N` and the value, returning the builder for chaining.
func (b *UpdateBuilder) Set(col string, val any) *UpdateBuilder {
	b.args = append(b.args, val)
	b.sets = append(b.sets, fmt.Sprintf("%s = $%d", col, len(b.args)))
	return b
}

// Empty reports whether no SET fragments were added — handlers use this to
// reject a body with no updatable keys.
func (b *UpdateBuilder) Empty() bool { return len(b.sets) == 0 }

// Args returns the positional arg list (id at index 0).
func (b *UpdateBuilder) Args() []any { return b.args }

// Query builds the final SQL string. `table` is the table name; `cols` is
// the canonical RETURNING column list. updated_at is always bumped.
func (b *UpdateBuilder) Query(table, cols string) string {
	parts := append([]string{}, b.sets...)
	parts = append(parts, "updated_at = NOW()")
	return fmt.Sprintf("UPDATE %s SET %s WHERE id = $1 RETURNING %s",
		table, strings.Join(parts, ", "), cols)
}
