// Floating time-filter pane on the index map. A year slider (1855-2026)
// and a date input share one Date state — moving the slider preserves
// the date input's month/day, editing the date input snaps the slider
// to the new year.

import { getElement } from './types.js';

export interface TimeFilter {
  getTime(): Date;
  setVisible(visible: boolean): void;
}

export interface CreateTimeFilterOptions {
  initial: Date;
  onChange: (time: Date) => void;
}

const MIN_YEAR = 1855;
const MAX_YEAR = 2026;

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// `<input type="date">` accepts and emits 'YYYY-MM-DD' in local time.
function dateInputValue(d: Date): string {
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateInputValue(s: string): Date | null {
  // Append T00:00 so the parser uses local time, matching getFullYear() etc.
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampYear(y: number): number {
  if (y < MIN_YEAR) return MIN_YEAR;
  if (y > MAX_YEAR) return MAX_YEAR;
  return y;
}

export function createTimeFilter({ initial, onChange }: CreateTimeFilterOptions): TimeFilter {
  const root = getElement('time-filter');
  const slider = getElement<HTMLInputElement>('time-filter-slider');
  const dateInput = getElement<HTMLInputElement>('time-filter-date');
  const yearReadout = getElement('time-filter-year-readout');

  slider.min = MIN_YEAR.toString();
  slider.max = MAX_YEAR.toString();
  dateInput.min = `${MIN_YEAR.toString()}-01-01`;
  dateInput.max = `${MAX_YEAR.toString()}-12-31`;

  let time = new Date(initial);

  function paint(): void {
    slider.value = clampYear(time.getFullYear()).toString();
    dateInput.value = dateInputValue(time);
    yearReadout.textContent = time.getFullYear().toString();
  }
  paint();

  slider.addEventListener('input', () => {
    const year = parseInt(slider.value, 10);
    if (Number.isNaN(year)) return;
    const next = new Date(time);
    next.setFullYear(year);
    time = next;
    dateInput.value = dateInputValue(time);
    yearReadout.textContent = time.getFullYear().toString();
    onChange(time);
  });

  dateInput.addEventListener('change', () => {
    const parsed = parseDateInputValue(dateInput.value);
    if (!parsed) return;
    time = parsed;
    slider.value = clampYear(time.getFullYear()).toString();
    yearReadout.textContent = time.getFullYear().toString();
    onChange(time);
  });

  return {
    getTime: () => new Date(time),
    setVisible(visible) { root.hidden = !visible; },
  };
}
