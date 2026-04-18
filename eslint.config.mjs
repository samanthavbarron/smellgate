import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next (re-declared because passing a
    // custom `ignores` to the flat-config helper replaces the defaults).
    // Use `**/` prefixes so that sibling git worktrees and any nested copy of
    // these dirs (e.g. `.claude/worktrees/<name>/.next/`) are also ignored.
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    // Generated lexicon bindings from `pnpm build:lex`. The ts-lex codegen
    // intentionally uses `as any` casts on circular ref initializers; these
    // files are never hand-edited, so linting them is noise.
    "**/lib/lexicons/**",
    // Sibling git worktrees created by the Claude Code harness live under
    // `.claude/worktrees/<name>/` and are full checkouts of the repo. Without
    // this ignore, running `pnpm lint` from the main checkout walks into every
    // sibling worktree and reports thousands of phantom errors (generated
    // lexicons, stale `.next/` builds, etc.). See issue #38.
    ".claude/**",
    // Playwright fixtures use `use()` as the fixture-value setter, which
    // collides with ESLint's `react-hooks/rules-of-hooks` heuristic. Lint
    // for e2e specs happens via `pnpm exec playwright test`'s TS compile;
    // excluding them here keeps `pnpm lint` green without weakening the
    // rule for real component code.
    "tests/e2e/**",
    // Playwright run outputs (HTML report + trace viewer bundle). The
    // trace viewer ships minified upstream JS that trips many rules —
    // not our code, never checked in (see .gitignore).
    "**/playwright-report/**",
    "**/test-results/**",
  ]),
]);

export default eslintConfig;
