# Bringing upstream into `shattered/main`

Our fork is `Geravant/carbon-runtime` (`origin`); upstream is `carbonenginejs/runtime` (`upstream`). `shattered/main` is upstream's `main` plus our commits. Upstream moves fast (thousands of commits in a few months) and promises no stable API, so we sync on a schedule, not continuously, and the game stays pinned to a packed tarball in between.

## What we carry

- Edits to five engine files, each marked `@cjs Ours (Shattered Reach fork)` in the source. The list, with reasons, is `05-fork-changes.md` in the port docs. `git grep -n "Shattered Reach fork" src` finds them.
- New files only under `shattered/`, `docs/shattered/` and `examples/shattered-spike/`, plus two lines in `.gitignore`.

Keep it that way. A new engine edit goes in the list in the same commit.

## Merge, don't rebase

`shattered/main` is long-lived, pushed, and other worktrees and the game's tarball name its commits. A rebase rewrites those commits; a merge keeps them. Rebase only a private branch that nobody else has fetched.

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
cd ~/RiderProjects/carbon-m1
git status --short                      # must be clean
git fetch upstream
git log --oneline HEAD..upstream/main | wc -l      # how far upstream has moved
git diff --stat HEAD...upstream/main -- \
  src/trinity/resources/geometry/TriGeometryRes.js src/core/platform/CjsBrowserBackend.js \
  src/trinity/core/rawData/RawData.js src/trinity/core/device/Tr2DepthStencil.js \
  src/trinity/core/Tr2Blitter.js src/core/CjsLibrary.js src/core/configuration.js
git merge --no-ff upstream/main -m "merge upstream main at $(git rev-parse --short upstream/main)"
```

The `diff --stat` shows whether upstream touched the files we edit, or the two files the slim build swaps (`CjsLibrary.js`, `configuration.js`), before you merge.

## Resolving conflicts

Conflicts can only be in the five edited files. For each, take upstream's version and put our edit back:

| File | Our edit, to re-apply on upstream's text |
|---|---|
| `TriGeometryRes.js` | the `PrepareFromCmfData` method (self-contained; put it after `PrepareFromGrannyRes`) |
| `CjsBrowserBackend.js` | no static import of the WebGL2 layer or the two translators; `LoadTranslator`; the `translator` option and `_translator` field; `GetEffectConfiguration` without a translator |
| `RawData.js` | `hostLayouts`, `RegisterLayouts`, the third lookup in `create` |
| `Tr2DepthStencil.js` | the `RangeError` at the top of `Create` |
| `Tr2Blitter.js` | the two static paths, read by the constructor |

If upstream has done the same thing its own way (a public mesh entry, lazy backend imports), drop our edit, use theirs, change `shattered/src/` and the spike page to match, and remove the row from `05-fork-changes.md`.

## After the merge: check, in this order

```sh
npm ci
node shattered/scripts/build-slim.mjs            # must end without "dropped export" or "No matching export"
node examples/shattered-spike/tools/build-effects.mjs
node shattered/scripts/pack.mjs --allow-dirty && node examples/shattered-spike/tools/build-page.mjs
node examples/shattered-spike/tools/shoot.mjs --probe --backend webgpu --out sync --strict
node examples/shattered-spike/tools/shoot.mjs --probe --backend webgl2 --out sync --strict
```

What each failure means:

- **`No matching export ... trinityForLibrary.js`**: upstream's `CjsLibrary` now takes another name from the Trinity barrel. Add it to `shattered/src/trinityForLibrary.js` from its own module.
- **`dropped export X`**: two barrels the slim entry re-exports now both export `X`. Name the one we want in `shattered/src/index.js`.
- **The bundle grew a lot** (`shattered/dist/sizes.json`; it was 3,106 KB raw and 702 KB gzip, minified, at tarball `e4d85027f`): something we export started importing EVE code, or `CjsLibrary` gained a static import. `node shattered/scripts/build-slim.mjs --analyze` writes `shattered/dist/meta.json` (an esbuild metafile) to find it.
- **The page fails or a request goes unanswered**: read the page error in the runner's output. An unanswered request for a `managed/...` effect path means the engine asks for a new built-in effect; write our own file for it, or make its path configurable the way `Tr2Blitter`'s are.
- **`Unsupported configuration section` or a start-up error in `Initialize`**: `src/core/configuration.js` gained a section; mirror it in `shattered/src/configuration.js`.

Then run the engine's own tests if the edited files conflicted: `npm run build:npm` and `node --test test/core test/trinity/depth-stencil.test.js test/trinity/blitter.test.js test/trinity/raw-data-accessors.test.js test/trinity/geometry-realization.test.js`. (`npm test` stops in its lint stage on this machine; that is upstream's state, not ours. At our base, 8 tests fail in upstream's own suite with or without our edits.)

Commit the merge, push (`git -c http.postBuffer=157286400 push origin shattered/main` if the push is large), pack from the clean commit (`node shattered/scripts/pack.mjs`), and hand the new tarball to the game.

## Sync log

| Date | Upstream `main` | Result |
|---|---|---|
| 2026-11-20 | `36b192a00` (0.1.0-alpha.14, 2026-11-16) | Fetched; upstream had not moved since the spike branched (0 commits ahead). Nothing to merge, no conflicts. |
| 2026-11-20 (later) | `36b192a00` | Fetched again before the scene-capabilities tarball (`3c357ae7c`): 0 commits ahead. Nothing to merge, no conflicts. |
