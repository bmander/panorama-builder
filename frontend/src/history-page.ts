// Standalone /history page: lists commits latest-first in a four-column
// layout (datetime / signer / change count / Revert). Paginates at 40
// commits per page via the backend's ?before_seq= cursor. Lives outside the
// SPA so the commit log doesn't compete with the map / station chrome on the
// main routes.

import * as api from './api.js';
import type { ApiCommit } from './api.js';
import { openSignOffModal } from './signoff-modal.js';
import { fmtRef, getElement, shortId } from './types.js';

const PAGE_SIZE = 40;
const HEADERS = ['When', 'Signer', 'Changes', ''] as const;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function readBeforeSeq(): number | undefined {
  const v = new URL(window.location.href).searchParams.get('before_seq');
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function renderHeader(): HTMLElement {
  const li = document.createElement('li');
  li.className = 'header';
  for (const label of HEADERS) {
    const sp = document.createElement('span');
    sp.textContent = label;
    li.append(sp);
  }
  return li;
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
  list.appendChild(renderHeader());
  for (const c of commits) {
    const li = document.createElement('li');

    const date = document.createElement('span');
    date.className = 'desc';
    date.textContent = fmtDate(c.created_at);
    li.appendChild(date);

    const signer = document.createElement('span');
    signer.className = 'col';
    signer.textContent = c.sign_off;
    li.appendChild(signer);

    const count = document.createElement('span');
    count.className = 'col';
    count.textContent = `${String(c.op_count)} change${c.op_count === 1 ? '' : 's'}`;
    li.appendChild(count);

    const revertBtn = document.createElement('button');
    revertBtn.type = 'button';
    revertBtn.className = 'btn';
    revertBtn.textContent = 'Revert';
    revertBtn.addEventListener('click', () => { openRevertModal(c); });
    li.appendChild(revertBtn);

    list.appendChild(li);
  }
}

function renderPager(shown: readonly ApiCommit[], hasMore: boolean, onPage1: boolean): void {
  const newer = getElement<HTMLAnchorElement>('pager-newer');
  const older = getElement<HTMLAnchorElement>('pager-older');
  newer.hidden = onPage1;
  if (hasMore && shown.length > 0) {
    const lastSeq = shown[shown.length - 1]!.seq;
    older.href = `/history.html?before_seq=${String(lastSeq)}`;
    older.hidden = false;
  } else {
    older.hidden = true;
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
      // New revert commit lands at the top of the log; jump back to page 1.
      window.location.href = '/history.html';
    },
    onConflict: err => {
      alert(`Revert blocked by conflicts: ${err.conflicts.map(fmtRef).join(', ')}`);
    },
  });
}

async function refresh(): Promise<void> {
  const beforeSeq = readBeforeSeq();
  try {
    // Fetch one extra row to detect whether a next page exists.
    const commits = await api.listCommits(beforeSeq, PAGE_SIZE + 1);
    const hasMore = commits.length > PAGE_SIZE;
    const shown = hasMore ? commits.slice(0, PAGE_SIZE) : commits;
    renderList(shown);
    renderPager(shown, hasMore, beforeSeq === undefined);
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
