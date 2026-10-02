# Build the client, then run the Node room server (which also serves the client).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=server.mjs

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 STATIC_DIR=dist PERSIST_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
EXPOSE 8787
CMD ["node", "server.mjs"]
