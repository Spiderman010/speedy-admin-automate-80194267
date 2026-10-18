import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "supabase/functions/mcp/index.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Temporary legacy lint baseline: these rules are disabled to make the existing
      // codebase lintable without changing app behavior. Re-enable/fix in a later cleanup PR.
      // Counts as of PR-E (all pre-existing, none introduced by this PR):
      //   no-unused-vars        — pervasive throughout all source files
      //   no-explicit-any       — ~94 occurrences across src/ (catch blocks, Supabase responses, etc.)
      //   no-require-imports    — 1 occurrence: tailwind.config.ts uses require("tailwindcss-animate")
      //   no-empty-object-type  — 2 occurrences in src/
      //   no-useless-escape     — 2 occurrences in src/
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // Lovable-managed file ("automatically generated. Do not edit it directly"; rewritten
    // by gpt-engineer-app[bot] in dd4a3a1), so a hand edit would be overwritten. Its
    // `let timer` is read in the `finish` closure before `timer = setTimeout(...)`,
    // which is exactly what prefer-const's ignoreReadBeforeAssign allows. One file,
    // one rule option; prefer-const stays an error for everything else in it.
    files: ["src/integrations/supabase/previewAuthStorage.ts"],
    rules: {
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
);
