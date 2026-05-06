# AI Atelie — task runner.
# Run `just` with no args to list recipes.

set dotenv-load := true

default:
    @just --list

# Run api + web together (main dev loop)
dev:
    bunx concurrently --raw -k -n api,web -c blue,green "just dev-api" "just dev-web"

# Free dev ports (api 5174, vite 5173/5175) and any zombie bun watchers from a stuck run
kill:
    @lsof -ti:5173,5174,5175 | xargs kill -9 2>/dev/null || true
    @pkill -9 -f "bun run.*src/index\.ts" 2>/dev/null || true
    @pkill -9 -f "bun --watch.*src/index\.ts" 2>/dev/null || true
    @echo "dev ports cleared"

# Kill any stuck dev ports, then start dev
dev-clean: kill dev

# Run only the api server (Bun + Hono, full restart on file change)
dev-api:
    cd api && bun run --watch src/index.ts

# Run only the web dev server (Vite)
dev-web:
    cd web && bun run dev

# Build the web app for production
build:
    cd web && bun run build

# Preview the production build
preview:
    cd web && bun run preview

# Lint the web app
lint:
    cd web && bun run lint

# Typecheck both packages
typecheck:
    cd api && bun --bun tsc --noEmit
    cd web && bun --bun tsc --noEmit

# Install deps in root + api + web
install:
    bun install
    cd api && bun install
    cd web && bun install

# Wipe all node_modules
clean:
    rm -rf node_modules api/node_modules web/node_modules

# Everything you'd want green before shipping
check: lint typecheck build
