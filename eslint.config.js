// ESLint 9 flat config — TypeScript-aware rules only; Prettier owns formatting.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "*.config.js",
      // The broken-project fixture is intentionally invalid CommonJS — it is
      // the "before" state the E2E test drives the agent to fix.
      "fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // `any` is used deliberately at the Pi SDK boundary (Model<any>, etc.);
      // the SDK's generics don't carry enough information to do better.
      "@typescript-eslint/no-explicit-any": "off",
      // Unused args prefixed with _ are intentional (tool call signatures).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Prefer `import type` — verbatimModuleSyntax requires it anyway.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    // Tests use non-null assertions for fixture lookups on purpose.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettier,
);
