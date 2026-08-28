import { onCleanup, onMount } from 'solid-js';

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 为模态框提供初始焦点、Tab 焦点陷阱以及关闭后的焦点恢复。 */
export function useModalFocus(getDialog: () => HTMLElement | undefined) {
  onMount(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = getDialog();
    if (!dialog) return;

    const focusFirst = () => {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]');
      const first = preferred ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    };

    const frame = requestAnimationFrame(focusFirst);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((item) => item.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', trapFocus);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      dialog.removeEventListener('keydown', trapFocus);
      if (previous?.isConnected) previous.focus();
    });
  });
}
