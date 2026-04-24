import { config as base } from "@workspace/eslint-config/base"

/**
 * E2E workspace lint — extends the repo base with rules specific to Playwright specs.
 * The goal is to surface the anti-patterns listed in docs/RECORDING.md (sleeps, focused tests,
 * absolute URLs, selector leakage) before they reach CI.
 *
 * @type {import("eslint").Linter.Config}
 */
export default [
  ...base,

  // Rules for specs (tests/**/*.spec.ts)
  {
    files: ["tests/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // page.waitForTimeout() — the #1 source of flake. Use expect.poll / locator.waitFor / waitForResponse.
          selector: "CallExpression[callee.object.name='page'][callee.property.name='waitForTimeout']",
          message: "Do not use page.waitForTimeout. Prefer expect.poll, locator.waitFor, or page.waitForResponse.",
        },
        {
          // test.only — would quietly scope CI to a single test and skip the rest.
          selector: "MemberExpression[object.name='test'][property.name='only']",
          message: "test.only is forbidden. Remove before committing — it would silently skip the rest of the suite.",
        },
        {
          // describe.only — same reason as test.only.
          selector: "MemberExpression[object.name='describe'][property.name='only']",
          message: "describe.only is forbidden. Remove before committing.",
        },
        {
          // console.log/debug in specs — CI logs get noisy fast. Use test.info().annotations or step names.
          selector: "CallExpression[callee.object.name='console'][callee.property.name=/^(log|debug|info)$/]",
          message: "Avoid console.* in specs; use test.info().annotations or descriptive step names instead.",
        },
      ],

      // Absolute URLs break the multi-env baseURL strategy.
      "no-restricted-imports": [
        "off",
      ],
    },
  },

  // Recorded specs must route through our fixtures so tenantGuard is always available.
  {
    files: ["tests/recorded/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              message:
                "Recorded specs must import from '../../fixtures/base' so tenantGuard is wired. Re-run `pnpm import --file <recording>` to normalise.",
            },
          ],
        },
      ],
    },
  },

  // Scripts and reporters are node-only code — looser rules (they don't run in the browser).
  {
    files: ["scripts/**/*.ts", "reporters/**/*.ts", "global-setup.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // Underscore-prefixed params are intentional placeholders — test.skip stubs, reporter hooks.
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  {
    ignores: [
      "node_modules/**",
      "test-results/**",
      "reports/**",
      ".auth/**",
      "recordings/**",
      "playwright-report/**",
    ],
  },
]
