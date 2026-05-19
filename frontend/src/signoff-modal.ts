// Shared sign-off modal — used by both Save (merge) and Revert. Each
// call site supplies its own DOM ids and a `submit` handler; the factory
// owns the sign-off-required gate, loading state, conflict handling, and
// error display.
//
// Optional rank-deficiency gate (callers that opt in via the rankWarning
// and allowUnderdetermined ids): when submit throws a
// SessionRankDeficientError, the modal renders the per-entity flagged-axes
// list inline + shows the override checkbox. The next submit forwards
// allow_underdetermined=true on the request.

import type { RankDeficientAxis } from './api.js';
import { SessionConflictError, SessionRankDeficientError } from './api.js';
import { getElement, renderDeficientAxesList } from './types.js';

export interface SignOffRequest {
  sign_off: string;
  message?: string;
  // When the optional rank-deficiency checkbox is opted in via the modal
  // ids and the user has checked it, this carries the override forward.
  allow_underdetermined?: boolean;
}

export interface SignOffModalIds {
  modal: string;
  signoff: string;
  description: string;
  confirm: string;
  cancel: string;
  close: string;
  error: string;
  title?: string;
  // Optional rank-deficiency UI. Both must be supplied together: a div to
  // host the flagged-axes list, and a checkbox the user toggles to override.
  rankWarning?: string;
  allowUnderdetermined?: string;
}

export interface SignOffModalOptions {
  ids: SignOffModalIds;
  submit: (req: SignOffRequest) => Promise<void>;
  // Called when submit throws SessionConflictError (entity-level conflict).
  // Omit for flows whose submit doesn't surface that error type — the modal's
  // default error display handles other errors inline.
  onConflict?: (err: SessionConflictError) => void;
  onSuccess?: () => void;
  // Default true. Set false when the submit handler triggers a page reload
  // and the modal should stay locked until the new document arrives.
  closeOnSuccess?: boolean;
  // Optional dynamic title; written to the element ids.title before showing.
  title?: string;
}

// One latch per modal-id set: listener wiring is idempotent across opens.
const wired = new Set<string>();
let active: SignOffModalOptions | null = null;

export function openSignOffModal(opts: SignOffModalOptions): void {
  active = opts;
  const { ids } = opts;
  const modal = getElement(ids.modal);
  const signoff = getElement<HTMLInputElement>(ids.signoff);
  const description = getElement<HTMLTextAreaElement>(ids.description);
  const confirmBtn = getElement<HTMLButtonElement>(ids.confirm);
  const cancelBtn = getElement<HTMLButtonElement>(ids.cancel);
  const closeBtn = getElement<HTMLButtonElement>(ids.close);
  const errorEl = getElement(ids.error);
  const rankWarningEl = ids.rankWarning ? getElement(ids.rankWarning) : null;
  const allowEl = ids.allowUnderdetermined ? getElement<HTMLInputElement>(ids.allowUnderdetermined) : null;

  const setLoading = (loading: boolean): void => {
    confirmBtn.classList.toggle('loading', loading);
    confirmBtn.disabled = loading || signoff.value.trim() === '';
    cancelBtn.disabled = loading;
    closeBtn.disabled = loading;
    signoff.disabled = loading;
    description.disabled = loading;
    if (allowEl) allowEl.disabled = loading;
  };

  // Renders the deficient-axes list inline. Pre-checks the override so the
  // next click sails through without hunting for the checkbox.
  const renderRankWarning = (axes: readonly RankDeficientAxis[]): void => {
    if (!rankWarningEl || !allowEl) return;
    rankWarningEl.replaceChildren();
    const header = document.createElement('div');
    header.textContent = `${axes.length.toString()} entit${axes.length === 1 ? 'y has' : 'ies have'} poorly-determined axes:`;
    rankWarningEl.append(header, renderDeficientAxesList(axes, 12));
    rankWarningEl.hidden = false;
    allowEl.checked = true;
  };

  if (ids.title && opts.title !== undefined) {
    getElement(ids.title).textContent = opts.title;
  }
  signoff.value = '';
  description.value = '';
  errorEl.textContent = '';
  errorEl.hidden = true;
  if (rankWarningEl) {
    rankWarningEl.replaceChildren();
    rankWarningEl.hidden = true;
  }
  if (allowEl) allowEl.checked = false;
  setLoading(false);

  if (wired.has(ids.modal)) {
    modal.hidden = false;
    signoff.focus();
    return;
  }

  const close = (): void => {
    if (confirmBtn.classList.contains('loading')) return;
    modal.hidden = true;
    active = null;
  };
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  signoff.addEventListener('input', () => {
    confirmBtn.disabled = signoff.value.trim() === '';
  });
  confirmBtn.addEventListener('click', () => {
    const opt = active;
    if (!opt) return;
    const text = signoff.value.trim();
    if (text === '') return;
    const desc = description.value.trim();
    const req: SignOffRequest = { sign_off: text };
    if (desc !== '') req.message = desc;
    if (allowEl?.checked) req.allow_underdetermined = true;
    errorEl.hidden = true;
    errorEl.textContent = '';
    setLoading(true);
    opt.submit(req).then(() => {
      if (opt.closeOnSuccess === false) return;
      modal.hidden = true;
      active = null;
      setLoading(false);
      opt.onSuccess?.();
    }, (err: unknown) => {
      setLoading(false);
      if (err instanceof SessionConflictError && opt.onConflict) {
        modal.hidden = true;
        active = null;
        opt.onConflict(err);
        return;
      }
      if (err instanceof SessionRankDeficientError) {
        // Stay in the modal; render the list + show the override checkbox.
        // User reviews, the checkbox is auto-checked, a second click commits.
        renderRankWarning(err.deficientAxes);
        errorEl.textContent = 'σ above refuse threshold on the listed axes — review and resubmit to override.';
        errorEl.hidden = false;
        return;
      }
      console.error('signoff submit failed:', err);
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    });
  });
  wired.add(ids.modal);

  modal.hidden = false;
  signoff.focus();
}
