// Standalone /history page: lists commits latest-first with per-row revert
// buttons. Lives outside the SPA so the commit log doesn't compete with the
// map / station chrome on the main routes.

import * as api from './api.js';
import type { ApiCommit } from './api.js';
import { openSignOffModal } from './signoff-modal.js';
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
    revertBtn.addEventListener('click', () => { openRevertModal(c); });
    li.appendChild(revertBtn);

    list.appendChild(li);
  }
}

function openRevertModal(c: ApiCommit): void {
  openSignOffModal({
    ids: {
      modal: 'revert-modal',
      signoff: 'revert-signoff',
      description: 'revert-description',
      confirm: 'revert-confirm',
      cancel: 'revert-cancel',
      close: 'revert-close',
      error: 'revert-error',
      title: 'revert-modal-title',
    },
    title: `Revert ${shortId(c.id)}`,
    submit: async req => {
      const ref = await api.revertCommit(c.id, req);
      alert(`Reverted as commit ${shortId(ref.commit_id)} (seq ${String(ref.seq)}).`);
      await refresh();
    },
    onConflict: err => {
      alert(`Revert blocked by conflicts: ${err.conflicts.map(fmtRef).join(', ')}`);
    },
  });
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
