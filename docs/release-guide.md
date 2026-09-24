# Release guide

This procedure is for maintainers. Use npm and the Node.js version selected by `fnm`.

## Prepare

1. Start with a clean branch from `main`.
2. Run `npm version patch --no-git-tag-version` for a patch release.
3. Update `CHANGELOG.md` with the release changes.
4. Run the local gates:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit
npm pack --dry-run --json
npm publish --dry-run --access public
```

`npm run check` runs Biome and strict TypeScript checks. The publication dry run also runs checks and tests.
Neither dry run establishes OIDC access or creates a release.

5. Inspect the package contents.

The package contains production extensions, the manifest, example configuration, README, changelog, and license.
It must not contain tests, test helpers, or secrets.

6. Commit the changes.
7. Open a pull request.
8. Wait for successful CI.
9. Merge the pull request.

## Publish

CAUTION: Publish only the merged commit. npm versions are immutable, and release tags must not move.

Run these commands with the new version in place of `X.Y.Z`:

```sh
git switch main
git pull --ff-only origin main
git tag -s vX.Y.Z -m 'Release vX.Y.Z'
git push origin vX.Y.Z
```

The release workflow validates the tag signature, version, and membership in `main`.
It repeats the checks, inspects the package, and publishes with npm provenance.
Only a missing npm version permits publication. Other registry errors stop the job.

The npm Trusted Publisher uses owner `alexei-led`, repository `pi-model-router`, and workflow filename `release.yml`, without an environment.
The workflow requests `id-token: write`. It needs no long-lived npm token.
A rerun skips existing versions and releases. A skipped publication does not establish OIDC access.

## Publication checks

1. Make sure that the workflow completed the npm publication step.
2. Inspect the registry metadata:

```sh
npm view @alexeiled/pi-model-router@X.Y.Z version dist --json
```

3. Make sure that `latest` identifies the new version.
4. Inspect the provenance for the repository, tag, and commit.
5. Download the published archive.
6. Make sure that its contents and hash match the approved package.
7. Make sure that the GitHub release identifies the same tag.

Registry processing can delay availability after a successful publication. Do not publish the version again during that delay.

## Release notes

Use the exact tag as the release title, for example `v0.7.1`.
Start the notes with one sentence about the change.
Use only relevant sections: fixes, changes, upgrade requirements, release checks, and links.
State compatibility changes directly. Keep historical test results tied to their release.

If a published version needs a code correction, release a new version. Do not overwrite the package or move its tag.
