# Releasing

## Versions

Semantic Versioning, one number for the whole product (both apps and their
images always share it):

- **Major** (`2.0.0`): something an administrator must act on — a removed
  setting, a change to the virtual tables that breaks saved queries, a
  database no longer supported.
- **Minor** (`1.3.0`): new features, new virtual tables or columns,
  migrations that run on their own.
- **Patch** (`1.3.2`): fixes only.

The virtual tables of the query engine are a public contract: removing or
renaming a table or column is a major change; adding one is minor.

## Checklist

1. `CHANGELOG.md`: move *Unreleased* to `## [X.Y.Z] – YYYY-MM-DD`.
2. Set `"version"` in `apps/tickvana/package.json` and `apps/nuvenna/package.json`
   to `X.Y.Z` (the apps report it under `/api/health`).
3. Locally: `pnpm build && pnpm lint && pnpm test && pnpm e2e`.
4. Commit, tag `vX.Y.Z`, push the tag. The *Release* workflow builds
   `ghcr.io/spidobot/tickvana` and `ghcr.io/spidobot/nuvenna`, pushes them to the GitHub Container Registry, signs
   them with cosign and publishes the release notes from the change log.
5. Check a signature:

   ```bash
   cosign verify ghcr.io/spidobot/tickvana:X.Y.Z \
     --certificate-identity-regexp 'https://github.com/.+/.github/workflows/release.yml@refs/tags/v.+' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

## Before the very first release

- Trademark search for "Tickvana" and "Nuvenna" (DPMA, EUIPO) and the domains; see the note
  at the top of the concept.
- Nothing to set up for the images: the workflow pushes to the GitHub
  Container Registry with the repository's own token. Make the two packages
  public once after the first release (package settings → visibility).
- The full AGPL text in `LICENSE`.
