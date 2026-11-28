FROM node:24.13-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.23.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
EXPOSE 3000 5173
