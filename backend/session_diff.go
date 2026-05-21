package main

import (
	"bytes"
	"encoding/json"
)

// session_diff.go shrinks session_ops journal payloads from full-row snapshots
// to column-level diffs. The on-disk shape of after_json (and before_json) for
// 'update' ops becomes a partial JSON object containing only keys whose values
// actually changed. Inserts (after_json) and deletes (before_json) still carry
// full rows because there is no other side to diff against.
//
// The overlay path reconstructs full-row JSON at session-load time by merging
// the partial after_json onto the live main row, so downstream readers
// (mergeOverlay, currentEntity, derived_window's applyEntityOverlay) keep
// seeing the full struct shape they always have. Only storage shrinks.

// diffIgnoredKeys lists JSON keys that columnDiff drops before comparing.
// `updated_at` is bumped unconditionally on every write path (handler-level
// AND apply-side via SET updated_at=NOW()), so including it would defeat the
// no-op skip — every reassertion of a row would still produce a diff with
// just the timestamp moving. The apply path bumps it from NOW() anyway, so
// dropping it from the journal is lossless.
var diffIgnoredKeys = map[string]struct{}{
	"updated_at": {},
}

// columnDiff returns the minimal pair (beforeDiff, afterDiff) of JSON objects
// containing exactly the keys whose RawMessage bytes differ between before
// and after, excluding any keys in diffIgnoredKeys. Returns (nil, nil) when
// the inputs are equal (no-op skip).
//
// Both inputs are expected to be full-row JSON objects produced by
// jsonMust(typedStruct) — that guarantees canonical, field-ordered byte form,
// so byte-comparing RawMessage values for equality is sufficient.
//
// On a malformed input we fall back to the original full payload rather than
// silently lose data; this should never happen for entity rows but is a cheap
// safety net.
func columnDiff(before, after []byte) (beforeDiff, afterDiff []byte) {
	if bytes.Equal(before, after) {
		return nil, nil
	}
	var beforeMap, afterMap map[string]json.RawMessage
	if err := json.Unmarshal(before, &beforeMap); err != nil {
		return before, after
	}
	if err := json.Unmarshal(after, &afterMap); err != nil {
		return before, after
	}
	beforeOut := map[string]json.RawMessage{}
	afterOut := map[string]json.RawMessage{}
	for k, bv := range beforeMap {
		if _, ignored := diffIgnoredKeys[k]; ignored {
			continue
		}
		av, present := afterMap[k]
		if !present || !bytes.Equal(bv, av) {
			beforeOut[k] = bv
			afterOut[k] = av
		}
	}
	for k, av := range afterMap {
		if _, ignored := diffIgnoredKeys[k]; ignored {
			continue
		}
		if _, seen := beforeMap[k]; seen {
			continue
		}
		beforeOut[k] = nil
		afterOut[k] = av
	}
	if len(beforeOut) == 0 && len(afterOut) == 0 {
		return nil, nil
	}
	return jsonMust(beforeOut), jsonMust(afterOut)
}

// coalesceUpdateDiff merges two successive partial diffs on the same entity
// into a single equivalent diff. The BEFORE side keeps the earliest value
// per column (existing wins on collisions); the AFTER side keeps the latest
// value per column (new wins on collisions). Columns that end up with the
// same before and after byte values drop out entirely, so a session that
// moves a column out and back leaves no journal trace.
//
// Returns (nil, nil) when the net diff is empty.
func coalesceUpdateDiff(existingBefore, existingAfter, newBefore, newAfter []byte) (mergedBefore, mergedAfter []byte) {
	beforeMap := unmarshalDiffMap(existingBefore)
	afterMap := unmarshalDiffMap(existingAfter)
	for k, v := range unmarshalDiffMap(newBefore) {
		if _, exists := beforeMap[k]; !exists {
			beforeMap[k] = v
		}
	}
	for k, v := range unmarshalDiffMap(newAfter) {
		afterMap[k] = v
	}
	dropEqualKeys(beforeMap, afterMap)
	if len(beforeMap) == 0 && len(afterMap) == 0 {
		return nil, nil
	}
	return jsonMust(beforeMap), jsonMust(afterMap)
}

// trimColumnDiffToChanged drops keys from the diff pair where before and
// after values are byte-identical. Useful when constructing a diff from two
// independently-built JSON slices (e.g., revertToBefore's plan), without
// the full coalesce semantics.
func trimColumnDiffToChanged(before, after []byte) (beforeOut, afterOut []byte) {
	beforeMap := unmarshalDiffMap(before)
	afterMap := unmarshalDiffMap(after)
	dropEqualKeys(beforeMap, afterMap)
	if len(beforeMap) == 0 && len(afterMap) == 0 {
		return nil, nil
	}
	return jsonMust(beforeMap), jsonMust(afterMap)
}

func dropEqualKeys(before, after map[string]json.RawMessage) {
	for k, bv := range before {
		if av, ok := after[k]; ok && bytes.Equal(bv, av) {
			delete(before, k)
			delete(after, k)
		}
	}
}

func unmarshalDiffMap(b []byte) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if len(b) == 0 {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

// sliceColumns returns a JSON object containing exactly the keys in `keys`,
// pulled from the full-row JSON `full`. Keys missing from `full` are absent
// from the result (not encoded as null). Used by revertToBefore to build the
// `before` half of a column-level revert plan op from the live main row.
func sliceColumns(full []byte, keys map[string]json.RawMessage) []byte {
	if len(full) == 0 || len(keys) == 0 {
		return nil
	}
	var fullMap map[string]json.RawMessage
	if err := json.Unmarshal(full, &fullMap); err != nil {
		return nil
	}
	out := map[string]json.RawMessage{}
	for k := range keys {
		if v, ok := fullMap[k]; ok {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return jsonMust(out)
}

// mergeFullRowWithDiff overlays a partial column diff onto a full-row JSON.
func mergeFullRowWithDiff(full, diff []byte) []byte {
	if len(diff) == 0 {
		return full
	}
	if len(full) == 0 {
		return diff
	}
	var fullMap, diffMap map[string]json.RawMessage
	if err := json.Unmarshal(full, &fullMap); err != nil {
		return full
	}
	if err := json.Unmarshal(diff, &diffMap); err != nil {
		return full
	}
	for k, v := range diffMap {
		fullMap[k] = v
	}
	return jsonMust(fullMap)
}
