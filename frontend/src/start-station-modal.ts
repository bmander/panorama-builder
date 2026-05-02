// Modal shown when the user picks "Start station here" from the map's
// right-click popup. Collects a station title (required), a date estimate
// (defaulted to now), and an optional set of photos to bulk-upload along
// with the new station. The actual create + upload happens in the caller's
// onSubmit; the modal owns form state and the disabled-while-pending latch.

import { formatLocalDateTime, getElement } from './types.js';
import type { LatLng } from './types.js';

export interface StartStationModal {
  open(loc: LatLng): void;
}

export interface CreateStartStationModalOptions {
  onSubmit: (input: {
    loc: LatLng;
    name: string;
    dateEstimate: string;
    photos: File[];
  }) => Promise<void>;
}

export function createStartStationModal({ onSubmit }: CreateStartStationModalOptions): StartStationModal {
  const modalEl = getElement('start-station-modal');
  const closeBtn = getElement<HTMLButtonElement>('start-station-close');
  const cancelBtn = getElement<HTMLButtonElement>('start-station-cancel');
  const submitBtn = getElement<HTMLButtonElement>('start-station-submit');
  const titleEl = getElement<HTMLInputElement>('start-station-title');
  const dateEl = getElement<HTMLInputElement>('start-station-date');
  const dropEl = getElement('start-station-drop');
  const fileInputEl = getElement<HTMLInputElement>('start-station-files');
  const previewEl = getElement('start-station-photos-preview');

  let pendingLoc: LatLng | null = null;
  let photos: File[] = [];

  function renderPreview(): void {
    previewEl.replaceChildren();
    photos.forEach((file, i) => {
      const row = document.createElement('div');
      row.className = 'photo-thumb';
      const label = document.createElement('span');
      label.textContent = `${file.name} (${Math.round(file.size / 1024).toString()} KB)`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        photos.splice(i, 1);
        renderPreview();
      });
      row.append(label, remove);
      previewEl.appendChild(row);
    });
  }

  function addFiles(files: FileList | File[] | null): void {
    if (!files) return;
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      photos.push(f);
    }
    renderPreview();
  }

  function close(): void {
    modalEl.hidden = true;
    pendingLoc = null;
    photos = [];
    fileInputEl.value = '';
  }

  function open(loc: LatLng): void {
    pendingLoc = loc;
    photos = [];
    titleEl.value = '';
    dateEl.value = formatLocalDateTime(new Date());
    fileInputEl.value = '';
    renderPreview();
    submitBtn.disabled = false;
    modalEl.hidden = false;
    titleEl.focus();
  }

  // Click outside the panel = cancel.
  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  dropEl.addEventListener('dragover', e => {
    e.preventDefault();
    dropEl.classList.add('over');
  });
  dropEl.addEventListener('dragleave', () => { dropEl.classList.remove('over'); });
  dropEl.addEventListener('drop', e => {
    e.preventDefault();
    dropEl.classList.remove('over');
    addFiles(e.dataTransfer?.files ?? null);
  });
  dropEl.addEventListener('click', () => { fileInputEl.click(); });
  fileInputEl.addEventListener('change', () => {
    addFiles(fileInputEl.files);
    fileInputEl.value = '';
  });

  submitBtn.addEventListener('click', () => {
    if (!pendingLoc) return;
    const name = titleEl.value.trim();
    if (!name) {
      titleEl.focus();
      return;
    }
    submitBtn.disabled = true;
    const loc = pendingLoc;
    const dateEstimate = dateEl.value;
    const submittedPhotos = photos.slice();
    onSubmit({ loc, name, dateEstimate, photos: submittedPhotos })
      .catch((err: unknown) => { console.error('start station failed:', err); })
      .finally(() => { submitBtn.disabled = false; });
  });

  return { open };
}
