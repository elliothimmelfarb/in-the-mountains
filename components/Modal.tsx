"use client";
import { useEffect, useRef, type ReactNode } from "react";

// One accessible dialog shell for every overlay (EventModal, SoldierJacket, Help/Legend).
// Closes the "a skeptic would notice" gaps the audit can't see: role=dialog + aria-modal,
// focus moves IN on open and is RESTORED to the opener on close, Tab/Shift+Tab wrap inside
// the dialog (no escaping to the HUD behind the scrim), and Escape closes it. The Escape +
// Tab handlers run in CAPTURE so they beat the DeployScreen global onKey (which otherwise
// would treat Escape as "cancel fire-support" while a modal is up).
//
// `dismissable=false` (decision-forcing Situation events): focus is still trapped and the
// dialog is labelled, but Escape / backdrop-click do NOT close it — the player must choose.
export function Modal({
  onClose,
  labelledBy,
  dismissable = true,
  width = "w-[480px]",
  children,
}: {
  onClose: () => void;
  labelledBy?: string;
  dismissable?: boolean;
  width?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      el
        ? Array.from(
            el.querySelectorAll<HTMLElement>(
              'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((f) => !f.hasAttribute("disabled") && f.offsetParent !== null)
        : [];

    // move focus into the dialog (first control, else the dialog itself)
    (focusables()[0] ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dismissable) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else {
          // swallow so the global handler doesn't act on it, but don't dismiss
          e.stopPropagation();
        }
        return;
      }
      if (e.key === "Tab") {
        const fs = focusables();
        if (fs.length === 0) {
          e.preventDefault();
          return;
        }
        const active = document.activeElement as HTMLElement;
        const idx = fs.indexOf(active);
        if (e.shiftKey && idx <= 0) {
          e.preventDefault();
          fs[fs.length - 1].focus();
        } else if (!e.shiftKey && idx === fs.length - 1) {
          e.preventDefault();
          fs[0].focus();
        } else if (idx === -1) {
          e.preventDefault();
          fs[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true); // capture: beat the global onKey
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.(); // restore focus to whatever opened the dialog
    };
  }, [onClose, dismissable]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 fade-in"
      onClick={() => dismissable && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`panel ${width} max-w-[92vw] p-5 outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
