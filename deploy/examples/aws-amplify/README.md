# AWS Amplify Example Placeholder

This directory is reserved for a future AWS Amplify deployment example.

The current GCP implementation is the only implemented provider example. Do not treat this directory as a working Amplify deployment config yet.

## Intended Scope

Amplify can be considered as a Web hosting and preview environment entrypoint for the Next.js app. Pufu Lens also needs backend runtime components that Amplify does not fully cover by itself:

- Mastra Server HTTP runtime
- Workflow Jobs for collect / ingest / report
- PostgreSQL with Apache AGE, pgvector, and pgcrypto
- Object storage for raw data, parsed artifacts, report artifacts, and public manifests
- Secret store
- Scheduler or manual job execution

A future Amplify example should either document the AWS services used for those backend components or clearly state that they are deployed by another provider example.

## Required Boundaries

Future Amplify files should stay inside `deploy/examples/aws-amplify/` unless they are provider-neutral documentation updates.

Do not add user-specific production values to the repository:

- AWS account id
- region-specific resource names
- bucket names
- database URLs
- OAuth client secrets
- API keys
- access tokens

The app runtime contract should continue to use `docs/deployment/overview.md` as the source of truth. Amplify-specific build settings, branch rules, preview settings, IAM notes, and secret injection steps belong in this directory.

## Provider Checklist

Before turning this placeholder into an implemented example, document:

- which runtime components Amplify owns
- where Mastra Server runs
- where Workflow Jobs run
- how PostgreSQL + AGE is provisioned, noting that AWS RDS / Aurora do not natively support Apache AGE and may require EC2 / ECS self-hosting or a custom AMI
- how object storage maps to `STORAGE_DRIVER` / `STORAGE_BUCKET`, including whether an S3-compatible storage driver must be added to the core storage package
- how runtime secrets are injected without logging their values
- how PR preview environments avoid production DB, storage, and secrets
- how production deployment is approved and rolled back
- which commands run `pnpm deploy:dry-run`, `pnpm db:migrate --check`, `pnpm infra:check --env <env>`, and `pnpm deploy:smoke --env <env>`

## References

- `docs/deployment/overview.md`
- `docs/plans/009-oss-deployment-options/overview.md`
