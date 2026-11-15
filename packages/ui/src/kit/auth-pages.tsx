// Pages shown before anyone is signed in: sign-in, forgotten password, reset, first-run setup.
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input } from "../components.js";
import {
  ApiError,
  type BrandingInfo,
  type CoreApi,
  type Providers,
} from "./api.js";
import { Brand } from "./brand.js";

/** Narrow column on the page background. The form is the only raised surface. */
function Frame({
  branding,
  title,
  text,
  children,
  below,
}: {
  branding: BrandingInfo;
  title: string;
  text?: string;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[400px] flex-col justify-center gap-6 px-4 py-12">
      <div className="text-xl font-medium text-fg">
        <Brand branding={branding} size="lg" />
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-fg">{title}</h1>
        {text && <p className="text-fg-2">{text}</p>}
      </div>
      <div className="rounded-lg border border-line bg-surface p-6">
        {children}
      </div>
      {below}
      {branding.footerText && (
        <p className="text-sm text-fg-3">{branding.footerText}</p>
      )}
    </main>
  );
}

const Alert = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="text-sm text-negative">
    {children}
  </p>
);
const Notice = ({ children }: { children: ReactNode }) => (
  <p role="status" className="text-fg">
    {children}
  </p>
);
const linkClass = "text-sm text-accent-ink underline-offset-4 hover:underline";

function useForm(action: () => Promise<unknown>) {
  const mutation = useMutation({ mutationFn: action });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return { ...mutation, onSubmit };
}

export function LoginPage({
  api,
  branding,
  providers,
  onSignedIn,
  extra,
}: {
  api: CoreApi;
  branding: BrandingInfo;
  providers: Providers;
  onSignedIn: () => void;
  /** Shown under the form, e.g. a link to sign up. */
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"login" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useForm(() => api.login(email, password).then(onSignedIn));
  const forgot = useForm(() => api.forgotPassword(email));
  const here = window.location.pathname + window.location.search;

  if (view === "forgot") {
    return (
      <Frame
        branding={branding}
        title={t("auth.forgotTitle")}
        text={t("auth.forgotText")}
        below={
          <button
            type="button"
            className={`${linkClass} self-start`}
            onClick={() => setView("login")}
          >
            {t("auth.backToSignIn")}
          </button>
        }
      >
        {forgot.isSuccess ? (
          <Notice>{t("auth.forgotSent")}</Notice>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={forgot.onSubmit}>
            <Field label={t("auth.email")}>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            {forgot.isError && <Alert>{t("state.errorText")}</Alert>}
            <Button variant="primary" type="submit" disabled={forgot.isPending}>
              {t("auth.sendLink")}
            </Button>
          </form>
        )}
      </Frame>
    );
  }

  const error = login.error instanceof ApiError ? login.error : undefined;
  return (
    <Frame
      branding={branding}
      title={t("auth.signIn")}
      below={
        branding.loginText ? (
          <p className="text-fg-2">{branding.loginText}</p>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {providers.oidc && (
          <>
            <Button
              variant={providers.password ? "secondary" : "primary"}
              onClick={() => window.location.assign(api.oidcLoginUrl(here))}
            >
              {providers.oidc.label}
            </Button>
            <hr className="border-line" />
          </>
        )}
        <form className="flex flex-col gap-4" onSubmit={login.onSubmit}>
          <Field label={t("auth.email")}>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("auth.password")}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {login.isError && (
            <Alert>
              {error?.status === 429
                ? t("auth.tooManyAttempts")
                : error?.status === 401
                  ? t("auth.wrongCredentials")
                  : t("state.errorText")}
            </Alert>
          )}
          <Button variant="primary" type="submit" disabled={login.isPending}>
            {t("auth.signIn")}
          </Button>
          <button
            type="button"
            className={`${linkClass} self-start`}
            onClick={() => setView("forgot")}
          >
            {t("auth.forgot")}
          </button>
        </form>
        {extra}
      </div>
    </Frame>
  );
}

export function ResetPasswordPage({
  api,
  branding,
  signInHref,
}: {
  api: CoreApi;
  branding: BrandingInfo;
  signInHref: string;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const reset = useForm(() => api.resetPassword(token, password));
  const short = password.length > 0 && password.length < 10;

  return (
    <Frame
      branding={branding}
      title={t("auth.resetTitle")}
      below={
        <a className={`${linkClass} self-start`} href={signInHref}>
          {t("auth.backToSignIn")}
        </a>
      }
    >
      {reset.isSuccess ? (
        <Notice>{t("auth.resetDone")}</Notice>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={reset.onSubmit}>
          <Field
            label={t("auth.newPassword")}
            hint={t("auth.passwordHint")}
            error={short ? t("auth.passwordTooShort") : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {reset.isError && <Alert>{t("auth.resetInvalid")}</Alert>}
          <Button
            variant="primary"
            type="submit"
            disabled={reset.isPending || short}
          >
            {t("auth.setPassword")}
          </Button>
        </form>
      )}
    </Frame>
  );
}

export function SetupPage({
  api,
  branding,
  onDone,
}: {
  api: CoreApi;
  branding: BrandingInfo;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState({
    displayName: "",
    email: "",
    password: "",
    productName: branding.productName,
    accent: branding.accent,
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const short = form.password.length > 0 && form.password.length < 10;

  const setup = useForm(() =>
    api
      .setup({
        ...form,
        locale: i18n.language.slice(0, 2),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      .then(onDone),
  );

  return (
    <Frame branding={branding} title={t("setup.title")} text={t("setup.text")}>
      <form className="flex flex-col gap-4" onSubmit={setup.onSubmit}>
        <Field label={t("setup.yourName")}>
          {(p) => (
            <Input
              {...p}
              autoComplete="name"
              required
              value={form.displayName}
              onChange={set("displayName")}
            />
          )}
        </Field>
        <Field label={t("auth.email")}>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={set("email")}
            />
          )}
        </Field>
        <Field
          label={t("auth.password")}
          hint={t("auth.passwordHint")}
          error={short ? t("auth.passwordTooShort") : undefined}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={form.password}
              onChange={set("password")}
            />
          )}
        </Field>
        <hr className="border-line" />
        <Field label={t("setup.productName")} hint={t("setup.productNameHint")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={60}
              value={form.productName}
              onChange={set("productName")}
            />
          )}
        </Field>
        <Field label={t("setup.accent")}>
          {(p) => (
            <input
              {...p}
              type="color"
              value={form.accent}
              onChange={set("accent")}
              className="h-9 w-16 rounded-md border border-line-strong bg-surface p-1"
            />
          )}
        </Field>
        {setup.isError && (
          <Alert>
            {setup.error instanceof ApiError
              ? setup.error.message
              : t("state.errorText")}
          </Alert>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={setup.isPending || short}
        >
          {t("setup.submit")}
        </Button>
      </form>
    </Frame>
  );
}
