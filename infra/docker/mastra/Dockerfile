FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@11.1.1 --activate

WORKDIR /app

FROM base AS pruner

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./

RUN npx turbo@2.9.15 prune @pufu-lens/mastra --docker

FROM base AS builder

COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ ./
COPY --from=pruner /app/tsconfig*.json ./

RUN pnpm build
RUN pnpm --filter @pufu-lens/mastra mastra:build

ENV NODE_ENV=production
ENV PORT=8080

# Run the bundled Mastra server from its build output. Native dependencies
# (bcrypt, sharp, etc.) resolve from the monorepo node_modules above.
WORKDIR /app/apps/mastra/.mastra/output
EXPOSE 8080
USER node
ENTRYPOINT ["node", "index.mjs"]
