# Local setup

## Prerequisites

- Windows, macOS, or Linux with Git.
- Node.js 24.13.0 LTS (the project runtime pin is authoritative); pnpm 12.23.0 through Corepack.
- Docker Desktop / Docker Engine with Compose v2 for the container path, or a local PostgreSQL matching the documented schema.

## Verified local workflow

## Intended workflow

1. Copy `.env.example` to `.env`; set a unique `SESSION_SECRET` of at least 32 random bytes. Keep `.env` local.
2. Run package-manager commands through the repository pin, for example `corepack pnpm@12.23.0 install --frozen-lockfile`.
3. Start PostgreSQL with `docker compose up -d db`; it binds only to loopback on port 5432.
4. Apply schema migrations with `corepack pnpm@12.23.0 db:migrate`.
5. Start API and web development servers with `corepack pnpm@12.23.0 dev`. The API is at `http://localhost:3000`, and Vite serves the web app at `http://localhost:5173`.
6. Run checks with `corepack pnpm@12.23.0 typecheck`, `corepack pnpm@12.23.0 build`, and `corepack pnpm@12.23.0 test`.
7. To seed a local demo account, set `DEMO_PASSWORD` (at least 12 characters) and run `corepack pnpm@12.23.0 db:seed`. The script prints the demo email and requires that password; do not use demo credentials outside a local environment.

`corepack pnpm@12.23.0 docker:up` builds and starts the full Compose stack. Database data and uploaded maps use named Docker volumes; `docker compose down` preserves them, while `docker compose down -v` deletes them.

The CI database image is pinned by digest to PostgreSQL 16.15, an available supported line. The local app and CI use the same database image.

Automated backup and restore procedures are not implemented yet. Production requires operator-managed secrets, HTTPS, backups, and separate configuration.
