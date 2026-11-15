// Runs one built app locally: node scripts/dev.mjs tickvana|nuvenna
// Needs a database; the default matches
//   docker run -d --name tvn-dev-db -e POSTGRES_PASSWORD=dev -p 55440:5432 postgres:16
// Build first (pnpm build). Everything can be overridden through the environment.
import { fileURLToPath } from "node:url";

const app = process.argv[2] ?? "tickvana";
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const port = process.env.PORT ?? "3000";

process.env.PORT = port;
process.env.DB_URL ??= "postgres://postgres:dev@localhost:55440/postgres";
process.env.BASE_URL ??= `http://localhost:${port}`;
process.env.SECRET_KEY ??= "development-only-secret-key-0123456789";
process.env.WEB_ROOT ??= path(`../apps/${app}/dist/web`);
process.env.STORAGE_PATH ??= path("../.data");

await import(`../apps/${app}/dist/index.js`);
