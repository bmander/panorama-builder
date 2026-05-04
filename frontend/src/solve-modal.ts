// Index-view "Solve" modal. Shows joint-solver options, runs the SSE
// streaming endpoint when Run is clicked, and renders live per-iteration
// loss progress.

import { getElement } from './types.js';
import * as api from './api.js';

export interface SolveModal {
  open(): void;
}

export interface CreateSolveModalOptions {
  onComplete: (result: api.SolveResult, dryRun: boolean) => void;
}

const LOG_MAX_LINES = 200;

export function createSolveModal(
  { onComplete }: CreateSolveModalOptions,
): SolveModal {
  const modalEl = getElement('solve-modal');
  const closeBtn = getElement<HTMLButtonElement>('solve-close');
  const cancelBtn = getElement<HTMLButtonElement>('solve-cancel');
  const runBtn = getElement<HTMLButtonElement>('solve-run');
  const maxItersEl = getElement<HTMLInputElement>('solve-max-iters');
  const tolEl = getElement<HTMLInputElement>('solve-residual-tol');
  const dryRunEl = getElement<HTMLInputElement>('solve-dry-run');
  const progressEl = getElement('solve-progress');
  const statusEl = getElement('solve-status');
  const barEl = getElement<HTMLProgressElement>('solve-progress-bar');
  const logEl = getElement('solve-log');

  let logLines: string[] = [];

  function setFormDisabled(disabled: boolean): void {
    maxItersEl.disabled = disabled;
    tolEl.disabled = disabled;
    dryRunEl.disabled = disabled;
    runBtn.disabled = disabled;
  }

  function appendLogLine(line: string): void {
    logLines.push(line);
    if (logLines.length > LOG_MAX_LINES) logLines = logLines.slice(-LOG_MAX_LINES);
    logEl.textContent = logLines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function close(): void {
    // Closing mid-stream just hides the modal — the in-flight SSE reader is
    // abandoned and the backend's solve finishes on its own (releasing
    // solveMu when Solve returns).
    modalEl.hidden = true;
    setFormDisabled(false);
    progressEl.hidden = true;
    statusEl.textContent = '';
    logLines = [];
    logEl.textContent = '';
    barEl.value = 0;
  }

  function open(): void {
    progressEl.hidden = true;
    statusEl.textContent = '';
    logLines = [];
    logEl.textContent = '';
    barEl.value = 0;
    setFormDisabled(false);
    modalEl.hidden = false;
    maxItersEl.focus();
  }

  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  runBtn.addEventListener('click', () => {
    if (runBtn.disabled) return;
    const maxIters = parseInt(maxItersEl.value, 10);
    const tol = parseFloat(tolEl.value);
    if (!Number.isFinite(maxIters) || maxIters < 1) { maxItersEl.focus(); return; }
    if (!Number.isFinite(tol) || tol <= 0) { tolEl.focus(); return; }
    const dryRun = dryRunEl.checked;
    const config: api.SolveConfig = {
      max_iters: maxIters,
      residual_tol_rad: tol,
      dry_run: dryRun,
    };

    setFormDisabled(true);
    progressEl.hidden = false;
    statusEl.textContent = 'starting…';
    logLines = [];
    logEl.textContent = '';
    barEl.value = 0;
    barEl.max = maxIters;

    let result: api.SolveResult | null = null;
    let errorMessage: string | null = null;

    api.solveJointStream(config, ev => {
      if (ev.kind === 'iter') {
        barEl.value = ev.iter + 1;
        statusEl.textContent = `iter ${(ev.iter + 1).toString()} / ${maxIters.toString()}  rms ${ev.rms.toExponential(4)}`;
        appendLogLine(`iter ${(ev.iter + 1).toString().padStart(3)}  rms ${ev.rms.toExponential(4)}  ${ev.accepted ? 'accepted' : 'rejected'}`);
      } else if (ev.kind === 'done') {
        result = ev.result;
      } else {
        errorMessage = ev.message;
      }
    }).then(() => {
      setFormDisabled(false);
      if (errorMessage !== null) {
        statusEl.textContent = `error: ${errorMessage}`;
        return;
      }
      if (result === null) {
        statusEl.textContent = 'stream ended without a final event';
        return;
      }
      const r = result;
      const verdict = r.diverged ? 'DIVERGED'
        : r.converged ? 'converged' : 'iters exhausted';
      const summary = `${verdict} after ${r.iterations.toString()} iters; `
        + `rms ${r.initial_residual_rms.toExponential(3)} → ${r.final_residual_rms.toExponential(3)}; `
        + `${r.changes.length.toString()} change${r.changes.length === 1 ? '' : 's'}`
        + (dryRun ? ' (dry run — no writeback)' : '');
      statusEl.textContent = summary;
      appendLogLine(summary);
      if (r.auto_locked_columns && r.auto_locked_columns.length > 0) {
        appendLogLine(`auto-locked: ${r.auto_locked_columns.join(', ')}`);
      }
      onComplete(r, dryRun);
    }, (err: unknown) => {
      setFormDisabled(false);
      statusEl.textContent = `request failed: ${String(err)}`;
      console.error('solve stream failed:', err);
    });
  });

  return { open };
}
