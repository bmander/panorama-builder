import { getElement } from './types.js';

export function attachHamburgerMenu(): void {
  const menuBtn = getElement<HTMLButtonElement>('menu-btn');
  const dropdown = getElement('menu-dropdown');
  function setOpen(open: boolean): void {
    dropdown.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  }
  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(dropdown.hidden);
  });
  dropdown.addEventListener('click', () => { setOpen(false); });
  document.addEventListener('click', e => {
    if (dropdown.hidden) return;
    const target = e.target as Node | null;
    if (target && (dropdown.contains(target) || menuBtn.contains(target))) return;
    setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !dropdown.hidden) setOpen(false);
  });

  const aboutModal = getElement('about-modal');
  getElement<HTMLButtonElement>('about-btn').addEventListener('click', () => {
    aboutModal.hidden = false;
  });
  getElement<HTMLButtonElement>('about-close').addEventListener('click', () => {
    aboutModal.hidden = true;
  });
  aboutModal.addEventListener('click', e => {
    if (e.target === aboutModal) aboutModal.hidden = true;
  });
}
