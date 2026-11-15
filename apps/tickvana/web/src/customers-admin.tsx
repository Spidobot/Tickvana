// Customers: organizations and portal access (administration), and the
// customers of one project (its settings).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Field as FormField,
  IconButton,
  Input,
  Select,
  useToast,
} from "@tvn/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminFrame } from "./admin.js";
import { api, unwrap, useProjects } from "./api.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

// ponytail: customer paths take runtime parts openapi-fetch cannot type; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

function useRun() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (promise: Promise<unknown>, ...keys: string[][]) =>
    promise
      .then(() =>
        Promise.all(
          keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        ),
      )
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
}

interface Org {
  id: string;
  name: string;
  members: { id: string; displayName: string; email: string }[];
}
const useOrgs = () =>
  useQuery({
    queryKey: ["organizations"],
    queryFn: () => call<Org[]>("GET", "/organizations"),
  });
const useCustomerUsers = () =>
  useQuery({
    queryKey: ["customer-users"],
    queryFn: () =>
      call<{ id: string; displayName: string; email: string }[]>(
        "GET",
        "/core/users?kind=customer&limit=100",
      ),
  });

export function CustomersAdminPage() {
  const { t } = useTranslation();
  return (
    <AdminFrame title={t("app.admin.pages.customers")}>
      <div className="flex flex-col gap-6">
        <PortalSettings />
        <Organizations />
      </div>
    </AdminFrame>
  );
}

function PortalSettings() {
  const { t } = useTranslation();
  const run = useRun();
  const projects = useProjects().data ?? [];
  const settings = useQuery({
    queryKey: ["portal-settings-admin"],
    queryFn: () =>
      call<{ signup: boolean; openProjectIds: string[] }>(
        "GET",
        "/admin/portal-settings",
      ),
  }).data;
  if (!settings) return null;
  const save = (body: { signup: boolean; openProjectIds: string[] }) =>
    run(call("PUT", "/portal/settings", body), ["portal-settings-admin"]);
  const openIds = settings.openProjectIds;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-base font-medium text-fg">{t("app.cust.portal")}</h2>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={settings.signup}
          onChange={(e) =>
            void save({ signup: e.target.checked, openProjectIds: openIds })
          }
        />
        {t("app.cust.signup")}
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-fg-2">
          {t("app.cust.openProjects")}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {projects.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2 text-sm text-fg"
            >
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={openIds.includes(p.id)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...openIds, p.id]
                    : openIds.filter((x) => x !== p.id);
                  void save({ signup: settings.signup, openProjectIds: next });
                }}
              />
              {p.name}
            </label>
          ))}
        </div>
        <p className="text-sm text-fg-3">{t("app.cust.openHint")}</p>
      </fieldset>
    </Card>
  );
}

function Organizations() {
  const { t } = useTranslation();
  const run = useRun();
  const orgs = useOrgs().data ?? [];
  const users = useCustomerUsers().data ?? [];
  const [name, setName] = useState("");
  const keys = ["organizations"];
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-base font-medium text-fg">
        {t("app.cust.organizations")}
      </h2>
      <form
        className="flex max-w-md items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(call("POST", "/admin/organizations", { name }), keys).then(
            () => setName(""),
          );
        }}
      >
        <FormField label={t("app.cust.newOrganization")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit">{t("app.admin.add")}</Button>
      </form>
      <ul className="flex flex-col divide-y divide-line">
        {orgs.map((o) => (
          <li key={o.id} className="flex flex-col gap-2 py-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium text-fg">{o.name}</span>
              <IconButton
                label={`${t("app.delete")}: ${o.name}`}
                onClick={() =>
                  void run(call("DELETE", `/admin/organizations/${o.id}`), keys)
                }
              >
                <X {...icon} />
              </IconButton>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {o.members.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                >
                  {m.displayName}
                  <IconButton
                    label={`${t("app.perm.remove")}: ${m.displayName}`}
                    onClick={() =>
                      void run(
                        call(
                          "DELETE",
                          `/admin/organizations/${o.id}/members/${m.id}`,
                        ),
                        keys,
                      )
                    }
                  >
                    <X {...icon} />
                  </IconButton>
                </span>
              ))}
              <div className="w-56">
                <Select
                  aria-label={`${t("app.cust.addMember")}: ${o.name}`}
                  placeholder={t("app.cust.addMember")}
                  value={undefined}
                  onValueChange={(id) =>
                    void run(
                      call("PUT", `/admin/organizations/${o.id}/members/${id}`),
                      keys,
                    )
                  }
                  options={users
                    .filter((u) => !o.members.some((m) => m.id === u.id))
                    .map((u) => ({
                      value: u.id,
                      label: `${u.displayName} <${u.email}>`,
                    }))}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Project settings: who may use the project's portal. */
export function ProjectCustomers({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const key = ["project-customers", projectKey];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      call<
        {
          principalType: "user" | "organization";
          principalId: string;
          name: string;
        }[]
      >("GET", `/projects/${projectKey}/customers`),
    retry: false,
  }).data;
  const orgs = useOrgs().data ?? [];
  const users = useCustomerUsers().data ?? [];
  const [invite, setInvite] = useState({ email: "", displayName: "" });
  if (!list) return null;
  const present = new Set(
    list.map((c) => `${c.principalType}:${c.principalId}`),
  );
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-base font-medium text-fg">{t("app.cust.title")}</h3>
      <ul className="flex flex-wrap gap-1">
        {list.map((c) => (
          <li
            key={c.principalType + c.principalId}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
          >
            {c.principalType === "organization" && (
              <span className="text-fg-3">{t("app.cust.org")}:</span>
            )}
            {c.name}
            <IconButton
              label={`${t("app.perm.remove")}: ${c.name}`}
              onClick={() =>
                void run(
                  call("DELETE", `/projects/${projectKey}/customers`, {
                    principalType: c.principalType,
                    principalId: c.principalId,
                  }),
                  key,
                )
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="w-72">
        <Select
          aria-label={t("app.cust.add")}
          placeholder={t("app.cust.add")}
          value={undefined}
          onValueChange={(v) => {
            const [principalType, principalId] = v.split(":");
            void run(
              call("PUT", `/projects/${projectKey}/customers`, {
                principalType,
                principalId,
              }),
              key,
            );
          }}
          options={[
            ...orgs.map((o) => ({
              value: `organization:${o.id}`,
              label: `${t("app.cust.org")}: ${o.name}`,
            })),
            ...users.map((u) => ({
              value: `user:${u.id}`,
              label: `${u.displayName} <${u.email}>`,
            })),
          ].filter((o) => !present.has(o.value))}
        />
      </div>
      <form
        className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            call("POST", `/projects/${projectKey}/customers/invite`, invite),
            key,
            ["customer-users"],
          ).then(() => setInvite({ email: "", displayName: "" }));
        }}
      >
        <div className="w-56">
          <FormField label={t("system.displayName")}>
            {(p) => (
              <Input
                {...p}
                required
                value={invite.displayName}
                onChange={(e) =>
                  setInvite({ ...invite, displayName: e.target.value })
                }
              />
            )}
          </FormField>
        </div>
        <div className="w-64">
          <FormField label={t("auth.email")}>
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                value={invite.email}
                onChange={(e) =>
                  setInvite({ ...invite, email: e.target.value })
                }
              />
            )}
          </FormField>
        </div>
        <Button type="submit">{t("app.cust.invite")}</Button>
      </form>
    </Card>
  );
}
