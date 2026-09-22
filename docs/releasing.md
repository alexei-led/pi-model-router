# Releasing

Use the Node selected by `fnm` locally, not a separate Homebrew Node. The repository currently uses npm; a pnpm migration is separate work.

## Prepare

1. Start from a clean branch based on `main`.
2. Run `npm version patch --no-git-tag-version`. Update `CHANGELOG.md`.
3. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and `npm audit`.
4. Inspect `npm pack --dry-run --json`: only production extensions, manifest, example config, README, changelog and license should ship. Tests, test helpers and `.env` must not ship.
5. Run `npm publish --dry-run --access public`. This runs `prepublishOnly` (checks and tests); it does **not** verify OIDC credentials or create a release.
6. Commit, open a PR, wait for CI, and merge.

## Publish

On the merged `main` commit, create and push a signed annotated tag matching `package.json`:

```bash
git switch main
git pull --ff-only origin main
git tag -s vX.Y.Z -m 'Release vX.Y.Z'
git push origin vX.Y.Z
```

`.github/workflows/release.yml` verifies the tag signature, version and membership in `main`. It installs from the lockfile, runs checks/tests and inspects packaging before `npm publish --provenance --access public`. A missing npm version permits publishing; other registry lookup errors stop the job. It then creates the GitHub Release.

The npm Trusted Publisher must name owner `alexei-led`, repository `pi-model-router`, workflow **`release.yml`** (filename only), and no environment. The job requests `id-token: write`. No long-lived npm token is needed. Existing versions and releases are skipped on rerun; a skipped publish does not prove OIDC works.

## Verify

- Confirm the release run's publish step actually ran successfully.
- Check `npm view @alexeiled/pi-model-router@X.Y.Z version dist --json` and the `latest` tag.
- Check npm provenance/attestations link the artifact to this repository and tag commit.
- Confirm the GitHub Release points at the same tag.
- Download and inspect the registry tarball; test files and secrets must be absent.

Versions on npm are immutable. Do not move release tags or overwrite a published version. Fix the workflow and rerun the existing release only when safe, or ship another patch.
