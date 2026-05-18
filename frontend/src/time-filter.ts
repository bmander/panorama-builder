// Floating dual-handle time-range filter on the index map. Two range
// sliders (start, end) sit on a common track; two date inputs mirror
// them for direct entry. Bounds (min/max) come from the data — the page
// computes them after fetching CPs + stations and pushes them in via
// setBounds.

import { getElement } from './types.js';

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface TimeFilter {
  getRange(): TimeRange;
  // Sets the slider's min/max in epoch ms; clamps the current handles
  // into the new range and re-paints. Safe to call multiple times.
  setBounds(bounds: { minMs: number; maxMs: number }): void;
  setVisible(visible: boolean): void;
}

export interface CreateTimeFilterOptions {
  // Optional initial handle positions. Defaults to the full bounds set
  // via setBounds (i.e., "show everything").
  initialStart?: Date | undefined;
  initialEnd?: Date | undefined;
  onChange: (range: TimeRange) => void;
}

// Slider unit: days since 1855-01-01. Gives day precision while keeping
// the integer space small (~62k for 2026).
const EPOCH_MS = Date.UTC(1855, 0, 1);
const MS_PER_DAY = 86_400_000;

function dayIndex(ms: number): number {
  return Math.round((ms - EPOCH_MS) / MS_PER_DAY);
}

function dayMs(index: number): number {
  return EPOCH_MS + index * MS_PER_DAY;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// `<input type="date">` accepts/emits 'YYYY-MM-DD' in local time.
function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateInputValue(s: string): number | null {
  // Append T00:00 so the parser uses local time, matching getFullYear() etc.
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function createTimeFilter({ initialStart, initialEnd, onChange }: CreateTimeFilterOptions): TimeFilter {
  const root = getElement('time-filter');
  const sliderStart = getElement<HTMLInputElement>('time-filter-slider-start');
  const sliderEnd = getElement<HTMLInputElement>('time-filter-slider-end');
  const dateStart = getElement<HTMLInputElement>('time-filter-start');
  const dateEnd = getElement<HTMLInputElement>('time-filter-end');
  const readout = getElement('time-filter-year-readout');
  // The track + selected-range fill is drawn by the .time-filter-slider
  // container via --start-pct / --end-pct (see styles.css).
  const trackHost = sliderStart.parentElement!;

  let minMs = Date.UTC(1855, 0, 1);
  let maxMs = Date.UTC(2026, 11, 31);
  let startMs = initialStart ? initialStart.getTime() : minMs;
  let endMs = initialEnd ? initialEnd.getTime() : maxMs;

  function clamp(ms: number): number {
    if (ms < minMs) return minMs;
    if (ms > maxMs) return maxMs;
    return ms;
  }

  function paint(): void {
    const minIdx = dayIndex(minMs);
    const maxIdx = dayIndex(maxMs);
    for (const el of [sliderStart, sliderEnd]) {
      el.min = String(minIdx);
      el.max = String(maxIdx);
    }
    sliderStart.value = String(dayIndex(startMs));
    sliderEnd.value = String(dayIndex(endMs));
    dateStart.min = dateInputValue(minMs);
    dateStart.max = dateInputValue(maxMs);
    dateEnd.min = dateInputValue(minMs);
    dateEnd.max = dateInputValue(maxMs);
    dateStart.value = dateInputValue(startMs);
    dateEnd.value = dateInputValue(endMs);
    const yStart = new Date(startMs).getFullYear();
    const yEnd = new Date(endMs).getFullYear();
    readout.textContent = yStart === yEnd ? String(yStart) : `${yStart} – ${yEnd}`;
    const span = maxMs - minMs || 1;
    const startPct = ((startMs - minMs) / span) * 100;
    const endPct = ((endMs - minMs) / span) * 100;
    trackHost.style.setProperty('--start-pct', `${startPct}%`);
    trackHost.style.setProperty('--end-pct', `${endPct}%`);
  }

  function emit(): void {
    onChange({ startMs, endMs });
  }

  sliderStart.addEventListener('input', () => {
    const idx = parseInt(sliderStart.value, 10);
    if (Number.isNaN(idx)) return;
    startMs = clamp(dayMs(idx));
    if (startMs > endMs) startMs = endMs;
    paint();
    emit();
  });

  sliderEnd.addEventListener('input', () => {
    const idx = parseInt(sliderEnd.value, 10);
    if (Number.isNaN(idx)) return;
    endMs = clamp(dayMs(idx));
    if (endMs < startMs) endMs = startMs;
    paint();
    emit();
  });

  dateStart.addEventListener('change', () => {
    const ms = parseDateInputValue(dateStart.value);
    if (ms === null) return;
    startMs = clamp(ms);
    if (startMs > endMs) startMs = endMs;
    paint();
    emit();
  });

  dateEnd.addEventListener('change', () => {
    const ms = parseDateInputValue(dateEnd.value);
    if (ms === null) return;
    endMs = clamp(ms);
    if (endMs < startMs) endMs = startMs;
    paint();
    emit();
  });

  paint();

  return {
    getRange: () => ({ startMs, endMs }),
    setBounds({ minMs: newMin, maxMs: newMax }) {
      minMs = newMin;
      maxMs = newMax > newMin ? newMax : newMin;
      startMs = Math.max(minMs, Math.min(startMs, maxMs));
      endMs = Math.max(minMs, Math.min(endMs, maxMs));
      if (startMs > endMs) startMs = endMs;
      paint();
    },
    setVisible(visible) { root.hidden = !visible; },
  };
}
