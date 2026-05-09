// URL routing entry point.
//   /                  → index map (createIndexPage).
//   /world?sta=<id>    → station view; sta swaps in place via loadStation.
//   /station/<id>      → legacy; redirected to /world?sta=<id>.
//   /world (no sta)    → redirect to /.

import {
  FOCUS_QUERY_PARAM, ID_RE, INDEX_CP_QUERY_PARAM, INDEX_STATION_QUERY_PARAM,
  getElement, parseStaFromURL,
} from './types.js';
import { mountStationPage } from './station-page.js';
import { mountIndexPage } from './index-page.js';

const LEGACY_STATION_RE = new RegExp(`^/station/(${ID_RE.source.slice(1, -1)})$`);

function focusParam(name: string): string | null {
  const id = new URLSearchParams(location.search).get(name);
  return id && ID_RE.test(id) ? id : null;
}

// Legacy /station/<id> → /world?sta=<id>. replaceState so the browser
// history doesn't grow a redirect entry.
const legacy = LEGACY_STATION_RE.exec(location.pathname);
if (legacy) {
  history.replaceState(null, '', `/world?sta=${legacy[1]!}${location.hash}`);
}

if (location.pathname === '/world') {
  const sta = parseStaFromURL();
  if (sta === null) {
    location.replace('/');
  } else {
    void mountStationPage({
      initialStationId: sta,
      focusImageMeasurementId: focusParam(FOCUS_QUERY_PARAM),
    });
  }
} else {
  // Index mode hides the station-scoped chrome — the upper-right buttons
  // only make sense once a station is loaded.
  getElement('top-right').hidden = true;
  mountIndexPage({
    focusIndexControlPointId: focusParam(INDEX_CP_QUERY_PARAM),
    focusIndexStationId: focusParam(INDEX_STATION_QUERY_PARAM),
  });
}
