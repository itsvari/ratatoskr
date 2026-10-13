import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "admin",
  plugins: [react(), tailwindcss(), cloudflare({
    configPath: process.env.RATATOSKR_CONFIG ?? "../wrangler.jsonc",
    persistState: { path: fileURLToPath(new URL("./.wrangler/state", import.meta.url)) },
  })],
  resolve: { alias: { "@": fileURLToPath(new URL("./admin", import.meta.url)) } },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173 },
});
