# FEAT: #18 (reduced) — delegated SharePoint team-site file read

Issue: https://github.com/ACTSIS/outlook-mcp/issues/18 (rewritten 2026-10-15: app-only deferred)
Branch: `feat/sharepoint-delegated-read`
Source: owner decision 2026-10-15 — keep the delegated `.Shared`-style approach used for shared mailboxes (issues #28, #37); application-only / client-credentials support is explicitly deferred until a concrete unattended use case exists. Admin consent for delegated `Sites.Read.All` already granted in Entra ID.

## Specs

- S1 (user, 2026-10-15, verbatim): "Vamos con tu sugerencia, ya le he dado el permiso a la app en Entra ID, solo falta implementarlo aquí"
- S2: Delegated scope `Sites.Read.All` joins the default acquisition union in `config.js` (no app-only / client-credentials code paths in this feature; app-only stays deferred). No `MS_SCOPES` override silently drops it — document that an explicit `MS_SCOPES` must include it.
- S3: New `sites/` domain, read-only, wired into root `index.js`, mirroring the existing domain pattern (`teams/` structure, OneDrive behavior):
  - `list-sites`: search sites by name (`GET /sites?search={query}` with `SITE_SELECT_FIELDS`); empty/missing query → `search` omitted lists sites the user can access.
  - `list-site-files`: list a site's default document library items at a path (`GET /sites/{siteId}/drive/root:/{path}:/{children}` or `.../root/children` for root), `$select` reusing `ONEDRIVE_SELECT_FIELDS`, `$orderby=name`, `count` capped at 50 like OneDrive.
  - `download-site-file`: return the pre-authenticated `@microsoft.graph.downloadUrl` for a file by `itemId` or `path` (`GET /sites/{siteId}/drive/items/{id}` / `.../root:/{path}`); folders refuse with a clear message; missing both `itemId` and `path` → validation message.
- S4: Tool naming and descriptions are English; every tool handler follows the guard order of existing domains: argument validation → `ensureAuthenticated()` → Graph call → mapped error text (auth-required message, 403 surfaced with `SITE_ACCESS_DENIED`-style wording naming the site, other errors generic). Delegated-only: no fallback to any other identity.
- S5: Handler tests in `test/sites/` mirroring `test/teams/`: per-tool validation, auth-required, success endpoints + select fields + URL-encoding of path/siteId, error mapping; plus `test/index.test.js` and `test/config/` coverage for the new scope and tool registration.

## Tasks

### T1: Scope + `sites/` domain (TDD) — DONE (commit 39067e2)

- RED first: `test/config/` scope-union test including `Sites.Read.All`; `test/sites/` handler tests for the three tools (validation, success endpoints/fixtures, error mapping).
- GREEN: add scope to `config.js` (`DEFAULT_AUTH_SCOPES`), create `sites/list-sites.js`, `sites/list-site-files.js`, `sites/download-site-file.js`, `sites/index.js`; wire into root `index.js` and add `SITE_SELECT_FIELDS` to `config.js`.
- Focused: `npx jest test/sites test/config test/index.test.js`.

### T2: Docs + OpenSpec + full gate — DONE (commit 9de8efc)

- README tool table rows + section; `docs/authentication.md` scope union + delegated-only note (incl. the `MS_SCOPES` override warning); new `openspec/specs/sharepoint/spec.md` following the per-behavior rule.
- Focused: docs consistency check; then full `npm test`, `npm run lint`, `npm run format:check`.

## Checks per task

- Focused per T1; full `npm test` + `npm run lint` + `npm run format:check` before each feature commit.

## Log

- L1 (2026-10-15): user mandate (verbatim): "Vamos con tu sugerencia, ya le he dado el permiso a la app en Entra ID, solo falta implementarlo aquí". Standing constraint from the #28 discussion: no application permissions; delegated `Sites.Read.All` only. Scope per S2-S5; acceptance criteria from the rewritten issue.
- L2 (2026-10-15): Live-token note: a previously acquired token keeps its old `scp`; the user must re-run initial acquisition (`npm run auth-server` flow) once so the token contains `Sites.Read.All`. Verification of the token's `scp` is an explicit acceptance check after T1.
- L3 (2026-10-15): TDD cycle completed: RED (missing modules/scope) → GREEN. One defect caught by tests during GREEN: full-path encodeURIComponent corrupted the `root:/a/b` separators; fixed by per-segment encoding in both list-site-files and download-site-file, pinned by a multi-segment test. Focused 37/37; later 869/869 full suite, lint + Prettier clean. Commits 39067e2 (T1), 9de8efc (T2).
