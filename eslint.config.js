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
      // Gradually enable strict rules - these are now warnings to track progress
      "@typescript-eslint/no-explicit-any": "warn", // Upgraded from "off"
      "@typescript-eslint/no-unsafe-assignment": "warn", // Upgraded from "off"
      "@typescript-eslint/no-unsafe-call": "warn", // Upgraded from "off"
      "@typescript-eslint/no-unsafe-member-access": "warn", // Upgraded from "off"
      "@typescript-eslint/no-unsafe-argument": "warn", // Upgraded from "off"
      "@typescript-eslint/no-unsafe-return": "warn", // Upgraded from "off"

      // Enable important rules that prevent bugs
      "@typescript-eslint/no-floating-promises": "error", // Catch unhandled promises
      "@typescript-eslint/require-await": "warn", // Flag unnecessary async
      "@typescript-eslint/no-unnecessary-type-assertion": "warn", // Clean up redundant assertions

      // Keep disabled for legitimate use cases
      "@typescript-eslint/no-unused-expressions": "off", // Allow standalone expressions

      // Enforce no unused vars with underscore prefix support
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
    files: ["**/*.test.ts", "tests/**/*.ts"],
    rules: {
      // Allow unbound methods in tests (common pattern with mocks/spies)
      "@typescript-eslint/unbound-method": "off",

      // Relax type safety rules for test files - mocking often requires type flexibility
      "@typescript-eslint/no-explicit-any": "off", // Mocks often need any
      "@typescript-eslint/no-unsafe-assignment": "off", // Mock data assignments
      "@typescript-eslint/no-unsafe-call": "off", // Calling mocked functions
      "@typescript-eslint/no-unsafe-member-access": "off", // Accessing mock properties
      "@typescript-eslint/no-unsafe-argument": "off", // Passing mock arguments
      "@typescript-eslint/no-unsafe-return": "off", // Returning mock values
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
