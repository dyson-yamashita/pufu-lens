# Docker Compose Example Placeholder

This directory is reserved for a future Docker Compose deployment example.

The repository already has local development compose support at the root. A future file under this directory should describe a reusable self-hosted or single-host deployment example, not replace local development defaults with user-specific production settings.

## Intended Scope

Docker Compose can be useful for:

- local reproduction of the full runtime
- small self-hosted environments
- provider-neutral smoke testing of container images

A production-ready Compose example still needs explicit operational choices for:

- TLS and public ingress
- PostgreSQL backup / restore
- Apache AGE, pgvector, and pgcrypto initialization
- object storage or mounted volume persistence
- secret injection
- scheduled job execution
- log retention and secret redaction checks
- upgrade and rollback

## Required Boundaries

Future Compose files should stay inside `deploy/examples/docker-compose/`.

Do not commit user-specific production values:

- public domains
- database passwords
- OAuth client secrets
- API keys
- bucket names
- mounted host paths
- private registry credentials

Use the provider-neutral runtime contract in `docs/deployment/overview.md`. Compose-specific service definitions, `.env.example` placeholders, volume layout, health checks, and rollback notes belong in this directory.

## Provider Checklist

Before turning this placeholder into an implemented example, document:

- whether the example is local-only, staging-capable, or production-oriented
- how the Mastra Server and Workflow Jobs images are built
- how `DATABASE_URL`, `AUTH_SECRET`, `GEMINI_API_KEY`, and OAuth secrets are injected
- how object storage maps to local volumes or an external object store
- how recurring jobs are scheduled
- how `pnpm db:migrate --check`, `pnpm db:migrate --plan`, and `pnpm db:migrate` are run
- how `pnpm deploy:smoke --env <env>` reaches the deployed Mastra Server
- how backups, restore, and rollback are performed

## References

- `docs/deployment/overview.md`
- `docs/plans/009-oss-deployment-options/overview.md`
