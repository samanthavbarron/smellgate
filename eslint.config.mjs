import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated lexicon bindings from `pnpm build:lex`. The ts-lex codegen
    // intentionally uses `as any` casts on circular ref initializers; these
    // files are never hand-edited, so linting them is noise.
    "lib/lexicons/**",
  ]),
]);

export default eslintConfig;
