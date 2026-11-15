// Builds the web app of Tickvana and Nuvenna into apps/<app>/dist/web.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const app of ["tickvana"]) {
  const cwd = fileURLToPath(new URL(`../apps/${app}/`, import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build"],
    {
      cwd,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
