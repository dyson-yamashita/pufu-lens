FROM node:25-slim AS base

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./

RUN npm install --global pnpm@11.1.1 && pnpm install --frozen-lockfile
RUN pnpm build

COPY infra/db/migrations ./infra/db/migrations

ENV NODE_ENV=production

ENTRYPOINT ["node", "--experimental-strip-types", "scripts/workflow-job.ts"]
