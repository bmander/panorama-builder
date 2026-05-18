// One-shot migration: convert legacy station.alt / control_point.est_alt
// (entered as height-above-terrain by the pre-MSL frontend) into proper
// metres-above-mean-sea-level by adding the DEM ground elevation at each
// entity's (lat, lng).
//
// Run *once*, before deploying the MSL-aware renderer changes — otherwise
// users see stations rendered at the wrong viewer-Y until they're migrated.
//
// Invocation (from a browser console on the running frontend):
//   import('/build/admin/migrate-alt-msl.js').then(m => m.runMigration())
//
// The script logs each PUT and a final summary; failures don't abort the
// loop. It is intentionally not wired into the regular UI. Delete this file
// after the migration has run on every deployment.

import * as api from '../api.js';
import { sessionStore } from '../session-store.js';
import { fetchCamGroundElev } from '../terrain/tiles.js';

// Matches the terrain module's innermost ring zoom — Terrarium reliably
// serves up to z=14, which gives sub-10m horizontal resolution.
const DEM_ZOOM = 14;
const DEM_SPEC = { zoom: DEM_ZOOM, radiusTiles: 0, stride: 1 };

interface MigrationCounts {
  stationsConsidered: number;
  stationsUpdated: number;
  stationsFailed: number;
  cpsConsidered: number;
  cpsUpdated: number;
  cpsFailed: number;
  cpsSkippedNullAlt: number;
}

export async function runMigration(): Promise<MigrationCounts> {
  const counts: MigrationCounts = {
    stationsConsidered: 0, stationsUpdated: 0, stationsFailed: 0,
    cpsConsidered: 0, cpsUpdated: 0, cpsFailed: 0, cpsSkippedNullAlt: 0,
  };

  await sessionStore.ensureStarted();
  console.log('[migrate-alt-msl] fetching stations…');
  const stations = await api.listStations();
  counts.stationsConsidered = stations.length;
  console.log(`[migrate-alt-msl] ${stations.length} stations to consider`);

  await Promise.all(stations.map(async s => {
    try {
      const ground = await fetchCamGroundElev({ lat: s.lat, lng: s.lng }, DEM_SPEC);
      const newAlt = s.alt + ground;
      console.log(`[migrate-alt-msl] station ${s.id} (${s.name ?? 'unnamed'}): alt ${s.alt.toFixed(2)} → ${newAlt.toFixed(2)} (+${ground.toFixed(2)} m DEM)`);
      await api.updateStation(s.id, { alt: newAlt });
      counts.stationsUpdated++;
    } catch (err) {
      counts.stationsFailed++;
      console.error(`[migrate-alt-msl] station ${s.id} failed:`, err);
    }
  }));

  console.log('[migrate-alt-msl] fetching control points…');
  const cps = await api.listControlPoints();
  counts.cpsConsidered = cps.length;
  console.log(`[migrate-alt-msl] ${cps.length} control points to consider`);

  await Promise.all(cps.map(async cp => {
    if (cp.est_alt === null || cp.est_lat === null || cp.est_lng === null) {
      counts.cpsSkippedNullAlt++;
      return;
    }
    try {
      const ground = await fetchCamGroundElev({ lat: cp.est_lat, lng: cp.est_lng }, DEM_SPEC);
      const newAlt = cp.est_alt + ground;
      console.log(`[migrate-alt-msl] cp ${cp.id} (${cp.description}): est_alt ${cp.est_alt.toFixed(2)} → ${newAlt.toFixed(2)} (+${ground.toFixed(2)} m DEM)`);
      await api.updateControlPoint(cp.id, { est_alt: newAlt });
      counts.cpsUpdated++;
    } catch (err) {
      counts.cpsFailed++;
      console.error(`[migrate-alt-msl] cp ${cp.id} failed:`, err);
    }
  }));

  console.log('[migrate-alt-msl] done:', counts);
  return counts;
}
