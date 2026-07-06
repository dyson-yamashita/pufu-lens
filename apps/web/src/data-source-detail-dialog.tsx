'use client';

import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';

export function DataSourceDetailDialog({
  children,
  closeHref,
}: {
  readonly children: ReactNode;
  readonly closeHref: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      className="modal-dialog data-source-detail-dialog"
      data-testid="data-source-detail-panel"
      onClose={() => router.replace(closeHref, { scroll: false })}
      ref={dialogRef}
    >
      <div className="modal-card data-source-detail-modal-card">
        <button
          aria-label="Close source detail"
          className="modal-close-button"
          onClick={() => dialogRef.current?.close()}
          type="button"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </dialog>
  );
}
