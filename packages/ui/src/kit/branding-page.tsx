// Admin page for name, colours, texts, logos and custom CSS.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Field, Input, Textarea } from "../components.js";
import { useToast } from "../overlays.js";
import { useApp } from "./app.js";

const SLOTS = [
  ["logo-light", "logoLight", "logoLightUrl"],
  ["logo-dark", "logoDark", "logoDarkUrl"],
  ["favicon", "favicon", "faviconUrl"],
] as const;

/** White or near-black, whichever reads better on the colour (WCAG luminance). */
function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05) >= 4.5 ? "#ffffff" : "#171717";
}

export function BrandingSettings() {
  const { t } = useTranslation();
  const { api, branding } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    productName: branding.productName,
    accent: branding.accent,
    loginText: branding.loginText,
    footerText: branding.footerText,
    customCss: "",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const css = useQuery({
    queryKey: ["core", "custom-css"],
    queryFn: api.customCss,
  });
  useEffect(() => {
    if (css.data) setForm((f) => ({ ...f, customCss: css.data.customCss }));
  }, [css.data]);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["core", "branding"] });
    // The stylesheet is a plain <link>: point it at a fresh URL so the browser refetches.
    const link = document.querySelector<HTMLLinkElement>(
      'link[href*="/core/branding.css"]',
    );
    if (link) link.href = `${api.base}/core/branding.css?v=${Date.now()}`;
  };
  const failed = () =>
    toast({
      title: t("state.errorTitle"),
      text: t("state.errorText"),
      tone: "negative",
    });

  const save = useMutation({
    mutationFn: () => api.saveBranding(form),
    onSuccess: async () => {
      await reload();
      toast({ title: t("state.saved") });
    },
    onError: failed,
  });
  const upload = useMutation({
    mutationFn: ({
      slot,
      file,
    }: {
      slot: (typeof SLOTS)[number][0];
      file: File;
    }) => api.uploadBrandingImage(slot, file),
    onSuccess: reload,
    onError: failed,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="grid max-w-[960px] grid-cols-[minmax(0,1fr)_280px] items-start gap-6 max-lg:grid-cols-1">
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <Card className="flex flex-col gap-4 p-6">
          <Field label={t("branding.productName")}>
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
          <Field label={t("branding.accent")} hint={t("branding.accentHint")}>
            {(p) => (
              <div className="flex items-center gap-2">
                <input
                  {...p}
                  type="color"
                  value={form.accent}
                  onChange={set("accent")}
                  className="h-9 w-16 rounded-md border border-line-strong bg-surface p-1"
                />
                <span className="font-mono text-sm text-fg-2">
                  {form.accent}
                </span>
              </div>
            )}
          </Field>
          <Field label={t("branding.loginText")}>
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                maxLength={500}
                value={form.loginText}
                onChange={set("loginText")}
              />
            )}
          </Field>
          <Field label={t("branding.footerText")}>
            {(p) => (
              <Input
                {...p}
                maxLength={200}
                value={form.footerText}
                onChange={set("footerText")}
              />
            )}
          </Field>
        </Card>

        <Card className="flex flex-col gap-4 p-6">
          {SLOTS.map(([slot, label, urlKey]) => (
            <Field key={slot} label={t(`branding.${label}`)}>
              {(p) => (
                <div className="flex items-center gap-4">
                  <span
                    className={`flex h-12 w-28 items-center justify-center rounded-md border border-line ${slot === "logo-dark" ? "bg-[#141415]" : "bg-[#fafafa]"}`}
                  >
                    {branding[urlKey] && (
                      <img
                        src={branding[urlKey]}
                        alt=""
                        className="max-h-8 max-w-24"
                      />
                    )}
                  </span>
                  <input
                    {...p}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
                    className="text-sm text-fg-2 file:mr-3 file:h-8 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:text-sm file:text-fg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) upload.mutate({ slot, file });
                      e.target.value = "";
                    }}
                  />
                </div>
              )}
            </Field>
          ))}
        </Card>

        <Card className="flex flex-col gap-4 p-6">
          <Field
            label={t("branding.customCss")}
            hint={t("branding.customCssHint")}
          >
            {(p) => (
              <Textarea
                {...p}
                rows={8}
                spellCheck={false}
                className="font-mono text-sm"
                value={form.customCss}
                onChange={set("customCss")}
              />
            )}
          </Field>
        </Card>

        <div>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {t("branding.save")}
          </Button>
        </div>
      </form>

      {/* Shows the chosen colour before saving, with the same text pairing the server derives. */}
      <Card
        className="sticky top-20 flex flex-col gap-4 p-6"
        style={
          {
            "--brand-accent": form.accent,
            "--brand-on-accent": onAccent(form.accent),
          } as React.CSSProperties
        }
      >
        <p className="text-sm text-fg-2">{t("branding.preview")}</p>
        <p className="text-lg font-medium text-fg">{form.productName}</p>
        <Button variant="primary" className="self-start">
          {t("branding.previewButton")}
        </Button>
        <span className="text-accent-ink">{t("branding.previewLink")}</span>
      </Card>
    </div>
  );
}
