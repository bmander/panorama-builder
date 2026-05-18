// Final composition glue: installs every cross-controller subscription the
// station view needs. Owns no state of its own — pushPose and applyStation
// are passed in by station-page.ts (closures over its top-level controllers).

import type { ApiHydratedStation } from '../api.js';
import type { StationScene } from './scene.js';
import type { StationDataController } from './data-controller.js';
import type { StationRouteState } from './route-state.js';
import type { SundialController } from './sundial-controller.js';

export interface WireStationEventsOptions {
  readonly scene: StationScene;
  readonly data: StationDataController;
  readonly route: StationRouteState;
  readonly sundial: SundialController;
  readonly pushPose: () => void;
  readonly applyStation: (id: string, prefetched?: ApiHydratedStation) => Promise<void>;
}

export function wireStationEvents(opts: WireStationEventsOptions): void {
  const { scene, data, route, sundial, pushPose, applyStation } = opts;
  const { viewer, overlays, worldCamera, baker } = scene;
  const { sync } = data;

  // Overlay mutations: render + bake-dirty + CP-visibility refresh + sync.
  // setCallbacks is attached here (not inside overlays itself) so that sync
  // and data.refreshControlPointColumns are already wired up by the time
  // the first batch fires.
  overlays.setCallbacks({
    onMutate: () => {
      viewer.requestRender();
      baker.markDirty();
      data.refreshControlPointColumns();
      sync.flush();
    },
    onSelectionChange: () => {
      viewer.requestRender();
      data.refreshControlPointColumns();
    },
    onLightMutate: () => {
      viewer.requestRender();
      baker.markDirty();
      sync.flush();
    },
  });

  // Camera-pose fan-out: every world-camera change re-applies the pose
  // snapshot. sundial picks change the gnomon-line + shadow-dot, which the
  // snapshot also carries, so re-apply on picks too.
  worldCamera.subscribe(pushPose);
  sundial.onPicksChange(pushPose);

  // Back/forward navigation. Different station id → full reload; same id →
  // restore the URL's camera params without re-fetching.
  route.onPopState(sta => {
    if (!sta) return;
    if (sta !== route.getStationId()) void applyStation(sta);
    else data.applyCameraFromURL();
  });
}
