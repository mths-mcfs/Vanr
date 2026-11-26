import { X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { TONE_ICON, type Tone } from "./tone.ts";

export type ToastInput = {
  tone: Tone;
  title: ReactNode;
  description?: ReactNode;
  /** One follow-up action, such as "Undo". */
  action?: { label: string; altText: string; onAction: () => void };
  /** Milliseconds on screen. Defaults to the provider's duration. */
  duration?: number;
};

type QueuedToast = ToastInput & { id: string; open: boolean };

type ToastApi = {
  /** Queues a toast and returns its id. */
  push: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export type ToastProviderProps = {
  /** Name of the notification region, in the interface language (e.g. "Notifications"). */
  label: string;
  /** Accessible name of each toast's close button. */
  closeLabel: string;
  /** How many toasts are on screen at once; the rest wait in line. */
  visible?: number;
  duration?: number;
  children: ReactNode;
};

const EXIT_MS = 200;

export function ToastProvider({
  label,
  closeLabel,
  visible = 3,
  duration = 5000,
  children,
}: ToastProviderProps) {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setQueue((items) => items.map((item) => (item.id === id ? { ...item, open: false } : item)));
    setTimeout(() => setQueue((items) => items.filter((item) => item.id !== id)), EXIT_MS);
  }, []);

  const push = useCallback((toast: ToastInput) => {
    counter.current += 1;
    const id = `vr-toast-${counter.current}`;
    setQueue((items) => [...items, { ...toast, id, open: true }]);
    return id;
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  const shown = queue.slice(0, visible);

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider label={label} duration={duration} swipeDirection="right">
        {children}
        {shown.map((toast) => (
          <ToastPrimitive.Root
            key={toast.id}
            className="vr-toast"
            data-tone={toast.tone}
            open={toast.open}
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
            {...(toast.duration !== undefined && { duration: toast.duration })}
            type={toast.tone === "danger" ? "foreground" : "background"}
          >
            <Icon icon={TONE_ICON[toast.tone]} className="vr-toast__icon" />
            <div className="vr-toast__text">
              <ToastPrimitive.Title className="vr-toast__title">{toast.title}</ToastPrimitive.Title>
              {toast.description !== undefined && (
                <ToastPrimitive.Description className="vr-toast__description">
                  {toast.description}
                </ToastPrimitive.Description>
              )}
            </div>
            {toast.action !== undefined && (
              <ToastPrimitive.Action
                className="vr-toast__action"
                altText={toast.action.altText}
                onClick={toast.action.onAction}
              >
                {toast.action.label}
              </ToastPrimitive.Action>
            )}
            <ToastPrimitive.Close className="vr-toast__close" aria-label={closeLabel}>
              <Icon icon={X} size="sm" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="vr-toast__viewport" label={`${label} ({hotkey})`} />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
