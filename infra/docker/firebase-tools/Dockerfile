# Cloud Build step builder image. Keep USER as root so the step can write to
# /workspace and read the build service account credentials that Cloud Build
# injects for root. Do not add USER node here.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG FIREBASE_TOOLS_VERSION
RUN test -n "${FIREBASE_TOOLS_VERSION}"
RUN npm install --global "firebase-tools@${FIREBASE_TOOLS_VERSION}"
