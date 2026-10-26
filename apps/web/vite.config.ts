import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      events: "events/",
      util: "util/"
    }
  },
  server: {
    proxy: {
      "/ws": {
        target: apiTarget,
        ws: true
      },
      "/api": {
        target: apiTarget,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
