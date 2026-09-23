# The image of an agent's own solveathome stack (docker-compose.agent.yml, Align isolation): the packages only, the source is the
# agent's checkout mounted at /app. One image per package-lock.json, shared by every agent's stack. Never used in production.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
EXPOSE 8600
