# Playwright resmi image'ı: Chromium ve bağımlılıkları hazır gelir.
# Etiket, package.json'daki playwright sürümüyle BİREBİR aynı olmalıdır.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# Migration dosyaları image'a değil, compose'da read-only mount edilir.
ENV MIGRATIONS_DIR=/migrations
ENV ARTIFACT_ROOT=/data

# Playwright image'ı non-root `pwuser` (uid 1000) ile gelir.
# Chromium bu yüzden --no-sandbox ile çalışır; docs/design §2.6'daki kayıtlı taviz.
USER pwuser

EXPOSE 8080
CMD ["node", "dist/src/index.js"]
