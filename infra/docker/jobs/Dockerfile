FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate

WORKDIR /app

# --- 1) manifest 層: package.json / lockfile が変わったときだけ再実行される ---
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/mastra/package.json apps/mastra/
COPY packages/storage/package.json packages/storage/
COPY packages/ingestion/package.json packages/ingestion/
COPY packages/project-tenancy/package.json packages/project-tenancy/

RUN pnpm install --frozen-lockfile

# --- 2) ソース層: コード変更時はここから下だけが再ビルドされる ---
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./
COPY infra/db/migrations ./infra/db/migrations

# packages/* のみビルド(apps/web の next build を除外)
RUN pnpm exec turbo run build --filter='./packages/*'

ENV NODE_ENV=production

ENTRYPOINT ["node", "--experimental-strip-types", "scripts/workflow-job.ts"]
