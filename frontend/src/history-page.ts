// Standalone /history page: lists commits latest-first with per-row revert
// buttons. Lives outside the SPA so the commit log doesn't compete with the
// map / station chrome on the main routes.

import * as api from './api.js';
import { SessionConflictError } from './api.js';
import type { ApiCommit } from './api.js';
import { fmtRef, getElement, shortId } from './types.js';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function renderList(commits: readonly ApiCommit[]): void {
  const list = getElement('list');
  list.replaceChildren();
  if (commits.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '(no commits yet)';
    list.appendChild(empty);
    return;
  }
  for (const c of commits) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'desc';
    const msg = c.message ?? '';
    label.textContent = `#${String(c.seq)} ${c.kind} ${shortId(c.id)}${msg ? ` — ${msg}` : ''}`;
    li.appendChild(label);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = fmtDate(c.created_at);
    li.appendChild(meta);

    const revertBtn = document.createElement('button');
    revertBtn.type = 'button';
    revertBtn.className = 'btn';
    revertBtn.textContent = 'Revert';
    revertBtn.addEventListener('click', () => { void onRevert(c); });
    li.appendChild(revertBtn);

    list.appendChild(li);
  }
}

async function onRevert(c: ApiCommit): Promise<void> {
  if (!confirm(`Revert commit ${shortId(c.id)}?`)) return;
  try {
    const ref = await api.revertCommit(c.id);
    alert(`Reverted as commit ${shortId(ref.commit_id)} (seq ${String(ref.seq)}).`);
    await refresh();
  } catch (err) {
    if (err instanceof SessionConflictError) {
      alert(`Revert blocked by conflicts: ${err.conflicts.map(fmtRef).join(', ')}`);
      return;
    }
    alert(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function refresh(): Promise<void> {
  try {
    const commits = await api.listCommits();
    renderList(commits);
  } catch (err) {
    console.error('listCommits failed:', err);
    const list = getElement('list');
    list.replaceChildren();
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'failed to load — see console';
    list.appendChild(li);
  }
}

void refresh();
