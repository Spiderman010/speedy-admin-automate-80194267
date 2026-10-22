import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Tests raken nooit een echt Supabase-project. De getrackte `.env` bevat de
// productie-URL en -sleutel; `test.env` overschrijft die (en elke shellwaarde)
// in elke testworker, zodat `import.meta.env` en `process.env` hier altijd
// inert zijn. De netwerkwacht in src/test/setup.ts is de tweede laag.
const INERT_SUPABASE_ENV = {
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_PUBLISHABLE_KEY: "ci-inert-not-a-real-supabase-key",
  VITE_SUPABASE_ANON_KEY: "ci-inert-not-a-real-supabase-key",
  VITE_SUPABASE_PROJECT_ID: "ci-inert-project",
};

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    env: INERT_SUPABASE_ENV,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
