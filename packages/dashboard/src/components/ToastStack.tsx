import type { AlertRow } from '../lib/api';
import { AlertToast } from './AlertToast';

export interface ToastStackProps {
  readonly toasts: ReadonlyArray<AlertRow>;
  readonly onDismiss: (id: number) => void;
  readonly onActivate: (id: number) => void;
}

/**
 * #142: fixed bottom-right container for the live toast stack.
 * Oldest at the top, newest at the bottom (visually closest to the
 * mouse). `pointer-events-none` on the outer container lets clicks
 * pass through gaps between toasts; each `<AlertToast />` re-enables
 * its own hit area.
 */
export function ToastStack({ toasts, onDismiss, onActivate }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((alert) => (
        <AlertToast
          key={alert.id}
          alert={alert}
          onDismiss={() => onDismiss(alert.id)}
          onActivate={() => onActivate(alert.id)}
        />
      ))}
    </div>
  );
}
