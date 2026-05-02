// Modal shown when the user picks "Start project here" from the map's
// right-click popup. Collects a project title (required), a date estimate
// (defaulted to now), and an optional set of photos to bulk-upload along
// with the new project. The actual create + upload happens in the caller's
// onSubmit; the modal owns form state and the disabled-while-pending latch.

import { formatLocalDateTime, getElement } from './types.js';
import type { LatLng } from './types.js';

export interface StartProjectModal {
  open(loc: LatLng): void;
}

export interface CreateStartProjectModalOptions {
  onSubmit: (input: {
    loc: LatLng;
    name: string;
    dateEstimate: string;
    photos: File[];
  }) => Promise<void>;
}

export function createStartProjectModal({ onSubmit }: CreateStartProjectModalOptions): StartProjectModal {
  const modalEl = getElement('start-project-modal');
  const closeBtn = getElement<HTMLButtonElement>('start-project-close');
  const cancelBtn = getElement<HTMLButtonElement>('start-project-cancel');
  const submitBtn = getElement<HTMLButtonElement>('start-project-submit');
  const titleEl = getElement<HTMLInputElement>('start-project-title');
  const dateEl = getElement<HTMLInputElement>('start-project-date');
  const dropEl = getElement('start-project-drop');
  const fileInputEl = getElement<HTMLInputElement>('start-project-files');
  const previewEl = getElement('start-project-photos-preview');

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

  // Drag-and-drop into the drop zone.
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
  // Click the drop zone to open the native file picker (proxied through the
  // hidden <input type="file">).
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
      .catch((err: unknown) => { console.error('start project failed:', err); })
      .finally(() => { submitBtn.disabled = false; });
  });

  return { open };
}
