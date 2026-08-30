# Changesets

Watt versions the Host, CLI, and desktop app together. Add a changeset in every PR that should ship:

```sh
pnpm changeset
```

Merging the **Version Packages** PR is what bumps versions and starts packaging CI. See [RELEASING.md](../RELEASING.md).
