# solveathome backend. Build: docker compose -f docker-compose.prod.yml build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && cp src/db/schema.sql dist/src/db/schema.sql && rm -f dist/scripts/dev-users.js

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY projects ./projects
COPY docs ./docs
COPY public ./public
RUN mkdir -p data/dumps data/files data/overlay data/repos && chown -R node:node /app/data
USER node
EXPOSE 8600
CMD ["node", "dist/src/server.js"]
