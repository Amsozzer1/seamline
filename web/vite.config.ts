import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { seamcore: fileURLToPath(new URL("../seamcore/pkg-web/seamcore.js", import.meta.url)) },
  },
  server: {
    // The WASM package lives outside web/, which Vite does not serve by default.
    fs: { allow: [".."] },
    proxy: { "/api": "http://localhost:3001" },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
