// Shared "Solve" modal. Streams a Gauss-Newton solve as SSE so the chart
// fills in per iteration. During a run the user can:
//   - Cancel — abort the fetch; the server detects the disconnect, the
//     solver breaks, no result is delivered.
//   - Stop here — POST to /solve/stop; the solver returns the best iterate
//     so far and emits a "stopped" terminal event.
//
// The streaming endpoint (joint vs. single-station) is selected by the
// SolveRun handle the caller passes to open().

import { getElement } from './types.js';
import * as api from './api.js';
import { sessionStore } from './session-store.js';
import { sessionPending } from './session-pending.js';

// Caller-supplied bridge to a specific streaming endpoint.
export interface SolveRun {
  start: (
    cfg: api.SolveConfig,
    onEvent: (e: api.SolveProgressEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  title: string;
}

export interface SolveModal {
  open(run: SolveRun): void;
}

export interface CreateSolveModalOptions {
  // Fires only on a successful solve that wrote back (i.e. not dry-run, not
  // diverged, not cancelled). The session-pending counter is updated by the
  // modal itself before this is called.
  onComplete: (result: api.SolveResult) => void;
}

interface ChartState {
  iters: number[];
  rms: number[];
  // Y-range tracked in log10 space; expanded as new points push through.
  logMin: number;
  logMax: number;
}

const CHART_PADDING_PX = 24;

// ~2.5s after "Contacting solver…" with no further event ⇒ almost certainly a
// Cloud Run cold start (the solver is scaled to zero and spinning up). A single
// label switch, not a ticking counter.
const COLD_START_MS = 2500;

function stageLabel(ev: { stage: 'load' | 'solve' | 'writeback'; count?: number }): string {
  switch (ev.stage) {
    case 'load': return 'Loading problem…';
    case 'solve': return 'Contacting solver…';
    case 'writeback': {
      const n = ev.count ?? 0;
      return `Writing back ${n.toString()} change${n === 1 ? '' : 's'}…`;
    }
  }
}

export function createSolveModal(
  { onComplete }: CreateSolveModalOptions,
): SolveModal {
  const modalEl = getElement('solve-modal');
  const titleEl = getElement('solve-title');
  const closeXBtn = getElement<HTMLButtonElement>('solve-close');
  const closeBtn = getElement<HTMLButtonElement>('solve-close-btn');
  const cancelBtn = getElement<HTMLButtonElement>('solve-cancel-btn');
  const stopBtn = getElement<HTMLButtonElement>('solve-stop-btn');
  const runBtn = getElement<HTMLButtonElement>('solve-run');
  const functionTolEl = getElement<HTMLInputElement>('solve-function-tol');
  const functionTolReadoutEl = getElement<HTMLOutputElement>('solve-function-tol-readout');
  const stepTolEl = getElement<HTMLInputElement>('solve-step-tol');
  const stepTolReadoutEl = getElement<HTMLOutputElement>('solve-step-tol-readout');
  const kRegLambdaEl = getElement<HTMLInputElement>('solve-k-reg-lambda');
  const kRegLambdaReadoutEl = getElement<HTMLOutputElement>('solve-k-reg-lambda-readout');
  const positionRegLambdaEl = getElement<HTMLInputElement>('solve-position-reg-lambda');
  const positionRegLambdaReadoutEl = getElement<HTMLOutputElement>('solve-position-reg-lambda-readout');
  const dryRunEl = getElement<HTMLInputElement>('solve-dry-run');

  // Slider value is log10(param). Position-prior leftmost = off (sends 0).
  const fromSlider = (s: HTMLInputElement): number => Math.pow(10, parseFloat(s.value));
  const isAtMin = (s: HTMLInputElement): boolean => s.value === s.min;
  const positionRegLambdaValue = (): number =>
    isAtMin(positionRegLambdaEl) ? 0 : fromSlider(positionRegLambdaEl);
  const fmtSci = (v: number): string =>
    v === 0 ? 'off' : v.toExponential(1);

  function wireReadout(s: HTMLInputElement, out: HTMLOutputElement, value: () => number): void {
    const update = (): void => { out.textContent = fmtSci(value()); };
    s.addEventListener('input', update);
    update();
  }
  wireReadout(functionTolEl, functionTolReadoutEl, () => fromSlider(functionTolEl));
  wireReadout(stepTolEl, stepTolReadoutEl, () => fromSlider(stepTolEl));
  wireReadout(kRegLambdaEl, kRegLambdaReadoutEl, () => fromSlider(kRegLambdaEl));
  wireReadout(positionRegLambdaEl, positionRegLambdaReadoutEl, positionRegLambdaValue);
  const progressEl = getElement('solve-progress');
  const statusEl = getElement('solve-status');
  const chartEl = getElement<HTMLCanvasElement>('solve-loss-chart');

  let activeAbort: AbortController | null = null;
  let activeRun: SolveRun | null = null;
  let coldStartTimer: number | null = null;
  const chart: ChartState = { iters: [], rms: [], logMin: 0, logMax: 0 };

  function clearColdStart(): void {
    if (coldStartTimer !== null) {
      clearTimeout(coldStartTimer);
      coldStartTimer = null;
    }
  }

  function setRunning(running: boolean): void {
    functionTolEl.disabled = running;
    stepTolEl.disabled = running;
    kRegLambdaEl.disabled = running;
    positionRegLambdaEl.disabled = running;
    dryRunEl.disabled = running;
    runBtn.hidden = running;
    closeBtn.hidden = running;
    cancelBtn.hidden = !running;
    stopBtn.hidden = !running;
  }

  function close(): void {
    if (activeAbort) {
      if (!confirm('Cancel the running solve?')) return;
      activeAbort.abort();
      activeAbort = null;
    }
    clearColdStart();
    modalEl.hidden = true;
    setRunning(false);
    progressEl.hidden = true;
    statusEl.textContent = '';
  }

  function open(run: SolveRun): void {
    activeRun = run;
    titleEl.textContent = run.title;
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
    functionTolEl.focus();
  }

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
    if (activeAbort || !activeRun) return;
    const run = activeRun;
    const dryRun = dryRunEl.checked;
    const base: api.SolveConfig = {
      function_tol: fromSlider(functionTolEl),
      step_tol: fromSlider(stepTolEl),
      k_reg_lambda: fromSlider(kRegLambdaEl),
      position_reg_lambda: positionRegLambdaValue(),
      dry_run: dryRun,
    };

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

    run.start(base, ev => {
      // Any frame means the solver is responding, so cancel a pending
      // cold-start escalation; only the "solve" stage re-arms it.
      clearColdStart();
      if (ev.kind === 'iter') {
        pushPoint(ev.iter, ev.rms);
        statusEl.textContent = `iter ${(ev.iter + 1).toString()}  rms ${ev.rms.toExponential(4)}`;
      } else if (ev.kind === 'stage') {
        statusEl.textContent = stageLabel(ev);
        if (ev.stage === 'solve') {
          coldStartTimer = window.setTimeout(() => {
            statusEl.textContent = 'Waking solver (cold start)…';
          }, COLD_START_MS);
        }
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
      clearColdStart();
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
      if (!dryRun && !result.diverged) {
        sessionPending.recordSolve(result.changes.length);
        onComplete(result);
        // Also surface the σ gate's verdict directly in the modal so the
        // user sees "found X problems" without having to dismiss it first.
        // Session-panel reads the same endpoint to populate its dropdown.
        const sid = sessionStore.current();
        if (sid !== null) {
          const lockedResult = result;
          api.getSessionRankDeficient(sid).then(axes => {
            if (axes.length > 0) {
              statusEl.textContent = `${summarize(lockedResult, dryRun, 'done')}; ${axes.length.toString()} problem${axes.length === 1 ? '' : 's'} flagged`;
            }
          }, (err: unknown) => {
            console.error('rank-deficient fetch failed:', err);
          });
        }
      }
    }, (err: unknown) => {
      clearColdStart();
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
    api.solveStop().catch((err: unknown) => {
      console.error('solve stop failed:', err);
      stopBtn.disabled = false;
    });
  });

  return { open };
}
