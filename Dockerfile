# syntax=docker/dockerfile:1
FROM node:22.23.4-bookworm-slim

# git: shallow checkout of the PR. The Claude Code binary ships as an optional dependency of the SDK.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

ENV NODE_ENV=production \
    PORT=3000 \
    WORK_DIR=/tmp/pr-reviewer

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# tsx is a devDependency and the runtime, so install everything.
RUN NODE_ENV=development pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

# Non-root: the agent only reads the checkout in /tmp.
RUN useradd --create-home reviewer
USER reviewer
EXPOSE 3000
CMD ["dumb-init", "node_modules/.bin/tsx", "src/index.ts"]
