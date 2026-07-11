FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG FIREBASE_TOOLS_VERSION
RUN test -n "${FIREBASE_TOOLS_VERSION}"
RUN npm install --global "firebase-tools@${FIREBASE_TOOLS_VERSION}"

USER node
