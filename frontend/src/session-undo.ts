// Session-global undo/redo, backed by the server checkpoint stack.
//
// Every undoable action — a manual edit batch or a solver run — is one
// checkpoint on the server, so edits and solves undo the same way. This
// singleton holds the reactive can-undo/can-redo state for the session
// widget, drives the /undo and /redo endpoints, and re-hydrates the page
// afterward (the page registers how via configure()).

import * as api from './api.js';
import { sessionStore, editingActive } from './session-store.js';

export interface SessionUndoConfig {
  // Re-fetch + re-render after the journal changed under us. The same refresh
  // a page already runs after a solve.
  rehydrate: () => Promise<void>;
  reportError: (label: string, err: unknown) => void;
}

export interface SessionUndo {
  canUndo(): boolean;
  canRedo(): boolean;
  busy(): boolean;
  configure(cfg: SessionUndoConfig): void;
  setBusy(busy: boolean): void;
  refresh(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  onChange(handler: () => void): () => void;
}

function create(): SessionUndo {
  let canUndo = false;
  let canRedo = false;
  let busy = false;
  let rehydrate: () => Promise<void> = () => Promise.resolve();
  let report: (label: string, err: unknown) => void = (l, e) => { console.error(`${l}:`, e); };
  const handlers = new Set<() => void>();
  const notify = (): void => { for (const h of handlers) h(); };

  function setState(u: boolean, r: boolean): void {
    if (u === canUndo && r === canRedo) return;
    canUndo = u;
    canRedo = r;
    notify();
  }

  async function refresh(): Promise<void> {
    const sid = sessionStore.current();
    if (sid === null) { setState(false, false); return; }
    try {
      const s = await api.getSession(sid);
      setState(s.can_undo, s.can_redo);
    } catch (err) {
      console.error('undo state refresh failed:', err);
    }
  }

  async function step(dir: 'undo' | 'redo'): Promise<void> {
    const sid = sessionStore.current();
    if (sid === null || busy) return;
    if (dir === 'undo' ? !canUndo : !canRedo) return;
    try {
      const res = dir === 'undo' ? await api.undo(sid) : await api.redo(sid);
      setState(res.can_undo, res.can_redo);
      await rehydrate();
    } catch (err) {
      report(dir, err);
    }
  }

  // Refresh stack state after each batch of writes settles.
  api.onWriteSettled(() => { void refresh(); });

  return {
    canUndo: () => canUndo,
    canRedo: () => canRedo,
    busy: () => busy,
    configure(cfg) { rehydrate = cfg.rehydrate; report = cfg.reportError; },
    setBusy(b) { if (busy !== b) { busy = b; notify(); } },
    refresh,
    undo: () => step('undo'),
    redo: () => step('redo'),
    onChange(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
}

export const sessionUndo: SessionUndo = create();

// attachUndoKeybindings wires Cmd/Ctrl+Z (undo), Shift+Cmd/Ctrl+Z and Ctrl+Y
// (redo) on window. Guarded so it never fires while typing in a field, when no
// session is active, or mid-solve. Safe to call once per page.
export function attachUndoKeybindings(): void {
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!editingActive() || sessionUndo.busy()) return;
    const k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      void (e.shiftKey ? sessionUndo.redo() : sessionUndo.undo());
    } else if (k === 'y') {
      e.preventDefault();
      void sessionUndo.redo();
    }
  });
}
