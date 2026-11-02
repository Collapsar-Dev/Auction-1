FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

FROM deps AS build
COPY . .
# адрес API нужен Next.js на этапе сборки (rewrites)
ENV API_URL=http://api:4000
RUN npm run build

FROM build AS api
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/src/main.js"]

FROM build AS web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
