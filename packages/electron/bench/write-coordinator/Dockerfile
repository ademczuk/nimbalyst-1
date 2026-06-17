# Optional - currently unused. The bench runs natively on the host so
# better-sqlite3 compiles for the host arch/libc (macOS arm64 / x64,
# Linux glibc, Windows MSVC). Postgres lives in docker-compose.yml.
#
# This file exists for the case where someone wants to containerise the
# bench itself for CI. It uses bookworm-slim (not alpine) because alpine's
# musl + arm64 + native-module combination is flaky for better-sqlite3.

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --no-audit --no-fund --silent
COPY bench.mjs write-coordinator-bench-impl.mjs ./
CMD ["node", "bench.mjs"]
