// Session panel — a top-right widget that shows the active session, its op
// count, conflicts (if any), and merge / abandon controls. Mounts itself
// into a host element (we slot it into top-right on the station page and
// index-top-right on the index page).
//
// The panel polls session state on focus + after each sync flush; the
// caller can also force a refresh via refresh().

import * as api from './api.js';
import { SessionConflictError } from './api.js';
import type { ApiCommit, ApiEntityRef, ApiSessionState } from './api.js';
import { sessionManager } from './session.js';

export interface SessionPanel {
  refresh(): Promise<void>;
  destroy(): void;
}

const SHORT_ID_LEN = 6;
function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;
}

function fmtRef(r: ApiEntityRef): string {
  return `${r.entity_type}/${shortId(r.entity_id)}`;
}

export function createSessionPanel(host: HTMLElement): SessionPanel {
  const root = document.createElement('div');
  root.className = 'session-panel';
  host.appendChild(root);

  async function refresh(): Promise<void> {
    const state = sessionManager.current() === null
      ? null
      : await sessionManager.refreshState();
    if (state === null) renderEmpty();
    else renderActive(state);
  }

  function renderEmpty(): void {
    root.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'session-empty';
    span.textContent = 'No session';
    root.appendChild(span);
  }

  function renderActive(state: ApiSessionState): void {
    root.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'session-head';
    head.textContent = `Session ${shortId(state.id)} · ${String(state.op_count)} op${state.op_count === 1 ? '' : 's'}`;
    root.appendChild(head);

    if (state.conflicts.length > 0) {
      const c = document.createElement('div');
      c.className = 'session-conflicts';
      c.textContent = `Conflict: ${state.conflicts.map(fmtRef).join(', ')}`;
      root.appendChild(c);
    }

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    if (state.conflicts.length === 0 && state.op_count > 0) {
      const merge = btn('Merge', 'btn');
      merge.addEventListener('click', () => { void onMerge(); });
      actions.appendChild(merge);
    }

    const refreshBtn = btn('Refresh', 'btn');
    refreshBtn.addEventListener('click', () => { void refresh(); });
    actions.appendChild(refreshBtn);

    const abandon = btn('Abandon', 'btn');
    abandon.addEventListener('click', () => { void onAbandon(); });
    actions.appendChild(abandon);

    root.appendChild(actions);
  }

  async function onMerge(): Promise<void> {
    try {
      const ref = await sessionManager.merge();
      alert(`Merged as commit ${shortId(ref.commit_id)} (seq ${String(ref.seq)}).`);
      location.reload();
    } catch (err) {
      if (err instanceof SessionConflictError) {
        const list = err.conflicts.map(fmtRef).join(', ');
        if (confirm(`Merge blocked by conflicts: ${list}\n\nAbandon this session and reload?`)) {
          await sessionManager.abandon();
          location.reload();
        }
        return;
      }
      console.error('merge failed:', err);
      alert(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function onAbandon(): Promise<void> {
    if (!confirm('Discard all session changes?')) return;
    await sessionManager.abandon();
    location.reload();
  }

  // Wire change notifications from the session manager so the panel reacts
  // to merges/abandons triggered elsewhere.
  const off = sessionManager.onChange(() => { void refresh(); });

  // Refresh on window focus too — the user may have made progress in
  // another tab.
  const onFocus = (): void => { void refresh(); };
  window.addEventListener('focus', onFocus);

  void refresh();

  return {
    refresh,
    destroy() {
      off();
      window.removeEventListener('focus', onFocus);
      root.remove();
    },
  };
}

function btn(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

// --- Commit log (rendered inside the same panel area) ---

export interface CommitLog {
  refresh(): Promise<void>;
  destroy(): void;
}

export function createCommitLog(host: HTMLElement): CommitLog {
  const root = document.createElement('div');
  root.className = 'commit-log';
  host.appendChild(root);

  async function refresh(): Promise<void> {
    let commits: ApiCommit[] = [];
    try {
      commits = await api.listCommits();
    } catch (err) {
      console.error('listCommits failed:', err);
    }
    root.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'commit-log-title';
    title.textContent = 'History';
    root.appendChild(title);
    if (commits.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'commit-log-empty';
      empty.textContent = '(no commits yet)';
      root.appendChild(empty);
      return;
    }
    for (const c of commits) {
      const row = document.createElement('div');
      row.className = 'commit-row';
      const txt = document.createElement('span');
      const msg = c.message ?? '';
      txt.textContent = `#${String(c.seq)} ${c.kind} ${shortId(c.id)}${msg ? ` — ${msg}` : ''}`;
      row.appendChild(txt);
      const revertBtn = btn('Revert', 'btn');
      revertBtn.addEventListener('click', () => { void onRevert(c); });
      row.appendChild(revertBtn);
      root.appendChild(row);
    }
  }

  async function onRevert(c: ApiCommit): Promise<void> {
    if (!confirm(`Revert commit ${shortId(c.id)}?`)) return;
    try {
      const ref = await api.revertCommit(c.id);
      alert(`Reverted as commit ${shortId(ref.commit_id)} (seq ${String(ref.seq)}).`);
      location.reload();
    } catch (err) {
      if (err instanceof SessionConflictError) {
        alert(`Revert blocked by conflicts: ${err.conflicts.map(fmtRef).join(', ')}`);
        return;
      }
      alert(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  void refresh();

  return {
    refresh,
    destroy() { root.remove(); },
  };
}
