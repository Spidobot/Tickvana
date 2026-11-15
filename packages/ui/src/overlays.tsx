// Dialog, menu, select, tabs and toast on Radix primitives: focus handling,
// keyboard support and ARIA come from there.
import { Check, ChevronDown, X } from "lucide-react";
import {
  Dialog as RDialog,
  DropdownMenu,
  Select as RSelect,
  Tabs as RTabs,
  Toast as RToast,
} from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { cx, inputClass } from "./components.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const popover =
  "z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-float animate-rise";
const item =
  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-base text-fg outline-none select-none data-[highlighted]:bg-raised data-[disabled]:opacity-50";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Accessible name of the close button. */
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-float animate-rise"
        >
          <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <div className="flex flex-col gap-1">
              <RDialog.Title className="text-lg font-medium text-fg">
                {title}
              </RDialog.Title>
              {description && (
                <RDialog.Description className="text-fg-2">
                  {description}
                </RDialog.Description>
              )}
            </div>
            <RDialog.Close
              aria-label={closeLabel}
              className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-raised hover:text-fg"
            >
              <X {...icon} />
            </RDialog.Close>
          </header>
          <div className="overflow-y-auto px-6 py-2">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 px-6 pt-3 pb-5">
              {footer}
            </footer>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}

export function Menu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: MenuItem[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={popover}>
          {items.map((entry) => (
            <DropdownMenu.Item
              key={entry.label}
              disabled={entry.disabled}
              onSelect={entry.onSelect}
              className={item}
            >
              {entry.icon && (
                <span className="flex w-4 justify-center text-fg-2">
                  {entry.icon}
                </span>
              )}
              {entry.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  ...trigger
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <RSelect.Root value={value} onValueChange={onValueChange}>
      <RSelect.Trigger
        {...trigger}
        className={cx(
          inputClass,
          "flex items-center justify-between gap-2 data-[placeholder]:text-fg-3",
        )}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="text-fg-3">
          <ChevronDown {...icon} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className={cx(popover, "w-(--radix-select-trigger-width)")}
        >
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className={cx(item, "justify-between")}
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="text-accent-ink">
                  <Check {...icon} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Tabs({
  label,
  tabs,
  defaultValue,
}: {
  /** Accessible name of the tab list. */
  label: string;
  tabs: { value: string; label: string; content: ReactNode }[];
  defaultValue?: string;
}) {
  return (
    <RTabs.Root defaultValue={defaultValue ?? tabs[0]?.value}>
      <RTabs.List
        aria-label={label}
        className="flex gap-1 border-b border-line"
      >
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px h-9 border-b-2 border-transparent px-3 text-base text-fg-2 transition-colors hover:text-fg data-[state=active]:border-accent-ink data-[state=active]:text-fg"
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="pt-4">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

interface ToastMessage {
  id: number;
  title: string;
  text?: string;
  tone?: "neutral" | "negative";
}
const ToastContext = createContext<(message: Omit<ToastMessage, "id">) => void>(
  () => {},
);

/** Shows a short confirmation or error in the corner. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({
  children,
  closeLabel,
}: {
  children: ReactNode;
  closeLabel: string;
}) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const push = useCallback(
    (message: Omit<ToastMessage, "id">) =>
      setMessages((all) => [
        ...all,
        { ...message, id: Date.now() + Math.random() },
      ]),
    [],
  );
  return (
    <ToastContext.Provider value={push}>
      <RToast.Provider duration={5000}>
        {children}
        {messages.map((m) => (
          <RToast.Root
            key={m.id}
            onOpenChange={(open) =>
              !open && setMessages((all) => all.filter((x) => x.id !== m.id))
            }
            className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface p-4 shadow-float animate-rise"
          >
            <div className="flex flex-col gap-1">
              <RToast.Title
                className={cx(
                  "font-medium",
                  m.tone === "negative" ? "text-negative" : "text-fg",
                )}
              >
                {m.title}
              </RToast.Title>
              {m.text && (
                <RToast.Description className="text-fg-2">
                  {m.text}
                </RToast.Description>
              )}
            </div>
            <RToast.Close
              aria-label={closeLabel}
              className="rounded-md p-1 text-fg-2 transition-colors hover:bg-raised hover:text-fg"
            >
              <X {...icon} />
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 outline-none" />
      </RToast.Provider>
    </ToastContext.Provider>
  );
}
