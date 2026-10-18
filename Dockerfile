# syntax=docker/dockerfile:1
FROM node:22-alpine3.22 AS dependencies
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates libstdc++
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY prisma prisma
RUN npm run db:generate

FROM dependencies AS build
COPY tsconfig.json ./
COPY src src
RUN npm run build
RUN ./node_modules/.bin/tsc prisma/seed.ts --outDir /app/seed --module commonjs --target ES2022 --esModuleInterop --skipLibCheck

FROM build AS test
COPY scripts/prune-runtime.mjs /tmp/prune-runtime.mjs
COPY test test
RUN node /tmp/prune-runtime.mjs && npm run typecheck && npm run test && node -e "Promise.all([require('argon2').hash('native-compatibility-check').then(async h=>{if(!await require('argon2').verify(h,'native-compatibility-check'))throw Error('argon2 failed')}),require('sharp')({create:{width:2,height:2,channels:3,background:'#123e60'}}).webp().toBuffer().then(b=>{if(!b.length)throw Error('sharp failed')})]).catch(e=>{console.error(e);process.exitCode=1})"

FROM build AS production-dependencies
COPY scripts/prune-runtime.mjs /tmp/prune-runtime.mjs
RUN npm prune --omit=dev && node /tmp/prune-runtime.mjs

FROM node:22-alpine3.22 AS runtime
RUN apk add --no-cache openssl ca-certificates libstdc++ && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /app/prisma/migrations ./prisma/migrations
COPY --from=build /app/seed/seed.js ./prisma/seed.js
COPY package.json ./package.json
RUN mkdir -p uploads/private uploads/public && chown -R node:node uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
