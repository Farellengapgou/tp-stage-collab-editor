import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: apiTarget,
        ws: true
      },
      "/editors": { target: apiTarget },
      "/documents": { target: apiTarget },
      "/downloads": { target: apiTarget },
      "/health": { target: apiTarget }
    }
  }
});
