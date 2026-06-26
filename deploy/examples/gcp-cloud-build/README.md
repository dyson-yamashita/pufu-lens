# GCP Cloud Build Example

This directory contains Cloud Build examples for OSS users who want to run CI or deployment in their own GCP project.

The initial example is CI-only:

- `cloudbuild.ci.yaml`: checks formatting, lint, migration metadata, deploy dry-run, typecheck, and tests.

Deploy examples are intentionally handled separately so a pull request or feature branch cannot deploy production by accident.

## CI Trigger

Create a Cloud Build trigger in your GCP project and point it at this config:

```text
deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml
```

Recommended trigger events:

| use case        | event          | branch / target         | config               |
| --------------- | -------------- | ----------------------- | -------------------- |
| Pull request CI | Pull request   | target branch `^main$`  | `cloudbuild.ci.yaml` |
| Branch CI       | Push to branch | non-production branches | `cloudbuild.ci.yaml` |

Do not attach this CI trigger to a deploy config. Production deploy should use a separate trigger and a separate service account.

## Commands

The CI config runs:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm db:migrate --check
pnpm deploy:dry-run
pnpm typecheck
pnpm test
```

`pnpm db:migrate --check` is intentionally used without `DATABASE_URL`, so it validates migration file names, numbering, and local migration metadata only. Online migration checks belong to environment-specific deploy or operations workflows.

`pnpm deploy:dry-run` checks deployment entrypoint planning without connecting to production DB, object storage, or external APIs.

## Service Account

Use a dedicated CI service account for this trigger.

The CI service account should be able to run Cloud Build, but it does not need production deploy permissions.

Do not grant CI-only triggers these roles unless you intentionally extend the config:

- Cloud Run admin / developer roles
- Cloud Run Jobs admin / developer roles
- Firebase App Hosting deploy permissions
- Artifact Registry writer
- Secret Manager secret accessor
- Service account token creator for runtime service accounts

If your organization requires explicit log permissions, grant only the logging permissions required by Cloud Build in your project.

## Secrets

This CI example does not require runtime secrets.

Do not configure these secrets on the CI trigger:

- `DATABASE_URL`
- `AUTH_SECRET`
- OAuth client secrets
- `GEMINI_API_KEY`
- provider access tokens

Runtime secrets belong to provider-specific deploy examples or operations docs.

## Deploy Control

Deploy should be controlled by a different trigger, for example:

| use case          | event            | config        | guard                            |
| ----------------- | ---------------- | ------------- | -------------------------------- |
| staging deploy    | Push to `^main$` | deploy config | dedicated deploy service account |
| production deploy | Push tag `^v.*$` | deploy config | approval required                |

For monorepo-style deployments, use Cloud Build included / ignored file filters so docs-only changes or unrelated app changes do not trigger deploy builds.

## References

- `docs/deployment/overview.md`
- `docs/plans/009-oss-deployment-options/overview.md`
