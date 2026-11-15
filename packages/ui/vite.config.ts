import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serves the playground. The apps bundle this package from source themselves.
export default defineConfig({
  root: "playground",
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true },
});
