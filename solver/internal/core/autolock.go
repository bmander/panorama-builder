package core

import "github.com/bmander/panorama-builder/shared/wire"

// Auto-lock derives per-axis locks from the matched-observation count on the
// owning entity. The rule mirrors backend/frontend exactly so the solver and
// the lock UI agree on what's free. Manual locks are honored on top: the
// effective lock the solver sees is manual_lock OR auto_lock.

// AutoLockThresholds is the minimum matched-observation count required to
// *unlock* each axis. wire.Photo-owned axes use the per-photo count; station-owned
// axes use the station-total count. Below the threshold ⇒ axis is auto-locked.
//
// Keep in sync with frontend/src/auto-lock.ts.
var AutoLockThresholds = struct {
	PhotoAz, PhotoTilt, PhotoRoll int
	SizeRad                       int
	K1, K2                        int
	Lat, Lng, Alt                 int
}{
	PhotoAz:   1,
	PhotoTilt: 1,
	PhotoRoll: 4,
	SizeRad:   2,
	K1:        5,
	K2:        5,
	Lat:       3,
	Lng:       3,
	Alt:       4,
}

// matchedObsCounts walks observations and returns matched-obs counts per
// photo and per station. Every wire.Observation in problem.Observations already
// carries a ControlPointID (the solver only ingests matched rows), so no
// filter is needed here.
func matchedObsCounts(p wire.Problem) (perPhoto, perStation map[string]int) {
	perPhoto = make(map[string]int, len(p.Photos))
	perStation = make(map[string]int, len(p.Stations))
	photoStation := make(map[string]string, len(p.Photos))
	for _, ph := range p.Photos {
		photoStation[ph.ID] = ph.StationID
	}
	for _, o := range p.Observations {
		perPhoto[o.PhotoID]++
		if sid, ok := photoStation[o.PhotoID]; ok {
			perStation[sid]++
		}
	}
	return perPhoto, perStation
}

// stationAutoLock returns the auto-lock flags for a station with `count`
// matched observations.
func stationAutoLock(count int) wire.StationLocks {
	return wire.StationLocks{
		Lat: count < AutoLockThresholds.Lat,
		Lng: count < AutoLockThresholds.Lng,
		Alt: count < AutoLockThresholds.Alt,
	}
}

// photoAutoLock returns the auto-lock flags for a photo with `count` matched
// observations.
func photoAutoLock(count int) wire.PhotoLocks {
	return wire.PhotoLocks{
		PhotoAz:   count < AutoLockThresholds.PhotoAz,
		PhotoTilt: count < AutoLockThresholds.PhotoTilt,
		PhotoRoll: count < AutoLockThresholds.PhotoRoll,
		SizeRad:   count < AutoLockThresholds.SizeRad,
		K1:        count < AutoLockThresholds.K1,
		K2:        count < AutoLockThresholds.K2,
	}
}

// applyAutoLocks ORs auto-lock flags into the locks on problem.Stations and
// problem.Photos. The caller owns whether the input slices were aliased
// (mutate-in-place) or cloned; this function does not allocate new slices —
// see buildContext, which does the cloning before calling here.
func applyAutoLocks(p *wire.Problem) {
	perPhoto, perStation := matchedObsCounts(*p)
	for i := range p.Stations {
		auto := stationAutoLock(perStation[p.Stations[i].ID])
		p.Stations[i].Locks.Lat = p.Stations[i].Locks.Lat || auto.Lat
		p.Stations[i].Locks.Lng = p.Stations[i].Locks.Lng || auto.Lng
		p.Stations[i].Locks.Alt = p.Stations[i].Locks.Alt || auto.Alt
	}
	for i := range p.Photos {
		auto := photoAutoLock(perPhoto[p.Photos[i].ID])
		p.Photos[i].Locks.PhotoAz = p.Photos[i].Locks.PhotoAz || auto.PhotoAz
		p.Photos[i].Locks.PhotoTilt = p.Photos[i].Locks.PhotoTilt || auto.PhotoTilt
		p.Photos[i].Locks.PhotoRoll = p.Photos[i].Locks.PhotoRoll || auto.PhotoRoll
		p.Photos[i].Locks.SizeRad = p.Photos[i].Locks.SizeRad || auto.SizeRad
		p.Photos[i].Locks.K1 = p.Photos[i].Locks.K1 || auto.K1
		p.Photos[i].Locks.K2 = p.Photos[i].Locks.K2 || auto.K2
	}
}
