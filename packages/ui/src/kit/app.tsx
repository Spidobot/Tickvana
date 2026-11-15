// What Tickvana and Nuvenna share on the web side: start-up, the gate in front of
// the app (setup, sign-in, password reset) and the standard frame around pages.
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import i18next from "i18next";
import { CircleUser, FileText, LogOut, Settings, Ticket } from "lucide-react";
import {
  createContext,
  StrictMode,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next, useTranslation } from "react-i18next";
import { Button, cx, EmptyState, IconButton } from "../components.js";
import { Menu, ToastProvider } from "../overlays.js";
import { AppShell, type CommandItem, type NavSection } from "../shell.js";
import {
  ApiError,
  createCoreApi,
  type BrandingInfo,
  type CoreApi,
  type Me,
} from "./api.js";
import { LoginPage, ResetPasswordPage, SetupPage } from "./auth-pages.js";
import { Brand } from "./brand.js";
import { NotificationBell } from "./notifications.js";
import * as locales from "./locales.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export interface AppContext {
  /** The app's path, e.g. "/tickvana". */
  prefix: string;
  api: CoreApi;
  me: Me;
  branding: BrandingInfo;
  isAdmin: boolean;
  /** Where the administration starts. */
  adminHref: string;
  signOut: () => void;
}

const Context = createContext<AppContext | null>(null);

/** The signed-in user, branding and core API. Available everywhere below the gate. */
export function useApp(): AppContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useApp() needs to be called inside the app");
  return ctx;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      {children}
    </div>
  );
}

function Gate({
  prefix,
  api,
  adminHref,
  publicPages,
  loginExtra,
  children,
}: {
  prefix: string;
  api: CoreApi;
  adminHref: string;
  publicPages?: Record<string, ReactNode>;
  loginExtra?: ReactNode;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();

  const branding = useQuery({
    queryKey: ["core", "branding"],
    queryFn: api.branding,
  });
  const setup = useQuery({
    queryKey: ["core", "setup"],
    queryFn: api.setupNeeded,
  });
  const me = useQuery({
    queryKey: ["core", "me"],
    // "Not signed in" is an answer, not a failure.
    queryFn: () =>
      api
        .me()
        .catch((e) =>
          e instanceof ApiError && e.status === 401 ? null : Promise.reject(e),
        ),
    enabled: setup.data?.needed === false,
  });
  const signedOut = me.data === null;
  const providers = useQuery({
    queryKey: ["core", "providers"],
    queryFn: api.providers,
    enabled: signedOut,
  });
  const admin = useQuery({
    queryKey: ["core", "admin"],
    queryFn: api.isSystemAdmin,
    enabled: !!me.data,
  });

  useEffect(() => {
    if (!branding.data) return;
    document.title = branding.data.productName;
    if (branding.data.faviconUrl) {
      const link =
        document.querySelector<HTMLLinkElement>("link[rel=icon]") ??
        document.head.appendChild(document.createElement("link"));
      link.rel = "icon";
      link.href = branding.data.faviconUrl;
    }
  }, [branding.data]);

  useEffect(() => {
    if (me.data && me.data.locale.slice(0, 2) !== i18n.language)
      void i18n.changeLanguage(me.data.locale.slice(0, 2));
  }, [me.data, i18n]);

  const onResetPage = window.location.pathname === `${prefix}/reset-password`;
  const autoRedirect =
    signedOut &&
    !onResetPage &&
    providers.data?.oidc?.autoRedirect &&
    !new URLSearchParams(window.location.search).has("local");
  useEffect(() => {
    if (autoRedirect)
      window.location.replace(
        api.oidcLoginUrl(window.location.pathname + window.location.search),
      );
  }, [autoRedirect, api]);

  const failed = [branding, setup, me, providers].find((q) => q.isError);
  if (failed) {
    return (
      <Centered>
        <EmptyState
          title={t("state.errorTitle")}
          text={t("state.errorText")}
          action={
            <Button onClick={() => void refresh()}>{t("state.retry")}</Button>
          }
        />
      </Centered>
    );
  }
  const loading = (
    <Centered>
      <p role="status" className="text-fg-3">
        {t("state.loading")}
      </p>
    </Centered>
  );
  if (!branding.data || !setup.data) return loading;
  if (onResetPage)
    return (
      <ResetPasswordPage
        api={api}
        branding={branding.data}
        signInHref={`${prefix}/`}
      />
    );
  if (setup.data.needed)
    return (
      <SetupPage
        api={api}
        branding={branding.data}
        onDone={() => void refresh()}
      />
    );
  const publicPage =
    publicPages?.[window.location.pathname.slice(prefix.length)];
  if (signedOut && publicPage) return publicPage;
  if (signedOut) {
    if (!providers.data || autoRedirect) return loading;
    return (
      <LoginPage
        api={api}
        branding={branding.data}
        providers={providers.data}
        onSignedIn={() => void refresh()}
        extra={loginExtra}
      />
    );
  }
  if (!me.data) return loading;

  const signOut = () => void api.logout().then(refresh);
  return (
    <Context.Provider
      value={{
        prefix,
        api,
        me: me.data,
        branding: branding.data,
        isAdmin: admin.data ?? false,
        adminHref,
        signOut,
      }}
    >
      {children}
    </Context.Provider>
  );
}

interface TicketHit {
  key: string;
  summary: string;
  excerpt: string;
}
interface PageHit {
  id: string;
  spaceKey: string;
  title: string;
  excerpt: string;
}

/** Tickets and pages for the palette. Both apps share one origin; one that is not installed simply finds nothing. */
function usePaletteSearch(): (query: string) => Promise<CommandItem[]> {
  const { t } = useTranslation();
  return useCallback(
    async (query: string) => {
      const get = async <T,>(url: string): Promise<T[]> => {
        const res = await fetch(
          `${url}?q=${encodeURIComponent(query)}&limit=8`,
          {
            credentials: "same-origin",
          },
        ).catch(() => null);
        return res?.ok ? ((await res.json()) as T[]) : [];
      };
      const go = (href: string) => () => window.location.assign(href);
      const [tickets, pages] = await Promise.all([
        get<TicketHit>("/tickvana/api/search"),
        get<PageHit>("/nuvenna/api/search"),
      ]);
      return [
        ...tickets.map((h) => ({
          id: `ticket:${h.key}`,
          group: t("shell.tickets"),
          label: h.summary,
          detail: h.excerpt || undefined,
          icon: <Ticket {...icon} />,
          hint: <span className="font-mono text-xs text-fg-3">{h.key}</span>,
          onSelect: go(`/tickvana/issues/${h.key}`),
        })),
        ...pages.map((h) => ({
          id: `page:${h.id}`,
          group: t("shell.pages"),
          label: h.title,
          detail: h.excerpt || undefined,
          icon: <FileText {...icon} />,
          hint: (
            <span className="font-mono text-xs text-fg-3">{h.spaceKey}</span>
          ),
          onSelect: go(`/nuvenna/spaces/${h.spaceKey}/pages/${h.id}`),
        })),
      ];
    },
    [t],
  );
}

const APPS = [
  { prefix: "/tickvana", name: "Tickvana" },
  { prefix: "/nuvenna", name: "Nuvenna" },
] as const;

/** The apps installed next to this one, found through their health routes. */
function useApps() {
  return (
    useQuery({
      queryKey: ["apps"],
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        const up = await Promise.all(
          APPS.map((a) =>
            fetch(`${a.prefix}/api/health`)
              .then((r) => r.ok)
              .catch(() => false),
          ),
        );
        return APPS.filter((_, i) => up[i]);
      },
    }).data ?? []
  );
}

/** Links to Tickvana and Nuvenna, shown only when both are there. */
function AppSwitcher() {
  const { t } = useTranslation();
  const { prefix } = useApp();
  const apps = useApps();
  if (apps.length < 2) return null;
  return (
    <nav aria-label={t("shell.apps")} className="flex gap-1">
      {apps.map((a) => (
        <a
          key={a.prefix}
          href={`${a.prefix}/`}
          aria-current={a.prefix === prefix ? "page" : undefined}
          className={cx(
            "rounded-md px-2 py-1 text-sm transition-colors",
            a.prefix === prefix
              ? "bg-raised text-fg"
              : "text-fg-2 hover:bg-raised hover:text-fg",
          )}
        >
          {a.name}
        </a>
      ))}
    </nav>
  );
}

/** The standard frame: sidebar, header with search and account menu. */
export function Frame({
  title,
  sections,
  commands = [],
  headerEnd,
  children,
}: {
  title: string;
  sections: NavSection[];
  commands?: CommandItem[];
  headerEnd?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { prefix, me, branding, isAdmin, adminHref, signOut } = useApp();
  const search = usePaletteSearch();
  // Admin pages bring their own navigation.
  const showAdmin =
    isAdmin && !window.location.pathname.startsWith(`${prefix}/admin`);
  return (
    <AppShell
      title={title}
      brand={<Brand branding={branding} />}
      labels={{
        navigation: t("shell.navigation"),
        search: t("shell.search"),
        searchPlaceholder: t("shell.searchPlaceholder"),
        noResults: t("shell.noResults"),
        skipToContent: t("shell.skipToContent"),
        menu: t("shell.menu"),
      }}
      sections={
        showAdmin
          ? [
              ...sections,
              {
                label: t("shell.admin"),
                items: [
                  {
                    label: t("shell.admin"),
                    href: adminHref,
                    icon: <Settings {...icon} />,
                    active: window.location.pathname === adminHref,
                  },
                ],
              },
            ]
          : sections
      }
      commands={commands}
      search={search}
      headerEnd={
        <>
          <AppSwitcher />
          {headerEnd}
          <NotificationBell />
          <Menu
            trigger={
              <IconButton label={`${t("shell.account")}: ${me.displayName}`}>
                <CircleUser {...icon} />
              </IconButton>
            }
            items={[
              {
                label: t("shell.signOut"),
                icon: <LogOut {...icon} />,
                onSelect: signOut,
              },
            ]}
          />
        </>
      }
    >
      {children}
    </AppShell>
  );
}

export interface MountOptions {
  /** The app's path, e.g. "/tickvana". */
  prefix: string;
  /** The app's own texts, reachable as t("app.…"). */
  texts: { de: object; en: object };
  /** Rendered once someone is signed in. */
  app: ReactNode;
  /** First admin page below the prefix. */
  adminPath?: string;
  /** Pages reachable without signing in, by path below the prefix (e.g. "/portal/signup"). */
  publicPages?: Record<string, ReactNode>;
  /** Shown under the sign-in form. */
  loginExtra?: ReactNode;
}

/** Starts the web app in #root. */
export function mountApp({
  prefix,
  texts,
  app,
  adminPath = "/admin/branding",
  publicPages,
  loginExtra,
}: MountOptions): void {
  const api = createCoreApi(prefix);
  const language = navigator.language.toLowerCase().startsWith("de")
    ? "de"
    : "en";
  document.documentElement.lang = language;
  void i18next.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      de: { translation: { ...locales.de, app: texts.de } },
      en: { translation: { ...locales.en, app: texts.en } },
    },
  });
  i18next.on("languageChanged", (lng) => (document.documentElement.lang = lng));

  // Branding colours override the defaults compiled into the stylesheet.
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${api.base}/core/branding.css`;
  document.head.appendChild(css);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    },
  });

  function Root() {
    const { t } = useTranslation();
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider closeLabel={t("shell.close")}>
          <Gate
            prefix={prefix}
            api={api}
            adminHref={`${prefix}${adminPath}`}
            publicPages={publicPages}
            loginExtra={loginExtra}
          >
            {app}
          </Gate>
        </ToastProvider>
      </QueryClientProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
