import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the API is the local worker (`npm run dev` in ../worker, port 8787).
export default defineConfig({
  plugins: [react()],
  // The app imports the IVL engine and the Worker's data modules directly (../worker, ../../scripts).
  server: { proxy: { "/v1": "http://localhost:8787" }, fs: { allow: ["../.."] } },
  build: { chunkSizeWarningLimit: 2000 },
});
