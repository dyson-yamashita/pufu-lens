# GCP Cloud Build Example

This directory contains Cloud Build examples for OSS users who want to run CI or deployment in their own GCP project.

The current Pufu Lens project uses GitHub Actions for PR / push CI and Cloud Build only for production deployment. `cloudbuild.ci.yaml` remains an optional example for users who want CI checks to run in Cloud Build in their own project.

The examples are split by responsibility:

- `cloudbuild.ci.yaml`: optional Cloud Build CI example that checks formatting, lint, migration metadata, deploy dry-run, typecheck, and tests.
- `cloudbuild.deploy.yaml`: builds and deploys the GCP runtime after a protected branch or release trigger fires.
- `apphosting.example.yaml`: provider example for Web runtime configuration in a user's fork or release workspace.

Deploy examples are intentionally handled separately so a pull request or feature branch cannot deploy production by accident.

## Optional CI Trigger

If you want Cloud Build to run CI in your own GCP project, create a trigger and point it at this config:

```text
deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml
```

Recommended trigger events:

| use case        | event          | branch / target         | config               |
| --------------- | -------------- | ----------------------- | -------------------- |
| Pull request CI | Pull request   | target branch `^main$`  | `cloudbuild.ci.yaml` |
| Branch CI       | Push to branch | non-production branches | `cloudbuild.ci.yaml` |

Do not attach this CI trigger to a deploy config. Production deploy should use a separate trigger and a separate service account. The Pufu Lens project itself does not create this Cloud Build CI trigger; it uses GitHub Actions for CI.

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
For the full GCP trigger and operations flow, see `docs/deployment/gcp-cloud-build.md`.

## Deploy Trigger

Create a separate Cloud Build trigger for deployment and point it at:

```text
deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml
```

Recommended deploy trigger events:

| use case          | event                                            | guard                                          |
| ----------------- | ------------------------------------------------ | ---------------------------------------------- |
| production deploy | Push to `^main$`                                 | approval required + production service account |
| staging deploy    | Push to a protected staging branch or manual run | dedicated staging deploy service account       |
| tag release       | Push tag `^v.*$`                                 | approval required + production service account |

Do not use the deploy config for pull request events. For monorepo-style deployments, use Cloud Build included file filters so docs-only changes or unrelated app changes do not trigger deploy builds. Keep the filter scoped to runtime and deploy config paths, for example:

```text
apps/**
packages/**
scripts/**
infra/**
deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml
.dockerignore
.firebaserc
firebase.json
pnpm-lock.yaml
pnpm-workspace.yaml
package.json
turbo.json
tsconfig*.json
```

Do not include broad documentation paths such as `docs/**`, `README.md`, or `deploy/examples/gcp-cloud-build/README.md` in production deploy triggers. If a documentation-only change should be deployed for operational reasons, run the trigger manually and record the reason.

Production deploy triggers should require approval. After a protected branch merge, identify the pending build by region, trigger name, branch, and commit SHA before approving it. For the full command sequence, including regional `gcloud alpha builds approve --location`, see [GCP Cloud Build Deployment](../../../docs/deployment/gcp-cloud-build.md).

## Deploy Substitutions

Set these trigger substitutions in the user's GCP project:

| substitution                  | example value                                       | note                                                                      |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `_ENV`                        | `staging`                                           | Must be `staging` or `production`; passed to `deploy:smoke`.              |
| `_REGION`                     | `asia-east1`                                        | Cloud Run, Cloud Run Jobs, Artifact Registry, and App Hosting region.     |
| `_ARTIFACT_REPO`              | `pufu-lens`                                         | Existing Artifact Registry Docker repository.                             |
| `_RUNTIME_SERVICE_ACCOUNT`    | `mastra-runtime@PROJECT_ID.iam.gserviceaccount.com` | Runtime identity for Cloud Run service and jobs.                          |
| `_SCHEDULER_SERVICE_ACCOUNT`  | `scheduler-oidc@PROJECT_ID.iam.gserviceaccount.com` | OIDC identity for the five-minute source sync Scheduler and smoke checks. |
| `_STORAGE_BUCKET`             | `YOUR_STORAGE_BUCKET`                               | Object storage bucket name; do not commit the real value.                 |
| `_VPC_CONNECTOR`              | `mastra-connector`                                  | VPC connector used to reach private PostgreSQL.                           |
| `_MASTRA_SERVICE`             | `mastra-server`                                     | Cloud Run service name.                                                   |
| `_MASTRA_IMAGE`               | `mastra-server`                                     | Artifact Registry image name for Mastra Server.                           |
| `_JOBS_IMAGE`                 | `workflow-job`                                      | Artifact Registry image name for workflow jobs.                           |
| `_FIREBASE_DEPLOY`            | `true`                                              | Set to `false` only when Web deploy is handled outside Cloud Build.       |
| `_FIREBASE_TOOLS_VERSION`     | `14.4.0`                                            | Firebase CLI version for local-source App Hosting deploy.                 |
| `_RUN_DB_MIGRATIONS`          | `true`                                              | Set to `false` to skip deploy-time Cloud Run Job migration.               |
| `_DB_MIGRATION_JOB`           | `db-migrate`                                        | Cloud Run Job name used to run `pnpm db:migrate` before runtime deploy.   |
| `_SOURCE_SYNC_DISPATCHER_JOB` | `source-sync-dispatcher`                            | Environment-prefixed dispatcher Cloud Run Job suffix.                     |
| `_SOURCE_SYNC_SCHEDULER`      | `source-sync-dispatcher`                            | Environment-prefixed five-minute Cloud Scheduler suffix.                  |

`PROJECT_ID` and `SHORT_SHA` are Cloud Build built-in substitutions. The example uses `SHORT_SHA` as the immutable image tag and also pushes `latest` as a convenience tag.

## Deploy Steps

`cloudbuild.deploy.yaml` performs:

1. Validate required substitutions and `_ENV`.
2. In parallel, build the Mastra Server image and build the Workflow Job image.
3. Push each image after its build finishes.
4. Create or update the DB migration Cloud Run Job from the Workflow Job image, then execute `pnpm db:migrate` with `--wait` when `_RUN_DB_MIGRATIONS=true`. When `_RUN_DB_MIGRATIONS=false`, this step exits immediately and still acts as the deploy barrier for later steps.
5. Deploy the Mastra Server to Cloud Run after its image is pushed and the migration step finishes.
6. Deploy `${_ENV}-curate-workflow`, `${_ENV}-ingest-workflow`, `${_ENV}-generate-report`, and `${_ENV}-source-sync-dispatcher` as Cloud Run Jobs after the jobs image is pushed and the migration step finishes, while keeping each runtime `WORKFLOW_ID` unchanged.
7. Create or update one five-minute Cloud Scheduler job that POSTs `{}` with an OIDC token to the Mastra Server dispatcher route.
8. Deploy the Web app with Firebase App Hosting after Mastra Server, Workflow Jobs, and Scheduler finish when `_FIREBASE_DEPLOY=true`. The step uses a prebuilt `firebase-tools` builder image from Artifact Registry instead of installing Firebase CLI on every deploy. When git history is available, it skips App Hosting deploy if the previous commit did not touch web-related paths.
9. Read the deployed Mastra Server URL dynamically and run `deploy:smoke` after all deploy steps finish.

The deploy config keeps the default Cloud Build worker and uses `waitFor` only to remove avoidable serial waits. Docker image builds use `docker buildx` registry caches at each image's `:buildcache` tag so unchanged layers, including multi-stage intermediate layers, can be reused without pulling the full previous runtime image first. App Hosting deploy still waits for backend deploy completion so the Web rollout does not expose a newer frontend before the matching backend is live. Runtime deploy steps wait for the migration barrier so new Cloud Run / App Hosting code is not rolled out before pending schema migrations are applied. Cost-sensitive environments should keep this default-worker shape unless they explicitly accept higher per-minute build costs.

The deploy config does not create the PostgreSQL VM, VPC connector, Artifact Registry repository, GCS bucket, Firebase App Hosting backend, or Secret Manager secrets. Provision those before enabling the trigger.

The Pufu Lens GCP project currently sets `_FIREBASE_DEPLOY=true`, so Cloud Build deploys the Mastra Server, Workflow Jobs, and Web app before running smoke checks.

## Deploy Secrets

The deploy service account needs access to these Secret Manager secret names because the Cloud Run resources reference them:

| secret name      | used by                                          |
| ---------------- | ------------------------------------------------ |
| `DATABASE_URL`   | Mastra Server, Workflow Jobs, DB migration job   |
| `AUTH_SECRET`    | Workflow Jobs through connection secret fallback |
| `GEMINI_API_KEY` | Mastra Server, Workflow Jobs                     |

The secret values are not read into the build log. Cloud Run receives secret references such as `DATABASE_URL=DATABASE_URL:latest`.

If your environment uses Google or GitHub OAuth data-source refresh in jobs, add the corresponding runtime secrets in your fork or environment-specific copy:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_SECRET` / `AUTH_GITHUB_SECRET`
- `CONNECTION_SECRET_KEY` when you do not want to fall back to `AUTH_SECRET`

## Deploy Service Account

Use separate service accounts for staging and production deploy triggers. The production trigger should require approval.

The deploy service account generally needs:

- Artifact Registry writer for the target Docker repository.
- Cloud Run developer/admin permissions for the Mastra service.
- Cloud Run Jobs developer/admin permissions for workflow jobs.
- Cloud Scheduler permissions to describe, create, and update the dispatcher job:
  `cloudscheduler.jobs.get`, `cloudscheduler.jobs.create`,
  `cloudscheduler.jobs.update`, and `cloudscheduler.locations.get`. Prefer a
  project custom role with only these permissions; see
  [GCP Cloud Build Deployment](../../../docs/deployment/gcp-cloud-build.md#iam).
- Service Account User on `_SCHEDULER_SERVICE_ACCOUNT` so the Scheduler job can
  use that service account for OIDC authentication.
- Service Account User on `_RUNTIME_SERVICE_ACCOUNT`.
- Firebase App Hosting deploy permissions when `_FIREBASE_DEPLOY=true`.
- Service Usage read permission, such as `roles/serviceusage.serviceUsageViewer`,
  when `_FIREBASE_DEPLOY=true`; Firebase CLI checks enabled APIs before deploy.
- Project browser permission, such as `roles/browser`, or a custom role with
  `resourcemanager.projects.get` and `resourcemanager.projects.getIamPolicy`,
  when `_FIREBASE_DEPLOY=true`; Firebase CLI reads project IAM policy during
  deploy.
- Permission to attach Secret Manager secret references to Cloud Run resources.
- Logging permissions required by Cloud Build in the project.

The runtime service account generally needs:

- Secret Manager secret accessor for runtime secrets.
- GCS access to `_STORAGE_BUCKET`.
- VPC connector access if required by organization policy.
- Cloud Run Invoker permissions only where explicitly needed.

## Firebase App Hosting

Before enabling the deploy trigger, build and push the Firebase CLI builder image once per project. Use the same version as `_FIREBASE_TOOLS_VERSION` in `cloudbuild.deploy.yaml` for both the image tag and build arg:

```bash
FIREBASE_TOOLS_VERSION=14.4.0
IMAGE="asia-east1-docker.pkg.dev/${PROJECT_ID}/${_ARTIFACT_REPO}/firebase-tools:${FIREBASE_TOOLS_VERSION}"

cat > /tmp/cloudbuild.firebase-tools.yaml <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --build-arg
      - FIREBASE_TOOLS_VERSION=${FIREBASE_TOOLS_VERSION}
      - --tag
      - ${IMAGE}
      - .
images:
  - ${IMAGE}
EOF

gcloud builds submit \
  --project="${PROJECT_ID}" \
  --region="${_REGION}" \
  --config=/tmp/cloudbuild.firebase-tools.yaml \
  infra/docker/firebase-tools
```

This image is a Cloud Build step builder and intentionally runs as root so it can write to `/workspace` and use the deploy service account credentials that Cloud Build injects.

The example uses:

```bash
firebase deploy --only apphosting --project "$PROJECT_ID" --non-interactive
```

When the checkout includes the parent commit, `deploy-web-app-hosting` skips App Hosting deploy if `HEAD^..HEAD` does not touch `apps/web/`, `firebase.json`, root workspace manifests, `packages/`, `infra/docker/firebase-tools/`, or `deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml`. Cloud Build performs a shallow clone by default, so the skip logic falls back to deploy when parent history is unavailable. For stricter control, split Web deploy into a dedicated trigger with `includedFiles` instead of relying on in-step diffing.

Firebase App Hosting reads runtime configuration from `apps/web/apphosting.yaml` and `firebase.json`. In an OSS fork, copy `apphosting.example.yaml` to `apps/web/apphosting.yaml` in the user's own repository or generated release workspace, then replace placeholder values there. Do not upstream project ids, hosted domains, bucket names, OAuth client ids, or secret values.

When using the environment-prefixed Cloud Run Job names from `cloudbuild.deploy.yaml`, set `PUFU_LENS_INGEST_WORKFLOW_JOB_NAME` in `apps/web/apphosting.yaml` to the matching value such as `staging-ingest-workflow` or `production-ingest-workflow`.

If Web deployment is handled by Firebase's own GitHub integration or another release process, set `_FIREBASE_DEPLOY=false` and keep Cloud Build responsible for Mastra Server and Workflow Jobs only.

## Migration And Operations

Deploy-time DB migration uses the same Workflow Job image and `scripts/db-migrate.ts` entrypoint as local operations. Migration targets are discovered from `infra/db/migrations/*.sql`, sorted by filename. Each migration version is the filename without the `.sql` suffix, for example `0003_add_example_table`. Applied versions are recorded in `public.schema_migrations`. Pending migrations are those whose version is not yet present in `public.schema_migrations`; they are applied in filename order during `pnpm db:migrate`.

When `_RUN_DB_MIGRATIONS=true`, Cloud Build creates or updates `${_DB_MIGRATION_JOB}` after the Workflow Job image push, overrides the container command to `pnpm db:migrate`, and executes the job with `--wait` before Mastra Server, Workflow Jobs, or Web deploy start. The migration job must reach PostgreSQL through `${_VPC_CONNECTOR}` and read `DATABASE_URL` from Secret Manager through `${_RUNTIME_SERVICE_ACCOUNT}`. Secret values are passed only as Cloud Run secret references; they are not printed in Cloud Build logs.

Set `_RUN_DB_MIGRATIONS=false` only when migration is handled outside this deploy config before the Cloud Build deploy starts, for example a manual run from an IAP-tunneled admin host. In that case the `run-db-migration` step exits immediately but still acts as the deploy barrier so later runtime rollout steps keep the same ordering contract.

Use `docs/operations/deploy-checklist.md` for the environment-specific sequence:

```bash
pnpm db:migrate --check
pnpm db:migrate --plan
pnpm db:migrate
pnpm infra:check --env production
pnpm deploy:smoke --env production
```

Confirm after deploy that:

- Artifact Registry contains the `SHORT_SHA` image tags.
- Cloud Run service and jobs use `_RUNTIME_SERVICE_ACCOUNT`.
- App Hosting uses the intended backend and runtime secrets.
- Secret values, OAuth tokens, DB URLs, and PII do not appear in Cloud Build logs.

## References

- `docs/deployment/gcp-cloud-build.md`
- `docs/deployment/overview.md`
- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `docs/plans/009-oss-deployment-options/overview.md`
