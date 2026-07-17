import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

const typedFiles = ["extensions/**/*.ts"];

export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**", "patches/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  {
    files: ["extensions/**/*.{ts,mjs}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      security,
      sonarjs,
      unicorn,
    },
    rules: {
      "import-x/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import-x/no-duplicates": "error",
      "max-len": ["error", { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreUrls: true }],
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-non-literal-regexp": "error",
      "security/detect-pseudoRandomBytes": "error",
      "sonarjs/cognitive-complexity": ["error", 15],
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "unicorn/consistent-function-scoping": "error",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "unicorn/no-abusive-eslint-disable": "error",
      "unicorn/prefer-node-protocol": "error",
    },
  },
  {
    files: typedFiles,
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["extensions/**/*.test.mjs"],
    rules: {
      "sonarjs/no-duplicate-string": "off",
    },
  },
);
