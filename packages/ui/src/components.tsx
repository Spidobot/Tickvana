// Base components. Every visible string comes in through props: this package
// holds no texts of its own, the apps pass translated ones.
import { useId, type ComponentProps, type ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

const control =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";

const buttonVariants = {
  primary: "bg-accent text-on-accent hover:brightness-110",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-raised",
  ghost: "text-fg-2 hover:bg-raised hover:text-fg",
  danger: "bg-negative text-white hover:brightness-110",
};
const buttonSizes = { sm: "h-8 px-3 text-sm", md: "h-9 px-4 text-base" };

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        control,
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    />
  );
}

/** A square button holding only an icon. `label` is what screen readers announce. */
export function IconButton({
  label,
  className,
  ...rest
}: ButtonProps & { label: string }) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      title={label}
      className={cx("w-8 px-0", className)}
      size="sm"
      {...rest}
    />
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-fg placeholder:text-fg-3 transition-colors hover:border-fg-3 aria-invalid:border-negative";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx(inputClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cx(inputClass, "h-auto min-h-20 py-2", className)}
      {...rest}
    />
  );
}

/** Label, control, and hint or error, wired up for assistive technology. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": note ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {note && (
        <p
          id={noteId}
          className={cx("text-sm", error ? "text-negative" : "text-fg-3")}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/** A key on the keyboard. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-raised px-1 font-mono text-xs text-fg-2">
      {children}
    </kbd>
  );
}

/**
 * The ticket key (ABC-123). The product's signature: set the same way in
 * Tickvana, in the portal and in Nuvenna.
 */
export function IssueKey({
  children,
  href,
  done,
}: {
  children: string;
  href?: string;
  done?: boolean;
}) {
  const className = cx(
    "inline-flex h-5 items-center rounded-sm border border-line-strong bg-raised px-1 font-mono text-xs tabular-nums text-fg-2",
    done && "line-through decoration-fg-3",
    href && "transition-colors hover:border-accent-ink hover:text-accent-ink",
  );
  return href ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

const statusDot = {
  todo: "bg-fg-3",
  in_progress: "bg-accent-ink",
  done: "bg-positive",
};

/** A workflow status. The category is the only colour with a fixed meaning. */
export function Status({
  category,
  children,
}: {
  category: keyof typeof statusDot;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-2 rounded-sm bg-raised px-2 text-sm text-fg">
      <span
        aria-hidden
        className={cx("size-2 rounded-full", statusDot[category])}
      />
      {children}
    </span>
  );
}

export function Card({ className, ...rest }: ComponentProps<"section">) {
  return (
    <section
      className={cx("rounded-lg border border-line bg-surface", className)}
      {...rest}
    />
  );
}

export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table
        className={cx("w-full border-collapse text-left text-base", className)}
        {...rest}
      />
    </div>
  );
}
export function Th({ className, ...rest }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cx(
        "h-9 border-b border-line px-3 text-sm font-medium text-fg-2",
        className,
      )}
      {...rest}
    />
  );
}
export function Td({ className, ...rest }: ComponentProps<"td">) {
  return (
    <td
      className={cx("h-10 border-b border-line px-3 text-fg", className)}
      {...rest}
    />
  );
}

/** Shown where a list has nothing in it yet. */
export function EmptyState({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-6 py-10">
      <p className="text-lg font-medium text-fg">{title}</p>
      {text && <p className="max-w-prose text-fg-2">{text}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
