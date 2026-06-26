# GCP Cloud Build Example

This directory contains Cloud Build examples for OSS users who want to run CI or deployment in their own GCP project.

The examples are split by responsibility:

- `cloudbuild.ci.yaml`: checks formatting, lint, migration metadata, deploy dry-run, typecheck, and tests.
- `cloudbuild.deploy.yaml`: builds and deploys the GCP runtime after a protected branch or release trigger fires.
- `apphosting.example.yaml`: provider example for Web runtime configuration in a user's fork or release workspace.

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

## CI Commands

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

## CI Service Account

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

## CI Secrets

This CI example does not require runtime secrets.

Do not configure these secrets on the CI trigger:

- `DATABASE_URL`
- `AUTH_SECRET`
- OAuth client secrets
- `GEMINI_API_KEY`
- provider access tokens

Runtime secrets belong to provider-specific deploy examples or operations docs.

## Deploy Trigger

Create a separate Cloud Build trigger for deployment and point it at:

```text
deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml
```

Recommended deploy trigger events:

| use case          | event            | guard                                          |
| ----------------- | ---------------- | ---------------------------------------------- |
| staging deploy    | Push to `^main$` | dedicated staging deploy service account       |
| production deploy | Push tag `^v.*$` | approval required + production service account |

Do not use the deploy config for pull request events. For monorepo-style deployments, use Cloud Build included / ignored file filters so docs-only changes or unrelated app changes do not trigger deploy builds.

## Deploy Substitutions

Set these trigger substitutions in the user's GCP project:

| substitution                 | example value                                       | note                                                                  |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `_ENV`                       | `staging`                                           | Must be `staging` or `production`; passed to `deploy:smoke`.          |
| `_REGION`                    | `asia-east1`                                        | Cloud Run, Cloud Run Jobs, Artifact Registry, and App Hosting region. |
| `_ARTIFACT_REPO`             | `pufu-lens`                                         | Existing Artifact Registry Docker repository.                         |
| `_RUNTIME_SERVICE_ACCOUNT`   | `mastra-runtime@PROJECT_ID.iam.gserviceaccount.com` | Runtime identity for Cloud Run service and jobs.                      |
| `_SCHEDULER_SERVICE_ACCOUNT` | `scheduler-oidc@PROJECT_ID.iam.gserviceaccount.com` | Used by smoke checks and future scheduler integration.                |
| `_STORAGE_BUCKET`            | `pufu-lens-staging`                                 | Object storage bucket name; do not commit the real value.             |
| `_VPC_CONNECTOR`             | `mastra-connector`                                  | VPC connector used to reach private PostgreSQL.                       |
| `_MASTRA_SERVICE`            | `mastra-server`                                     | Cloud Run service name.                                               |
| `_MASTRA_IMAGE`              | `mastra-server`                                     | Artifact Registry image name for Mastra Server.                       |
| `_JOBS_IMAGE`                | `workflow-job`                                      | Artifact Registry image name for workflow jobs.                       |
| `_FIREBASE_DEPLOY`           | `true`                                              | Set to `false` if Web deploy is handled outside Cloud Build.          |
| `_FIREBASE_TOOLS_VERSION`    | `14.4.0`                                            | Firebase CLI version for local-source App Hosting deploy.             |

`PROJECT_ID` and `SHORT_SHA` are Cloud Build built-in substitutions. The example uses `SHORT_SHA` as the immutable image tag and also pushes `latest` as a convenience tag.

## Deploy Steps

`cloudbuild.deploy.yaml` performs:

1. Validate required substitutions and `_ENV`.
2. Build and push the Mastra Server image from `infra/docker/mastra/Dockerfile`.
3. Build and push the Workflow Job image from `infra/docker/jobs/Dockerfile`.
4. Deploy the Mastra Server to Cloud Run.
5. Deploy `curate-workflow`, `ingest-workflow`, and `generate-report` as Cloud Run Jobs.
6. Deploy the Web app with Firebase App Hosting when `_FIREBASE_DEPLOY=true`.
7. Read the deployed Mastra Server URL dynamically and run `deploy:smoke`.

The deploy config does not create the PostgreSQL VM, VPC connector, Artifact Registry repository, GCS bucket, Firebase App Hosting backend, or Secret Manager secrets. Provision those before enabling the trigger.

## Deploy Secrets

The deploy service account needs access to these Secret Manager secret names because the Cloud Run resources reference them:

| secret name      | used by                                          |
| ---------------- | ------------------------------------------------ |
| `DATABASE_URL`   | Mastra Server, Workflow Jobs                     |
| `AUTH_SECRET`    | Workflow Jobs through connection secret fallback |
| `GEMINI_API_KEY` | Mastra Server, Workflow Jobs                     |

The secret values are not read into the build log. Cloud Run receives secret references such as `DATABASE_URL=DATABASE_URL:latest`.

If your environment uses Google or GitHub OAuth data-source refresh in jobs, add the corresponding runtime secrets in your fork or environment-specific copy:

- `GOOGLE_CLIENT_SECRET` / `AUTH_GOOGLE_SECRET`
- `GITHUB_CLIENT_SECRET` / `AUTH_GITHUB_SECRET`
- `CONNECTION_SECRET_KEY` when you do not want to fall back to `AUTH_SECRET`

## Deploy Service Account

Use separate service accounts for staging and production deploy triggers. The production trigger should require approval.

The deploy service account generally needs:

- Artifact Registry writer for the target Docker repository.
- Cloud Run developer/admin permissions for the Mastra service.
- Cloud Run Jobs developer/admin permissions for workflow jobs.
- Service Account User on `_RUNTIME_SERVICE_ACCOUNT`.
- Firebase App Hosting deploy permissions when `_FIREBASE_DEPLOY=true`.
- Permission to attach Secret Manager secret references to Cloud Run resources.
- Logging permissions required by Cloud Build in the project.

The runtime service account generally needs:

- Secret Manager secret accessor for runtime secrets.
- GCS access to `_STORAGE_BUCKET`.
- VPC connector access if required by organization policy.
- Cloud Run Invoker permissions only where explicitly needed.

## Firebase App Hosting

The example uses:

```bash
firebase deploy --only apphosting --project "$PROJECT_ID" --non-interactive
```

Firebase App Hosting reads runtime configuration from `apps/web/apphosting.yaml` and `firebase.json`. In an OSS fork, copy `apphosting.example.yaml` to `apps/web/apphosting.yaml` in the user's own repository or generated release workspace, then replace placeholder values there. Do not upstream project ids, hosted domains, bucket names, OAuth client ids, or secret values.

If Web deployment is handled by Firebase's own GitHub integration or another release process, set `_FIREBASE_DEPLOY=false` and keep Cloud Build responsible for Mastra Server and Workflow Jobs only.

## Migration And Operations

Online DB migration may require private network access to PostgreSQL. Do not assume the default Cloud Build pool can reach a private PostgreSQL VM.

Use `docs/operations/deploy-checklist.md` for the environment-specific sequence:

```bash
pnpm db:migrate --check
pnpm db:migrate --plan
pnpm db:migrate
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
```

Confirm after deploy that:

- Artifact Registry contains the `SHORT_SHA` image tags.
- Cloud Run service and jobs use `_RUNTIME_SERVICE_ACCOUNT`.
- App Hosting uses the intended backend and runtime secrets.
- Secret values, OAuth tokens, DB URLs, and PII do not appear in Cloud Build logs.

## References

- `docs/deployment/overview.md`
- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `docs/plans/009-oss-deployment-options/overview.md`
