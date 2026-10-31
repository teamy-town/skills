# 894 — versioned designs through generic artifact tools

Implementation under review: `715607b7b723dbd0b464be045d361f5cca171f7e`.
Starting skills commit: `570fde57d7d54c2820628bf73ecf02f307ddee8c`.
The subsequent evidence-only commit preserves these results; `source-manifest.json`
pins every implementation/test/setup file by SHA-256. This is developer self-test,
not independent QA approval. No merge, push, deployment or npm publication occurred.

## Acceptance evidence

| Check | Evidence |
| --- | --- |
| AC1 | `src/__tests__/artifact-design.test.ts` uses the exported 892 mock, fixtures and request/receipt schemas. It creates three boards, reads every V1 board/source/position, patches one board to V2, paginates revisions, reads V1 and restores V1 as V3. Initial missing IDs are generated once; replacement preserves them and rejects missing update IDs. API identifiers and versions equal service receipts. |
| AC2 | The same suite covers mutually exclusive inputs; server per-board 422 defects; stale-base 409 without replay/index overwrite; total raw JSON boundary at 5 MiB and overflow 413; four write operations crossed with both download failures; fixed-version recovery after head advances; malformed commit receipt; and incomplete generic GET receipt. Design transport delegates validation and encoding to the shared client, ahead of legacy preflight/retry handling. |
| AC3 | The suite preserves original owner namespace, createdAt, URL and unrelated index fields during update/restore; records confirmed versions despite download failure; retains old records on index outages; verifies inherited backend/owner env. Existing artifact, preflight, description, backend env, MCP and HTTP deadline suites cover legacy HTML/Markdown/text, sharing, read-back and environment behavior. Explicit JSON text remains a legacy file. |
| AC4 | An unrelated third-party agent context discovers the tools with actual generic MCP tools/list and invokes design creation with tools/call. Tool declarations and ordinary skill routing provide the capability; no product-design prompt or agent-name branch changed. |

`release-focused.txt`: **226 tests passed across 8 files**, including **29 design tests**.
`release-before-design.txt`: the exact final design test file copied onto the base
commit gives **28 failed / 1 passed** (the existing JSON-file behavior passes).
Only that test file and ignored dependency links were added to the baseline
worktree; its product code remained at the starting commit.

## Reproduce

Use a standalone skills worktree and the assigned local source trees:

```sh
node scripts/setup-artifact-tests.mjs <packages-tree> <agent-workflow-source> <scratch-deps>
node <packages-tree>/scripts/build.mjs
npm run build:types
npm run lint
npm test -- src/__tests__/artifact-design.test.ts src/__tests__/artifact.test.ts src/__tests__/artifact-preflight.test.ts src/__tests__/artifact-description.test.ts src/__tests__/backend-session-env-contract.test.ts src/__tests__/sharedMcpServer.test.ts src/__tests__/sharedSkillModules.test.ts src/__tests__/skills-http-doors-bounded.test.ts
```

The setup script installs declared external dependencies and copies/builds internal
sources in scratch, leaving original source trees untouched. It asserts declared
direct internal dependency versions. Plain npm install could not resolve the
existing unpublished agent-workflow 2.0.29, so local tree sources were used.
No version bump or public package publication was needed.

- Shared packages source: `fd890d9bf161ddc49aa5323692e82be9d25386e1`.
- Shared contract version: **2.0.29**; its Git tree is
  `bd7c88b0ac9f8f2989cc9b74841663c42f97af17`.
- Agent-workflow source: `6931aa43d267a286c2b8be7d6c856ffed0933e60`, version 2.0.29.
- Node v22.23.4, Vitest 4.1.12, TypeScript 5.9.3, ESLint 10.14.0,
  esbuild 0.28.2. Exact command, commit, duration and exit status are in `checks.json`.
- Actual workspace: host local runner worktree under
  `/Users/jcui/.zibby/work/selfhosted-project/f466b3f7-47ab-45ba-99c1-5a8c25d85c3b/e9ac9070-53d7-40ae-b15c-2e01daec697d`.
  No container/image/environment was assigned or claimed.

## Checks and limits

- Shared JavaScript build: **72 entries built**, exit 0. The measured build commit
  `6b4aaefc7caca4d4b9553f7989168b0e629b42b6` has identical production/setup source
  to the tested implementation commit (the intervening change is test-only).
- Whole-repository type check: exit 2 with **14 TS2339 diagnostics in unchanged
  datasetStore.ts**. Base and candidate have the same diagnostics. No changed
  source diagnostics remain. See `before-types.txt` and `release-types.txt`.
- Whole-repository lint: exit 1 with the same **2 no-useless-assignment errors in
  unchanged src/lib/repo-access.js:233–234 and 22 warnings** on base and candidate.
  Existing ESLint configuration covers JS/MJS; it does not lint TS. The measured
  candidate commit has the same JS/MJS source as the tested implementation.
  See `before-lint.txt` and `candidate-lint.txt`.
- Focused ESLint on the setup script and saved feed probe passed:
  `node_modules/.bin/eslint test-evidence/894/check-feed.mjs scripts/setup-artifact-tests.mjs`.
- Existing pack-tree `zibbyDeps`, discovery and closure resolve the new dependency
  edge to artifact-contracts 2.0.29; no parallel feed list was introduced.
  `check-feed.mjs` reproduces this bounded check with explicit source arguments.
  Full skills feed packing remains unverified: the packages snapshot lacks the
  pre-existing external `mem0/mem0-ts` repository (`@zibby/mem0ai`). The failed
  full-closure probe is retained in `final-feed.txt`; this external gap was
  reported to manager magnum instead of obtaining an unassigned repository.
- Transport evidence uses the shared mock only. No live backend or browser was
  requested or verified. No rendered UI changed.
- `git diff <base> --check` passed before handoff. Final branch currency and clean
  state are reported separately after the evidence commit.

## Rules and decisions

Followed supplied root AGENTS.md/CLAUDE.md, the complete ENGINEERING_STANDARDS.md,
and repository skills npm-publishes and repos-and-identities. No nested rule file
applied. KB lookup returned older credential work and no relevant convention to
change this implementation; ticket/file/base graph recall added no conflicting
implementation fact. The fleet's confirmed-commit/separate-readBack lesson is
implemented directly, without replaying writes.

The only input restrictions added are the requested design protocol's structural
requirements and mutual exclusivity. No agent capability is removed, no
agent-specific routing or prompt rule is added, and backend HTML validation is
not duplicated locally. Index reads distinguish absence from failure so a failed
recall cannot silently replace the original ownership/creation metadata.
