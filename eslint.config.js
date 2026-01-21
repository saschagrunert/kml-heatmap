// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "htmlcov/**",
      "docs/**",
      "kml_heatmap/static/**",
      "kml_heatmap/templates/**",
      ".git/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow explicit any for now (can be tightened later)
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unsafe operations for legacy code
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Allow floating promises (fire-and-forget)
      "@typescript-eslint/no-floating-promises": "off",
      // Allow async functions without await
      "@typescript-eslint/require-await": "off",
      // Allow standalone expressions (e.g., for conditional rendering)
      "@typescript-eslint/no-unused-expressions": "off",
      // Allow unnecessary type assertions (sometimes needed for clarity)
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Allow unused vars with underscore prefix
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      // Allow unbound methods in tests (common pattern with mocks/spies)
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        URL: "readonly",
      },
    },
  }
);
