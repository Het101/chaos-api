FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=$APP_VERSION PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 1000
EXPOSE 8080
CMD ["node", "src/server.js"]
