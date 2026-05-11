// Compact session badge in the top-right that toggles a popover with the
// current session's info, merge/abandon controls, and a link to /history.
// The commit log lives on its own page now (history-page.ts).

import { SessionConflictError } from './api.js';
import type { ApiEntityRef, ApiSessionState } from './api.js';
import { sessionManager } from './session.js';

export interface SessionPanel {
  refresh(): Promise<void>;
  destroy(): void;
}

const SHORT_ID_LEN = 6;
const shortId = (id: string): string =>
  id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;

const fmtRef = (r: ApiEntityRef): string =>
  `${r.entity_type}/${shortId(r.entity_id)}`;

export function createSessionPanel(host: HTMLElement): SessionPanel {
  const root = document.createElement('div');
  root.className = 'session-panel';
  host.appendChild(root);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'session-badge';
  badge.textContent = 'No session';
  badge.addEventListener('click', (ev) => { ev.stopPropagation(); togglePopover(); });
  root.appendChild(badge);

  const popover = document.createElement('div');
  popover.className = 'session-popover';
  popover.hidden = true;
  popover.addEventListener('click', (ev) => { ev.stopPropagation(); });
  root.appendChild(popover);

  let popoverOpen = false;

  function togglePopover(): void {
    popoverOpen = !popoverOpen;
    popover.hidden = !popoverOpen;
    if (popoverOpen) void refresh();
  }

  function closePopover(): void {
    popoverOpen = false;
    popover.hidden = true;
  }

  document.addEventListener('click', () => { if (popoverOpen) closePopover(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && popoverOpen) closePopover();
  });

  async function refresh(): Promise<void> {
    const state = sessionManager.current() === null
      ? null
      : await sessionManager.refreshState();
    renderBadge(state);
    if (popoverOpen) renderPopover(state);
  }

  function renderBadge(state: ApiSessionState | null): void {
    if (state === null) {
      badge.textContent = 'No session';
      badge.classList.remove('has-conflicts');
      return;
    }
    const label = `${shortId(state.id)} · ${String(state.op_count)} op${state.op_count === 1 ? '' : 's'}`;
    badge.textContent = label;
    badge.classList.toggle('has-conflicts', state.conflicts.length > 0);
  }

  function renderPopover(state: ApiSessionState | null): void {
    popover.innerHTML = '';
    if (state === null) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'No active session. Make any change to start one.';
      popover.appendChild(empty);
      appendHistoryLink(popover);
      return;
    }
    const head = document.createElement('div');
    head.className = 'session-head';
    head.textContent = `Session ${shortId(state.id)} · ${String(state.op_count)} op${state.op_count === 1 ? '' : 's'}`;
    popover.appendChild(head);

    if (state.conflicts.length > 0) {
      const c = document.createElement('div');
      c.className = 'session-conflicts';
      c.textContent = `Conflict: ${state.conflicts.map(fmtRef).join(', ')}`;
      popover.appendChild(c);
    }

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    if (state.conflicts.length === 0 && state.op_count > 0) {
      const merge = btn('Merge');
      merge.addEventListener('click', () => { void onMerge(); });
      actions.appendChild(merge);
    }
    const refreshBtn = btn('Refresh');
    refreshBtn.addEventListener('click', () => { void refresh(); });
    actions.appendChild(refreshBtn);
    const abandon = btn('Abandon');
    abandon.addEventListener('click', () => { void onAbandon(); });
    actions.appendChild(abandon);
    popover.appendChild(actions);

    appendHistoryLink(popover);
  }

  function appendHistoryLink(parent: HTMLElement): void {
    const link = document.createElement('a');
    link.className = 'session-history-link';
    link.href = '/history';
    link.textContent = 'View commit history →';
    parent.appendChild(link);
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

  const off = sessionManager.onChange(() => { void refresh(); });
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

function btn(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  return b;
}
