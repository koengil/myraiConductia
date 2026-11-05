import * as React from 'react';

const SKIP = ':not([tabindex="-1"])';

/**
 * What the dialog keyboard contract treats as focusable (Tab wrap, first
 * focus). Anything with `tabindex="-1"` (menu items, roving controls) is out.
 */
export const FOCUSABLE = [
  `button:not(:disabled)${SKIP}`,
  `[href]${SKIP}`,
  `input:not(:disabled)${SKIP}`,
  `select:not(:disabled)${SKIP}`,
  `textarea:not(:disabled)${SKIP}`,
  `details > summary:first-of-type${SKIP}`,
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The focusable elements inside `root`, in document order. Sorted
 * explicitly because jsdom returns a selector list grouped by selector.
 */
export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

// Open modals, innermost last. Only the innermost one answers Escape and Tab,
// so a confirm opened over a dialog closes alone.
const openStack: { el: HTMLElement | null }[] = [];

/**
 * Keyboard contract for a hand-rolled `aria-modal` dialog (#250): focus moves
 * in on open (to `initialFocus`, else the first focusable, else the panel),
 * Tab and Shift+Tab wrap inside it, Escape calls `onClose` (unless a layer
 * inside the dialog already handled it and called `preventDefault`), and focus
 * returns to whatever was focused before it opened.
 */
export function useModalDialog(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  {
    active = true,
    initialFocus,
  }: { active?: boolean; initialFocus?: React.RefObject<HTMLElement | null> } = {},
) {
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  React.useEffect(() => {
    if (!active) return;
    const token = { el: ref.current };
    // A nested dialog mounted in the same commit runs its effect first, so
    // slot this one below any open dialog it contains.
    const below = openStack.findIndex((open) => Boolean(open.el && token.el?.contains(open.el)));
    openStack.splice(below === -1 ? openStack.length : below, 0, token);
    const restoreTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openStack[openStack.length - 1] === token) {
      (
        initialFocus?.current ??
        (ref.current ? focusableIn(ref.current)[0] : null) ??
        ref.current
      )?.focus();
    }

    function onKey(event: KeyboardEvent) {
      if (openStack[openStack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        // A layer inside the dialog (a menu, a listbox) already handled it.
        if (event.defaultPrevented) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = focusableIn(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!(current instanceof HTMLElement) || !dialog.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || current === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(token), 1);
      if (restoreTo?.isConnected) restoreTo.focus();
    };
    // initialFocus and ref are refs; re-running on their identity would refocus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
