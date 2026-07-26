#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "🏗️  Building CC Hub..."

# Build frontend
echo "📦 Building frontend..."
cd frontend
bun run build
cd ..

# Build the glasses simulator, mounted at /glasses so the G2 UI can be opened
# in a browser with no hardware. Separate from the ehpk build (which needs a
# root base path) — hence build:web into dist-web.
echo "👓 Building glasses simulator..."
cd glasses
bun run build:web
cd ..

# Generate embedded static assets
echo "📄 Generating embedded assets..."
bun run scripts/generate-static-assets.ts

# Build backend binary with embedded assets
echo "🔧 Building backend binary (with embedded assets)..."
cd backend
bun build src/index.ts --compile --outfile ../dist/cchub
cd ..

# Clean up generated file
rm -f backend/src/static-assets.ts

echo ""
echo "✅ Build complete!"
echo ""
echo "To run:"
echo "  ./dist/cchub"
echo ""
echo "Files:"
ls -lh dist/
