#!/bin/bash
# Hrdle インストールスクリプト
# Usage: curl -fsSL https://raw.githubusercontent.com/hrdle/hrdle/main/install.sh | bash

set -e

# 色付き出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# OS/アーキテクチャ検出
detect_platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    linux) os="linux" ;;
    darwin) os="macos" ;;
    *) error "未サポートのOS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "未サポートのアーキテクチャ: $arch" ;;
  esac

  # 現在サポートしているプラットフォーム
  if [[ "$os" == "linux" && "$arch" == "x64" ]]; then
    echo "hrdle-linux-x64"
  elif [[ "$os" == "macos" && "$arch" == "arm64" ]]; then
    echo "hrdle-macos-arm64"
  else
    error "未サポートのプラットフォーム: $os-$arch (サポート: linux-x64, macos-arm64)"
  fi
}

# 依存関係チェック
check_dependencies() {
  info "依存関係を確認中..."

  # herdr — Hrdle runs every session in a herdr workspace, so this is required.
  if ! command -v herdr &> /dev/null; then
    warn "herdrがインストールされていません"
    echo "  curl -fsSL https://herdr.dev/install.sh | sh"
    echo "  macOS: brew install herdr"
    exit 1
  fi
  info "  herdr: $(herdr --version 2>/dev/null || echo 'installed')"

  # Tailscale
  if ! command -v tailscale &> /dev/null; then
    warn "Tailscaleがインストールされていません"
    echo "  https://tailscale.com/download"
    exit 1
  fi
  info "  tailscale: $(tailscale version | head -1)"

  # Claude Code (オプション)
  if command -v claude &> /dev/null; then
    info "  claude: $(claude --version 2>/dev/null || echo 'installed')"
  else
    warn "Claude Codeがインストールされていません (後でインストール可能)"
  fi
}

# 最新リリースのダウンロード
download_latest() {
  local binary_name="$1"
  local install_dir="${HRDLE_INSTALL_DIR:-$HOME/bin}"
  local install_path="$install_dir/hrdle"

  info "最新リリースを取得中..."
  local latest_url="https://api.github.com/repos/hrdle/hrdle/releases/latest"
  local download_url

  download_url=$(curl -fsSL "$latest_url" | grep "browser_download_url.*$binary_name" | head -1 | sed 's/.*"browser_download_url": *"//' | sed 's/".*//')

  if [[ -z "$download_url" ]]; then
    error "ダウンロードURLが見つかりません: $binary_name"
  fi

  local version=$(echo "$download_url" | sed 's/.*\/v/v/' | sed 's/\/.*//')
  info "バージョン: $version"

  # インストールディレクトリ作成
  mkdir -p "$install_dir"

  # 既存のバイナリをバックアップ
  if [[ -f "$install_path" ]]; then
    info "既存のバイナリをバックアップ: ${install_path}.bak"
    mv "$install_path" "${install_path}.bak" 2>/dev/null || true
  fi

  # ダウンロード
  info "ダウンロード中: $download_url"
  curl -fsSL "$download_url" -o "$install_path"
  chmod +x "$install_path"

  info "インストール完了: $install_path"
  echo ""
  "$install_path" --version
}

# PATHに追加する案内
show_path_instruction() {
  local install_dir="${HRDLE_INSTALL_DIR:-$HOME/bin}"

  if [[ ":$PATH:" != *":$install_dir:"* ]]; then
    echo ""
    warn "PATHに $install_dir が含まれていません"
    echo "  以下を .bashrc または .zshrc に追加してください:"
    echo ""
    echo "    export PATH=\"\$HOME/bin:\$PATH\""
    echo ""
  fi
}

# セットアップ案内
show_setup_instruction() {
  echo ""
  info "次のステップ:"
  echo ""
  echo "  1. Tailscale証明書生成を許可:"
  echo "     sudo tailscale set --operator=\$USER"
  echo ""
  echo "  2. Hrdleを起動:"
  echo "     hrdle"
  echo "     # または パスワード付き"
  echo "     hrdle -P mypassword"
  echo ""
  echo "  3. (オプション) systemdサービスとして登録:"
  echo "     hrdle setup -P mypassword"
  echo ""
  echo "  ブラウザでアクセス: https://<hostname>:5924"
  echo ""
}

main() {
  echo ""
  echo "======================================"
  echo "  Hrdle インストーラー"
  echo "======================================"
  echo ""

  # プラットフォーム検出
  local binary_name
  binary_name=$(detect_platform)
  info "プラットフォーム: $binary_name"

  # 依存関係チェック
  check_dependencies

  # ダウンロード & インストール
  download_latest "$binary_name"

  # PATH案内
  show_path_instruction

  # セットアップ案内
  show_setup_instruction
}

main "$@"
