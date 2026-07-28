import eslint from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "node_modules",
      "dist",
      "eslint.config.js",
      // Plain-JS stub executed as a fake CLI binary in tests, not project code.
      "test/fake-catena.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
)
