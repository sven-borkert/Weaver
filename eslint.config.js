import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next",
      "apps/*/.next",
      "generated",
      "packages/db/generated",
      ".turbo",
    ],
  },
  ...nextCoreWebVitals,
  {
    // eslint-config-next parses .js/.jsx with Next's compiled
    // @babel/eslint-parser, whose scope manager predates ESLint 10's
    // ScopeManager#addGlobals API and crashes SourceCode.finalize
    // (babel/babel#17804). The repo is TypeScript-first (allowJs), so parse
    // JS with @typescript-eslint/parser instead.
    files: ["**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: "module",
      },
    },
  },
  {
    // eslint-config-next sets the React version to "detect", which crashes
    // under ESLint 10 (eslint-plugin-react 7.x calls the removed
    // context.getFilename() during detection). Pin the version instead.
    settings: {
      react: {
        version: "19.2",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["apps/web/tests/e2e/mock-ai-server.test.mjs"],
        },
      },
    },
  },
  {
    files: ["apps/web/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@weaver/git-store",
              importNames: [
                "withProjectRepo",
                "withExistingProjectRepo",
                "withExistingProjectRepoReader",
              ],
              message:
                "Import repo helpers from services/projectRepo so RepoLockTimeoutError maps to a CoreError.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/**"],
    ignores: ["packages/core/src/services/projectRepo.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@weaver/git-store",
              importNames: [
                "withProjectRepo",
                "withExistingProjectRepo",
                "withExistingProjectRepoReader",
              ],
              message:
                "Import repo helpers from services/projectRepo so RepoLockTimeoutError maps to a CoreError.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/tests/integration/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
