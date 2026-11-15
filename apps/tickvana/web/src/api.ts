// Typed access to Tickvana's REST API. The types come from the server's OpenAPI
// document (api.gen.ts, written by the build).
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@tvn/ui";
import createClient from "openapi-fetch";
import type { paths } from "./api.gen.js";

export const api = createClient<paths>({ baseUrl: "" });

type Json<
  P extends keyof paths,
  M extends keyof paths[P],
> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer T } } };
}
  ? T
  : never;

export type Meta = Json<"/tickvana/api/meta", "get">;
export type Project = Json<"/tickvana/api/projects/{key}", "get">;
export type ProjectSummary = Json<"/tickvana/api/projects", "get">[number];
export type Issue = Json<"/tickvana/api/issues/{key}", "get">;
export type Field = Json<"/tickvana/api/fields", "get">[number];
export type Layout = Json<"/tickvana/api/field-layouts/{id}", "get">;
export type Transition = Json<
  "/tickvana/api/issues/{key}/transitions",
  "get"
>[number];
export type Comment = Json<
  "/tickvana/api/issues/{key}/comments",
  "get"
>[number];
export type HistoryEntry = Json<
  "/tickvana/api/issues/{key}/history",
  "get"
>[number];
export type User = Json<"/tickvana/api/core/users", "get">[number];

/** Turns an openapi-fetch result into data, or throws the server's error. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    const e = (
      error as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | undefined
    )?.error;
    throw new ApiError(
      response.status,
      e?.code ?? "unknown",
      e?.message ?? response.statusText,
      e?.details,
    );
  }
  return data as T;
}

export const keys = {
  meta: ["meta"] as const,
  users: ["users"] as const,
  fields: ["fields"] as const,
  layout: (id: string) => ["layout", id] as const,
  projects: ["projects"] as const,
  project: (key: string) => ["project", key] as const,
  issues: (projectKey: string) => ["issues", projectKey] as const,
  issue: (key: string) => ["issue", key] as const,
  issuePart: (key: string, part: string) => ["issue", key, part] as const,
};

export const useMeta = () =>
  useQuery({
    queryKey: keys.meta,
    queryFn: () => unwrap(api.GET("/tickvana/api/meta")),
    staleTime: 5 * 60_000,
  });
export const useFields = () =>
  useQuery({
    queryKey: keys.fields,
    queryFn: () => unwrap(api.GET("/tickvana/api/fields")),
    staleTime: 5 * 60_000,
  });
// ponytail: the first 100 people, enough for pickers in small installations. Switch to search-as-you-type when that stops being true.
export const useUsers = () =>
  useQuery({
    queryKey: keys.users,
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/core/users", {
          params: { query: { limit: 100 } },
        }),
      ),
    staleTime: 60_000,
  });
export const useLayout = (id: string | undefined) =>
  useQuery({
    queryKey: keys.layout(id ?? ""),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/field-layouts/{id}", {
          params: { path: { id: id! } },
        }),
      ),
    enabled: !!id,
    staleTime: 60_000,
  });
export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: () => unwrap(api.GET("/tickvana/api/projects")),
  });
export const useProject = (key: string) =>
  useQuery({
    queryKey: keys.project(key),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/projects/{key}", { params: { path: { key } } }),
      ),
  });
export const useIssues = (projectKey: string) =>
  useQuery({
    queryKey: keys.issues(projectKey),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/projects/{key}/issues", {
          params: { path: { key: projectKey }, query: { limit: 200 } },
        }),
      ),
  });
export const useIssue = (key: string) =>
  useQuery({
    queryKey: keys.issue(key),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}", { params: { path: { key } } }),
      ),
  });
