import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".vercel", "dist", ".output", ".vinxi"] },
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
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Audit-4 L74: unused vars are errors (was off — dead code
      // never flagged anywhere). Mirrors tsconfig noUnusedLocals.
      // ignoreRestSiblings allows the omit-key destructure
      // (`const { x, ...rest }`) — tsc treats rest siblings the
      // same way; the variable is excluded, never read, on purpose.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  // Audit-3 A3-N10: deploy-critical build scripts are linted too
  // (plain Node ESM — no TS, no React rules).
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },
  // Audit-4 L74: the hand-written service worker is linted too
  // (classic script, ServiceWorker globals — bare `clients` /
  // `registration` / `skipWaiting` are NOT browser globals, so
  // without this block a future bare use would read as undefined).
  // The shipped file itself uses `self.*` throughout (`self` IS
  // a browser global); the block covers the bare forms too.
  {
    files: ["public/sw.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      // The omit-key destructure (`const { actions, ...rest }`) is
      // intentional — `actions` is excluded from the retry, never
      // read. ignoreRestSiblings allows exactly that pattern.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  eslintPluginPrettier,
);
