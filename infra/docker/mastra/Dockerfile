FROM node:25-slim AS base

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./

RUN npm install --global pnpm@11.1.1 && pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @pufu-lens/mastra mastra:build

ENV NODE_ENV=production
ENV PORT=8080

# Run the bundled Mastra server from its build output. Native dependencies
# (bcrypt, sharp, etc.) resolve from the monorepo node_modules above.
WORKDIR /app/apps/mastra/.mastra/output
EXPOSE 8080
ENTRYPOINT ["node", "index.mjs"]
