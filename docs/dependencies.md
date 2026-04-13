# Dependencies

Notes on non-obvious dependency choices and version pins. If you find
yourself adding or bumping anything here, write down *why* — future
maintainers (human and agent) shouldn't have to git-blame to learn the
reason.

## `better-sqlite3` pinned via `pnpm.overrides`

`package.json` includes a `pnpm.overrides` entry pinning
`better-sqlite3@^12.5.0`. The reason: `@atproto/pds` transitively
depends on an older `better-sqlite3` (10.x) whose prebuilt binaries do
not load on Node 24, and whose source build fails against the Node 24
native API. We use `@atproto/pds` only as a dev/test dependency (the
in-process PDS via `@atproto/dev-env`), but `pnpm install` still
resolves the transitive copy, and that single bad install breaks the
whole tree.

The override forces every consumer of `better-sqlite3` in the workspace
onto 12.x, which builds cleanly on Node 24 and is API-compatible for
the way `@atproto/pds` uses it. Originally introduced in PR #17.

If you bump `@atproto/pds` and its transitive `better-sqlite3` reaches
a Node-24-compatible version, this override can be dropped.
