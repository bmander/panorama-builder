// Index-view "Solve" modal. Streams the joint solve as SSE so the chart
// fills in per iteration. During a run the user can:
//   - Cancel — abort the fetch; the server detects the disconnect, the
//     solver breaks, no result is delivered.
//   - Stop here — POST to /stop; the solver returns the best iterate so
//     far and emits a "stopped" terminal event.

import { getElement } from './types.js';
import * as api from './api.js';

export interface SolveModal {
  open(): void;
}

export interface CreateSolveModalOptions {
  onComplete: (result: api.SolveResult, dryRun: boolean) => void;
}

interface ChartState {
  iters: number[];
  rms: number[];
  // Y-range tracked in log10 space; expanded as new points push through.
  logMin: number;
  logMax: number;
}

const CHART_PADDING_PX = 24;

export function createSolveModal(
  { onComplete }: CreateSolveModalOptions,
): SolveModal {
  const modalEl = getElement('solve-modal');
  const closeXBtn = getElement<HTMLButtonElement>('solve-close');
  const closeBtn = getElement<HTMLButtonElement>('solve-close-btn');
  const cancelBtn = getElement<HTMLButtonElement>('solve-cancel-btn');
  const stopBtn = getElement<HTMLButtonElement>('solve-stop-btn');
  const runBtn = getElement<HTMLButtonElement>('solve-run');
  const tolEl = getElement<HTMLInputElement>('solve-residual-tol');
  const relImproveTolEl = getElement<HTMLInputElement>('solve-rel-improve-tol');
  const kRegLambdaEl = getElement<HTMLInputElement>('solve-k-reg-lambda');
  const dryRunEl = getElement<HTMLInputElement>('solve-dry-run');
  const progressEl = getElement('solve-progress');
  const statusEl = getElement('solve-status');
  const chartEl = getElement<HTMLCanvasElement>('solve-loss-chart');

  let activeAbort: AbortController | null = null;
  const chart: ChartState = { iters: [], rms: [], logMin: 0, logMax: 0 };

  function setRunning(running: boolean): void {
    tolEl.disabled = running;
    relImproveTolEl.disabled = running;
    kRegLambdaEl.disabled = running;
    dryRunEl.disabled = running;
    runBtn.hidden = running;
    closeBtn.hidden = running;
    cancelBtn.hidden = !running;
    stopBtn.hidden = !running;
  }

  function close(): void {
    // Closing while a run is active aborts it (same as Cancel), preserving
    // the "no writeback" contract.
    activeAbort?.abort();
    activeAbort = null;
    modalEl.hidden = true;
    setRunning(false);
    progressEl.hidden = true;
    statusEl.textContent = '';
  }

  function open(): void {
    progressEl.hidden = true;
    statusEl.textContent = '';
    chart.iters.length = 0;
    chart.rms.length = 0;
    chart.logMin = 0;
    chart.logMax = 0;
    drawChart();
    setRunning(false);
    // Clear the disabled latch left over from the previous run's Stop click.
    stopBtn.disabled = false;
    modalEl.hidden = false;
    tolEl.focus();
  }

  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeXBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  function drawChart(): void {
    // Account for HiDPI: backing-store size is CSS pixels × dpr.
    const dpr = window.devicePixelRatio || 1;
    const cssW = chartEl.clientWidth || 480;
    const cssH = chartEl.clientHeight || 160;
    if (chartEl.width !== Math.round(cssW * dpr) || chartEl.height !== Math.round(cssH * dpr)) {
      chartEl.width = Math.round(cssW * dpr);
      chartEl.height = Math.round(cssH * dpr);
    }
    const ctx = chartEl.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (chart.iters.length < 1) return;
    const x0 = CHART_PADDING_PX;
    const x1 = cssW - 4;
    const y0 = 4;
    const y1 = cssH - 18;
    const N = chart.iters.length;
    // Snap axis decades to integer log boundaries for clean tick labels.
    const logLo = Math.floor(chart.logMin);
    const logHi = Math.ceil(chart.logMax);
    const logSpan = Math.max(0.5, logHi - logLo);
    const xFor = (i: number): number => N <= 1 ? x0 : x0 + (i / (N - 1)) * (x1 - x0);
    const yFor = (logRms: number): number => y0 + ((logHi - logRms) / logSpan) * (y1 - y0);

    // Decade gridlines + labels.
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(200,200,200,0.6)';
    ctx.lineWidth = 1;
    for (let d = logLo; d <= logHi; d++) {
      const y = yFor(d);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.fillText(`1e${d.toString()}`, x0 - 4, y);
    }

    // Iter-count tick at the right edge.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`iter ${(N - 1).toString()}`, x1, y1 + 2);
    ctx.textAlign = 'left';
    ctx.fillText(`iter 0`, x0, y1 + 2);

    // Loss curve.
    ctx.strokeStyle = '#5080ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const x = xFor(chart.iters[k]!);
      const y = yFor(Math.log10(Math.max(chart.rms[k]!, 1e-30)));
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function pushPoint(iter: number, rms: number): void {
    chart.iters.push(iter);
    chart.rms.push(rms);
    const logRms = Math.log10(Math.max(rms, 1e-30));
    if (chart.iters.length === 1) {
      chart.logMin = chart.logMax = logRms;
    } else {
      if (logRms < chart.logMin) chart.logMin = logRms;
      if (logRms > chart.logMax) chart.logMax = logRms;
    }
    drawChart();
  }

  function summarize(result: api.SolveResult, dryRun: boolean, kind: 'done' | 'stopped'): string {
    let verdict: string;
    if (result.diverged) verdict = 'DIVERGED — no writeback';
    else if (kind === 'stopped') verdict = 'stopped (best iterate written back)';
    else if (result.converged) verdict = 'converged';
    else verdict = 'iter cap reached';
    const summary = `${verdict} after ${result.iterations.toString()} iters; `
      + `rms ${result.initial_residual_rms.toExponential(3)} → ${result.final_residual_rms.toExponential(3)}; `
      + `${result.changes.length.toString()} change${result.changes.length === 1 ? '' : 's'}`
      + (dryRun ? ' (dry run — no writeback)' : '');
    return summary;
  }

  runBtn.addEventListener('click', () => {
    if (activeAbort) return;
    const tol = parseFloat(tolEl.value);
    if (!Number.isFinite(tol) || tol <= 0) { tolEl.focus(); return; }
    const relImproveTol = parseFloat(relImproveTolEl.value);
    if (!Number.isFinite(relImproveTol) || relImproveTol <= 0) { relImproveTolEl.focus(); return; }
    // Blank ⇒ omit so the backend default (0.05) applies. Any finite number
    // (including 0 / negative) passes through; the backend interprets 0 as
    // "use default" and negative as "disabled" per its existing contract.
    const kRegRaw = kRegLambdaEl.value.trim();
    let kRegLambda: number | null = null;
    if (kRegRaw !== '') {
      const parsed = parseFloat(kRegRaw);
      if (!Number.isFinite(parsed)) { kRegLambdaEl.focus(); return; }
      kRegLambda = parsed;
    }
    const dryRun = dryRunEl.checked;
    const base: api.SolveConfig = {
      residual_tol_rad: tol,
      rel_improve_tol: relImproveTol,
      dry_run: dryRun,
    };
    if (kRegLambda !== null) base.k_reg_lambda = kRegLambda;

    setRunning(true);
    progressEl.hidden = false;
    statusEl.textContent = 'starting…';
    chart.iters.length = 0;
    chart.rms.length = 0;
    chart.logMin = 0;
    chart.logMax = 0;
    drawChart();

    const abort = new AbortController();
    activeAbort = abort;

    let result: api.SolveResult | null = null;
    let terminalKind: 'done' | 'stopped' | 'cancelled' | 'error' | null = null;
    let errorMessage: string | null = null;

    api.solveJointStream(base, ev => {
      if (ev.kind === 'iter') {
        pushPoint(ev.iter, ev.rms);
        statusEl.textContent = `iter ${(ev.iter + 1).toString()}  rms ${ev.rms.toExponential(4)}`;
      } else if (ev.kind === 'done' || ev.kind === 'stopped') {
        result = ev.result;
        terminalKind = ev.kind;
      } else if (ev.kind === 'cancelled') {
        terminalKind = 'cancelled';
      } else {
        terminalKind = 'error';
        errorMessage = ev.message;
      }
    }, abort.signal).then(() => {
      if (activeAbort === abort) activeAbort = null;
      setRunning(false);
      if (terminalKind === 'cancelled') {
        statusEl.textContent = 'cancelled';
        return;
      }
      if (terminalKind === 'error') {
        statusEl.textContent = `error: ${errorMessage ?? 'unknown'}`;
        return;
      }
      if (!result || (terminalKind !== 'done' && terminalKind !== 'stopped')) {
        statusEl.textContent = 'stream ended without a final event';
        return;
      }
      statusEl.textContent = summarize(result, dryRun, terminalKind);
      onComplete(result, dryRun);
    }, (err: unknown) => {
      if (activeAbort === abort) activeAbort = null;
      setRunning(false);
      statusEl.textContent = `request failed: ${String(err)}`;
      console.error('solve stream failed:', err);
    });
  });

  cancelBtn.addEventListener('click', () => {
    activeAbort?.abort();
  });

  stopBtn.addEventListener('click', () => {
    // Disabled until the server emits a terminal event — the in-flight
    // loop will finish its current iter and break at the next ShouldStop.
    stopBtn.disabled = true;
    api.solveJointStop().catch((err: unknown) => {
      console.error('solve stop failed:', err);
      stopBtn.disabled = false;
    });
  });

  return { open };
}
