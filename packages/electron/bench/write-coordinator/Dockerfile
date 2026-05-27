FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund --silent
COPY bench.mjs ./
CMD ["node", "bench.mjs"]
