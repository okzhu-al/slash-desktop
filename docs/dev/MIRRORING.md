# Repository Mirroring

`slash` is the private source-of-truth monorepo.
`slash-desktop` is a public mirror generated from `slash`.
Do not develop directly in `slash-desktop`.
`slash-server` is a private server mirror generated from `slash`.
Do not develop directly in `slash-server` except for emergency hotfixes.

## Publish Commands

To publish to the mirror repositories, make sure you are in the root directory of the `slash` project, and run:

```bash
./scripts/publish-desktop.sh
./scripts/publish-server.sh
```

## Push Guidelines

Before committing and pushing changes in a mirror repo (`../slash-desktop` or `../slash-server`), always review:

```bash
git status --short
git diff
```

Ensure no forbidden paths (like `apps/server` or private keys) are exposed in the public mirror repository history or current status.
