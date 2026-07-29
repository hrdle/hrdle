#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# What the binary is called is identity.json's to say (#459). install.sh and
# release.yml keep their own copies because neither can read the file at the
# moment it needs the name; this script runs from a checkout and can, so it
# reads rather than holding a third copy that nothing checks. release.yml
# renames `dist/<binaryName>` — the two disagreeing breaks CI builds only.
#
# Read in one pass, and checked: a missing key prints "undefined" and exits 0,
# so `set -e` lets it through and the build produces dist/undefined. That only
# fails later, in the CI step that renames dist/<binaryName> — the same
# build-time-only breakage this stopped being a third copy to avoid.
# One line per field, because productName has a space in it and word
# splitting would put "Hub" in the binary name.
IDENTITY_FIELDS=$(bun -e 'const id = await Bun.file("identity.json").json();
  const need = (k) => {
    const v = id[k];
    if (typeof v !== "string" || v.trim() === "") {
      console.error(`identity.json: ${k} is missing or not a non-empty string`);
      process.exit(1);
    }
    return v;
  };
  console.log(need("productName"));
  console.log(need("binaryName"));')

{ read -r PRODUCT_NAME; read -r BINARY_NAME; } <<< "$IDENTITY_FIELDS"

echo "🏗️  Building $PRODUCT_NAME..."

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
bun build src/index.ts --compile --outfile "../dist/$BINARY_NAME"
cd ..

# Clean up generated file
rm -f backend/src/static-assets.ts

echo ""
echo "✅ Build complete!"
echo ""
echo "To run:"
echo "  ./dist/$BINARY_NAME"
echo ""
echo "Files:"
ls -lh dist/
