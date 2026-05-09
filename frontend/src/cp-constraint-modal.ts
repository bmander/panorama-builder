// Modal for editing CP-CP constraints. Sole owner of the create / update /
// delete API surface; openCreate runs after a shift-click-drag, openEdit
// from a click on an existing constraint line.

import * as api from './api.js';
import type { CPConstraintType, CPConstraintView, ControlPointView } from './types.js';
import { cpLabel, getElement } from './types.js';

export interface CPConstraintModal {
  openCreate(cpAId: string, cpBId: string): void;
  openEdit(constraint: CPConstraintView): void;
  close(): void;
}

export interface CreateCPConstraintModalOptions {
  // Returns the live CP list so the modal can label endpoints by description.
  getControlPoints: () => readonly ControlPointView[];
  // Fired after any successful create / update / delete. The host re-fetches
  // constraints and triggers a flushSync.
  onMutated: () => void;
  // Fired whenever the modal closes — for any reason (save, delete, cancel,
  // backdrop click, ✕). Lets the host clear any selection visualization
  // tied to the modal being open.
  onClose?: () => void;
}

export function createCPConstraintModal(opts: CreateCPConstraintModalOptions): CPConstraintModal {
  const modalEl = getElement('cp-constraint-modal');
  const titleEl = getElement('cp-constraint-title');
  const pairEl = getElement('cp-constraint-pair');
  const closeBtn = getElement<HTMLButtonElement>('cp-constraint-close');
  const cancelBtn = getElement<HTMLButtonElement>('cp-constraint-cancel');
  const saveBtn = getElement<HTMLButtonElement>('cp-constraint-save');
  const deleteBtn = getElement<HTMLButtonElement>('cp-constraint-delete');
  const radios = (): HTMLInputElement[] =>
    Array.from(modalEl.querySelectorAll<HTMLInputElement>('input[name="cp-constraint-type"]'));

  type State =
    | { kind: 'create'; cpAId: string; cpBId: string }
    | { kind: 'edit'; constraint: CPConstraintView };
  let state: State | null = null;

  function close(): void {
    modalEl.hidden = true;
    state = null;
    saveBtn.disabled = false;
    deleteBtn.disabled = false;
    opts.onClose?.();
  }

  function describe(id: string): string {
    const cp = opts.getControlPoints().find(c => c.id === id);
    return cp ? cpLabel(cp.description) : id;
  }

  function selectedType(): CPConstraintType | null {
    const r = radios().find(x => x.checked);
    return (r?.value as CPConstraintType | undefined) ?? null;
  }

  function setSelectedType(t: CPConstraintType | null): void {
    for (const r of radios()) r.checked = r.value === t;
  }

  function openCreate(cpAId: string, cpBId: string): void {
    state = { kind: 'create', cpAId, cpBId };
    titleEl.textContent = 'New constraint';
    pairEl.textContent = `${describe(cpAId)}  ↔  ${describe(cpBId)}`;
    setSelectedType(null);
    deleteBtn.hidden = true;
    modalEl.hidden = false;
  }

  function openEdit(constraint: CPConstraintView): void {
    state = { kind: 'edit', constraint };
    titleEl.textContent = 'Edit constraint';
    pairEl.textContent = `${describe(constraint.cpAId)}  ↔  ${describe(constraint.cpBId)}`;
    setSelectedType(constraint.type);
    deleteBtn.hidden = false;
    modalEl.hidden = false;
  }

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });

  saveBtn.addEventListener('click', () => {
    if (!state) return;
    const t = selectedType();
    if (!t) {
      alert('Pick a constraint type.');
      return;
    }
    saveBtn.disabled = true;
    const finish = (err: unknown): void => {
      saveBtn.disabled = false;
      if (err) {
        console.error('cp-constraint save failed:', err);
        alert('Could not save the constraint.');
        return;
      }
      opts.onMutated();
      close();
    };
    if (state.kind === 'create') {
      void api.createCPConstraint({
        cp_a_id: state.cpAId, cp_b_id: state.cpBId, constraint_type: t,
      })
        .then(() => { finish(null); })
        .catch((err: unknown) => { finish(err); });
    } else {
      void api.updateCPConstraint(state.constraint.id, { constraint_type: t })
        .then(() => { finish(null); })
        .catch((err: unknown) => { finish(err); });
    }
  });

  deleteBtn.addEventListener('click', () => {
    if (state?.kind !== 'edit') return;
    if (!confirm('Delete this constraint?')) return;
    deleteBtn.disabled = true;
    void api.deleteCPConstraint(state.constraint.id)
      .then(() => {
        opts.onMutated();
        close();
      })
      .catch((err: unknown) => {
        deleteBtn.disabled = false;
        console.error('cp-constraint delete failed:', err);
        alert('Could not delete the constraint.');
      });
  });

  return { openCreate, openEdit, close };
}
