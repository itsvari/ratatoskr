import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "admin",
  plugins: [react(), tailwindcss(), cloudflare({
    configPath: process.env.RATATOSKR_CONFIG ?? "../wrangler.jsonc",
    persistState: { path: process.env.RATATOSKR_STATE_DIRECTORY ?? fileURLToPath(new URL("./.wrangler/state", import.meta.url)) },
    ...(process.env.RATATOSKR_BUILD_DIRECTORY ? { viteEnvironment: { name: "worker" } } : {}),
  })],
  resolve: { alias: { "@": fileURLToPath(new URL("./admin", import.meta.url)) } },
  build: { outDir: process.env.RATATOSKR_BUILD_DIRECTORY ?? "../dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173 },
});
