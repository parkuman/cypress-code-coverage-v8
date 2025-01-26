import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
  },

  preview: {
    port: 5173,
  },

  build: {
    sourcemap: true,
  },
});