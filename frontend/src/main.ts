// URL routing entry point. Each route owns its setup; the only thing main
// has to know is which route the URL points to and how to hide the
// station-scoped chrome on the index page.

import {
  FOCUS_QUERY_PARAM, INDEX_CP_QUERY_PARAM, INDEX_STATION_QUERY_PARAM, getElement,
} from './types.js';
import { mountStationPage } from './station-page.js';
import { mountIndexPage } from './index-page.js';

const ID_RE = /^\/station\/([A-Z2-7]{13})$/;
const FOCUS_RE = /^[A-Z2-7]{13}$/;

function parseStationIdFromURL(): string | null {
  const m = ID_RE.exec(location.pathname);
  return m ? m[1]! : null;
}

function focusParam(name: string): string | null {
  const id = new URLSearchParams(location.search).get(name);
  return id && FOCUS_RE.test(id) ? id : null;
}

const stationId = parseStationIdFromURL();

if (stationId === null) {
  // Index mode hides the station-scoped chrome — the upper-right buttons
  // only make sense once a station is loaded.
  getElement('top-right').hidden = true;
  mountIndexPage({
    focusIndexControlPointId: focusParam(INDEX_CP_QUERY_PARAM),
    focusIndexStationId: focusParam(INDEX_STATION_QUERY_PARAM),
  });
} else {
  void mountStationPage({
    stationId,
    focusImageMeasurementId: focusParam(FOCUS_QUERY_PARAM),
  });
}
