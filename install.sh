#!/bin/bash
# Hrdle installer
# Usage: curl -fsSL https://raw.githubusercontent.com/hrdle/hrdle/main/install.sh | bash

set -e

# Colored output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Detect the OS and architecture
detect_platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    linux) os="linux" ;;
    darwin) os="macos" ;;
    *) error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac

  # Currently supported platforms
  if [[ "$os" == "linux" && "$arch" == "x64" ]]; then
    echo "hrdle-linux-x64"
  elif [[ "$os" == "macos" && "$arch" == "arm64" ]]; then
    echo "hrdle-macos-arm64"
  else
    error "Unsupported platform: $os-$arch (supported: linux-x64, macos-arm64)"
  fi
}

# Check dependencies
check_dependencies() {
  info "Checking dependencies..."

  # herdr — Hrdle runs every session in a herdr workspace, so this is required.
  if ! command -v herdr &> /dev/null; then
    warn "herdr is not installed"
    echo "  curl -fsSL https://herdr.dev/install.sh | sh"
    echo "  macOS: brew install herdr"
    exit 1
  fi
  info "  herdr: $(herdr --version 2>/dev/null || echo 'installed')"

  # Tailscale
  if ! command -v tailscale &> /dev/null; then
    warn "Tailscale is not installed"
    echo "  https://tailscale.com/download"
    exit 1
  fi
  info "  tailscale: $(tailscale version | head -1)"

  # Claude Code (optional)
  if command -v claude &> /dev/null; then
    info "  claude: $(claude --version 2>/dev/null || echo 'installed')"
  else
    warn "Claude Code is not installed (you can install it later)"
  fi
}

# Download the latest release
download_latest() {
  local binary_name="$1"
  local install_dir="${HRDLE_INSTALL_DIR:-$HOME/bin}"
  local install_path="$install_dir/hrdle"

  info "Fetching the latest release..."
  local latest_url="https://api.github.com/repos/hrdle/hrdle/releases/latest"
  local download_url

  download_url=$(curl -fsSL "$latest_url" | grep "browser_download_url.*$binary_name" | head -1 | sed 's/.*"browser_download_url": *"//' | sed 's/".*//')

  if [[ -z "$download_url" ]]; then
    error "No download URL found for: $binary_name"
  fi

  local version=$(echo "$download_url" | sed 's/.*\/v/v/' | sed 's/\/.*//')
  info "Version: $version"

  # Create the install directory
  mkdir -p "$install_dir"

  # Back up an existing binary
  if [[ -f "$install_path" ]]; then
    info "Backing up the existing binary: ${install_path}.bak"
    mv "$install_path" "${install_path}.bak" 2>/dev/null || true
  fi

  # Download
  info "Downloading: $download_url"
  curl -fsSL "$download_url" -o "$install_path"
  chmod +x "$install_path"

  info "Installed: $install_path"
  echo ""
  "$install_path" --version
}

# Tell the user how to add it to PATH
show_path_instruction() {
  local install_dir="${HRDLE_INSTALL_DIR:-$HOME/bin}"

  if [[ ":$PATH:" != *":$install_dir:"* ]]; then
    echo ""
    warn "$install_dir is not in PATH"
    echo "  Add the following to .bashrc or .zshrc:"
    echo ""
    echo "    export PATH=\"\$HOME/bin:\$PATH\""
    echo ""
  fi
}

# Setup instructions
show_setup_instruction() {
  echo ""
  info "Next steps:"
  echo ""
  echo "  1. Allow Tailscale certificate generation:"
  echo "     sudo tailscale set --operator=\$USER"
  echo ""
  echo "  2. Start Hrdle:"
  echo "     hrdle"
  echo "     # or with a password"
  echo "     hrdle -P mypassword"
  echo ""
  echo "  3. (optional) Register it as a systemd service:"
  echo "     hrdle setup -P mypassword"
  echo ""
  echo "  Open in a browser: https://<hostname>:5924"
  echo ""
}

main() {
  echo ""
  echo "======================================"
  echo "  Hrdle installer"
  echo "======================================"
  echo ""

  # Detect the platform
  local binary_name
  binary_name=$(detect_platform)
  info "Platform: $binary_name"

  # Check dependencies
  check_dependencies

  # Download and install
  download_latest "$binary_name"

  # PATH instructions
  show_path_instruction

  # Setup instructions
  show_setup_instruction
}

main "$@"
