// The frame every signed-in page sits in: sidebar, header, command palette.
import { Command } from "cmdk";
import { Menu as MenuIcon, Search } from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import { cx, Kbd } from "./components.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  active?: boolean;
  /** Quiet count on the right, e.g. open tickets. */
  count?: number;
}
export interface NavSection {
  /** Omit for the first, unlabelled group. */
  label?: string;
  items: NavItem[];
}

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  /** Shown right-aligned, e.g. a ticket key or a shortcut. */
  hint?: ReactNode;
  /** Second line, e.g. where a search hit matched. */
  detail?: string;
  onSelect: () => void;
}

export interface ShellLabels {
  /** Accessible name of the sidebar navigation. */
  navigation: string;
  search: string;
  searchPlaceholder: string;
  noResults: string;
  skipToContent: string;
  /** Accessible name of the button that opens the navigation on small screens. */
  menu: string;
}

export function AppShell({
  brand,
  sections,
  commands,
  labels,
  headerEnd,
  title,
  search,
  children,
}: {
  /** Product name or logo, top left. */
  brand: ReactNode;
  sections: NavSection[];
  commands: CommandItem[];
  labels: ShellLabels;
  /** Right side of the header: create button, notifications, account menu. */
  headerEnd?: ReactNode;
  /** Name of the current page. */
  title: string;
  /** Live results for what is typed into the palette. */
  search?: (query: string) => Promise<CommandItem[]>;
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CommandItem[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!search || q.length < 2) return setFound([]);
    let stale = false;
    const timer = setTimeout(
      () =>
        void search(q)
          .then((items) => !stale && setFound(items))
          .catch(() => undefined),
      200,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, search]);
  const lower = query.trim().toLowerCase();
  const shown = [
    ...commands.filter((c) => c.label.toLowerCase().includes(lower)),
    ...found,
  ];
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = (
    <nav
      aria-label={labels.navigation}
      className="flex-1 overflow-y-auto px-2 pb-4"
    >
      {sections.map((section, i) => (
        <div key={section.label ?? i} className={cx(i > 0 && "pt-6")}>
          {section.label && (
            <p className="px-2 pb-2 text-xs text-fg-3">{section.label}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((entry) => (
              <li key={entry.href}>
                <a
                  href={entry.href}
                  aria-current={entry.active ? "page" : undefined}
                  className={cx(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-base transition-colors",
                    entry.active
                      ? "bg-raised text-fg"
                      : "text-fg-2 hover:bg-raised hover:text-fg",
                  )}
                >
                  <span className="flex w-4 justify-center">{entry.icon}</span>
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.count !== undefined && (
                    <span className="font-mono text-xs tabular-nums text-fg-3">
                      {entry.count}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="grid min-h-dvh grid-cols-[260px_minmax(0,1fr)] max-md:grid-cols-1 print:block">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {labels.skipToContent}
      </a>

      <aside className="sticky top-0 flex h-dvh flex-col border-r border-line bg-sunken max-md:hidden print:hidden">
        <div className="flex h-14 items-center px-4 text-lg font-medium text-fg">
          {brand}
        </div>
        {nav}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-bg px-6 print:hidden">
          <button
            type="button"
            aria-label={labels.menu}
            onClick={() => setMenuOpen(true)}
            className="-ml-2 inline-flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-raised hover:text-fg md:hidden"
          >
            <MenuIcon {...icon} />
          </button>
          <h1 className="truncate text-lg font-medium text-fg">{title}</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-64 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 text-base text-fg-3 transition-colors hover:border-fg-3 max-md:w-auto"
          >
            <Search {...icon} />
            <span className="flex-1 text-left max-md:sr-only">
              {labels.search}
            </span>
            <span className="flex gap-1 max-md:hidden">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          {headerEnd}
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1600px] flex-1 p-6 outline-none print:p-0"
        >
          {children}
        </main>
      </div>

      <RDialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <RDialog.Content
            aria-describedby={undefined}
            onClick={(e) =>
              (e.target as HTMLElement).closest("a") && setMenuOpen(false)
            }
            className="fixed inset-y-0 left-0 z-50 flex w-[min(280px,calc(100vw-48px))] flex-col border-r border-line bg-sunken"
          >
            <RDialog.Title className="flex h-14 items-center px-4 text-lg font-medium text-fg">
              {brand}
            </RDialog.Title>
            {nav}
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>

      <RDialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <RDialog.Content
            aria-describedby={undefined}
            className="fixed top-[14vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-float animate-rise"
          >
            <RDialog.Title className="sr-only">{labels.search}</RDialog.Title>
            <Command label={labels.search} shouldFilter={false}>
              <div className="flex h-12 items-center gap-2 border-b border-line px-4 text-fg-3">
                <Search {...icon} />
                <Command.Input
                  value={query}
                  onValueChange={setQuery}
                  placeholder={labels.searchPlaceholder}
                  className="h-full flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-3"
                />
              </div>
              <Command.List className="max-h-[50vh] overflow-y-auto p-1">
                <Command.Empty className="px-3 py-6 text-fg-2">
                  {labels.noResults}
                </Command.Empty>
                {[...new Set(shown.map((c) => c.group))].map((group) => (
                  <Command.Group
                    key={group}
                    heading={group}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-3"
                  >
                    {shown
                      .filter((c) => c.group === group)
                      .map((c) => (
                        <Command.Item
                          key={c.id}
                          value={`${c.label} ${c.id}`}
                          onSelect={() => {
                            setPaletteOpen(false);
                            c.onSelect();
                          }}
                          className="flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1 text-base text-fg data-[selected=true]:bg-raised"
                        >
                          <span className="flex w-4 justify-center text-fg-2">
                            {c.icon}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{c.label}</span>
                            {c.detail && (
                              <span className="truncate text-sm text-fg-3">
                                {c.detail}
                              </span>
                            )}
                          </span>
                          {c.hint}
                        </Command.Item>
                      ))}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
    </div>
  );
}
