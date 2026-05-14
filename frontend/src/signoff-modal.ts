// Shared sign-off modal — used by both Save (merge) and Revert. Each
// call site supplies its own DOM ids and a `submit` handler; the factory
// owns the sign-off-required gate, loading state, conflict handling, and
// error display.

import { SessionConflictError } from './api.js';
import { getElement } from './types.js';

export interface SignOffRequest {
  sign_off: string;
  message?: string;
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
}

export interface SignOffModalOptions {
  ids: SignOffModalIds;
  submit: (req: SignOffRequest) => Promise<void>;
  onConflict: (err: SessionConflictError) => void;
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

  const setLoading = (loading: boolean): void => {
    confirmBtn.classList.toggle('loading', loading);
    confirmBtn.disabled = loading || signoff.value.trim() === '';
    cancelBtn.disabled = loading;
    closeBtn.disabled = loading;
    signoff.disabled = loading;
    description.disabled = loading;
  };

  if (ids.title && opts.title !== undefined) {
    getElement(ids.title).textContent = opts.title;
  }
  signoff.value = '';
  description.value = '';
  errorEl.textContent = '';
  errorEl.hidden = true;
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
    const req: SignOffRequest = desc === ''
      ? { sign_off: text }
      : { sign_off: text, message: desc };
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
      if (err instanceof SessionConflictError) {
        modal.hidden = true;
        active = null;
        opt.onConflict(err);
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
