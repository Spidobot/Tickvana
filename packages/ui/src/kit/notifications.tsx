// The bell in the header: unread count and the latest notifications.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../components.js";
import { Menu } from "../overlays.js";
import { useApp } from "./app.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

interface Notifications {
  unreadCount: number;
  items: {
    id: string;
    title: string;
    text: string;
    url: string;
    read: boolean;
  }[];
}

export function NotificationBell() {
  const { t } = useTranslation();
  const { api } = useApp();
  const queryClient = useQueryClient();
  const queryKey = ["notifications"];
  const data = useQuery({
    queryKey,
    queryFn: () =>
      api.call<Notifications>("GET", "/core/notifications?limit=10"),
    refetchInterval: 60_000,
  }).data;
  const read = (ids?: string[]) =>
    api
      .call("POST", "/core/notifications/read", ids ? { ids } : {})
      .then(() => queryClient.invalidateQueries({ queryKey }));
  const unread = data?.unreadCount ?? 0;
  const label = unread
    ? t("shell.notificationsUnread", { count: unread })
    : t("shell.notifications");

  return (
    <Menu
      trigger={
        <IconButton label={label} className="relative">
          <Bell {...icon} />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-2 rounded-full bg-accent"
            />
          )}
        </IconButton>
      }
      items={[
        ...(data?.items.length
          ? data.items.map((n) => ({
              label: `${n.read ? "" : "• "}${n.title}`,
              onSelect: () => {
                void read([n.id]);
                window.location.assign(n.url);
              },
            }))
          : [
              {
                label: t("shell.noNotifications"),
                onSelect: () => {},
                disabled: true,
              },
            ]),
        ...(unread
          ? [{ label: t("shell.markAllRead"), onSelect: () => void read() }]
          : []),
      ]}
    />
  );
}
