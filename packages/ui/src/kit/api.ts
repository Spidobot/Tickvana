// Calls to the core API that every app shares (sign-in, branding, setup).
// App-specific routes use the client generated from OpenAPI instead.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Me {
  id: string;
  email: string;
  displayName: string;
  kind: "internal" | "customer" | "service";
  locale: string;
  timezone: string;
}
export interface Providers {
  password: boolean;
  oidc: { label: string; autoRedirect: boolean } | null;
}
export interface BrandingInfo {
  productName: string;
  accent: string;
  loginText: string;
  footerText: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
}

export type CoreApi = ReturnType<typeof createCoreApi>;

/** `prefix` is the app's path, e.g. "/tickvana". */
export function createCoreApi(prefix: string) {
  const base = `${prefix}/api`;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers:
        body === undefined || body instanceof FormData
          ? undefined
          : { "content-type": "application/json" },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = data?.error;
      throw new ApiError(
        res.status,
        e?.code ?? "unknown",
        e?.message ?? res.statusText,
        e?.details,
      );
    }
    return data as T;
  }

  return {
    base,
    call,
    me: () => call<Me>("GET", "/core/auth/me"),
    providers: () => call<Providers>("GET", "/core/auth/providers"),
    login: (email: string, password: string) =>
      call<Me>("POST", "/core/auth/login", { email, password }),
    logout: () => call<void>("POST", "/core/auth/logout", {}),
    forgotPassword: (email: string) =>
      call<void>("POST", "/core/auth/password/forgot", { email }),
    resetPassword: (token: string, password: string) =>
      call<void>("POST", "/core/auth/password/reset", { token, password }),
    setupNeeded: () => call<{ needed: boolean }>("GET", "/core/setup"),
    setup: (body: Record<string, string>) =>
      call<{ id: string }>("POST", "/core/setup", body),
    branding: () => call<BrandingInfo>("GET", "/core/branding"),
    saveBranding: (body: Partial<BrandingInfo & { customCss: string }>) =>
      call<BrandingInfo>("PUT", "/core/branding", body),
    customCss: () =>
      call<{ customCss: string }>("GET", "/core/branding/custom-css"),
    uploadBrandingImage: (
      slot: "logo-light" | "logo-dark" | "favicon",
      file: File,
    ) => {
      const form = new FormData();
      form.append("file", file);
      return call<{ id: string }>(
        "POST",
        `/core/attachments?ownerType=branding&ownerId=${slot}`,
        form,
      );
    },
    isSystemAdmin: () =>
      call<unknown>("GET", "/core/permissions/global").then(
        () => true,
        () => false,
      ),
    /** Where the browser goes to sign in at the identity provider. */
    oidcLoginUrl: (returnTo: string) =>
      `${base}/core/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
  };
}
