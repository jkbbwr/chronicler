#!/usr/bin/env bash
set -euo pipefail

# Chronicler Linux Build Script
# Builds the Linux ELF backend (via Docker on macOS, or natively on Linux)
# and packages the Electron app (.AppImage, .deb, .tar.gz).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARCH="x64"
SKIP_BACKEND=false
BACKEND_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH="$2"
      shift 2
      ;;
    --x64|--amd64)
      ARCH="x64"
      shift
      ;;
    --arm64|--aarch64)
      ARCH="arm64"
      shift
      ;;
    --skip-backend)
      SKIP_BACKEND=true
      shift
      ;;
    --backend-only)
      BACKEND_ONLY=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "Options:"
      echo "  --arch <x64|arm64>   Target architecture (default: x64)"
      echo "  --skip-backend       Skip compiling backend if binary already exists"
      echo "  --backend-only       Only build the Linux backend binary"
      echo "  -h, --help           Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Architecture mapping
case "$ARCH" in
  x64|amd64)
    LINUX_ARCH="x64"
    CARGO_TARGET_DIR_NAME="linux-x64"
    DOCKER_PLATFORM="linux/amd64"
    ;;
  arm64|aarch64)
    LINUX_ARCH="arm64"
    CARGO_TARGET_DIR_NAME="linux-arm64"
    DOCKER_PLATFORM="linux/arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

LINUX_BINARY_DIR="${PROJECT_ROOT}/backend/target/${CARGO_TARGET_DIR_NAME}/release"
LINUX_BINARY="${LINUX_BINARY_DIR}/chronicler-backend"
STANDARD_RELEASE_DIR="${PROJECT_ROOT}/backend/target/release"
STANDARD_RELEASE_BINARY="${STANDARD_RELEASE_DIR}/chronicler-backend"
BACKUP_BINARY="${STANDARD_RELEASE_DIR}/chronicler-backend.host-backup"

# Locate Docker
find_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
  else
    echo ""
  fi
}

echo "=== Chronicler Linux Build (${LINUX_ARCH}) ==="

# 1. Build Linux Backend
if [[ "$SKIP_BACKEND" == true && -f "$LINUX_BINARY" ]]; then
  echo "=> Skipping backend compilation (using existing $LINUX_BINARY)"
else
  echo "=> Building Linux backend binary..."
  mkdir -p "$LINUX_BINARY_DIR"

  IS_LINUX=false
  if [[ "$(uname -s)" == "Linux" ]]; then
    IS_LINUX=true
  fi

  if [[ "$IS_LINUX" == true ]] && command -v cargo >/dev/null 2>&1; then
    echo "   Building natively on Linux host..."
    CARGO_TARGET_DIR="${PROJECT_ROOT}/backend/target/${CARGO_TARGET_DIR_NAME}" cargo build \
      --manifest-path "${PROJECT_ROOT}/backend/Cargo.toml" \
      --release
  else
    DOCKER_BIN="$(find_docker)"
    if [[ -z "$DOCKER_BIN" ]]; then
      echo "Error: Docker is required to cross-compile the Linux backend on macOS." >&2
      echo "Please install Docker Desktop and ensure Docker daemon is running." >&2
      exit 1
    fi

    echo "   Building in Docker container (rust:trixie for GCC 14 / ONNX Runtime compatibility)..."
    "$DOCKER_BIN" run --rm \
      --platform "$DOCKER_PLATFORM" \
      -v "${PROJECT_ROOT}":/workspace \
      -w /workspace/backend \
      -e CARGO_TARGET_DIR="/workspace/backend/target/${CARGO_TARGET_DIR_NAME}" \
      rust:trixie \
      cargo build --release
  fi
fi

if [[ ! -f "$LINUX_BINARY" ]]; then
  echo "Error: Linux binary not found at $LINUX_BINARY" >&2
  exit 1
fi

echo "=> Backend binary ready:"
file "$LINUX_BINARY"

if [[ "$BACKEND_ONLY" == true ]]; then
  echo "=> Finished (--backend-only requested)."
  exit 0
fi

# 2. Setup Staging for Electron Builder and restore handler
cleanup() {
  if [[ -f "$BACKUP_BINARY" ]]; then
    echo "=> Restoring original host backend binary..."
    mv "$BACKUP_BINARY" "$STANDARD_RELEASE_BINARY"
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$STANDARD_RELEASE_DIR"
if [[ -f "$STANDARD_RELEASE_BINARY" ]]; then
  cp "$STANDARD_RELEASE_BINARY" "$BACKUP_BINARY"
fi

cp "$LINUX_BINARY" "$STANDARD_RELEASE_BINARY"
chmod +x "$STANDARD_RELEASE_BINARY"

# 3. Package Frontend
echo "=> Building frontend and packaging with electron-builder..."
cd "${PROJECT_ROOT}/frontend"

if command -v bun >/dev/null 2>&1; then
  bun run build
  bunx electron-builder --linux --"$LINUX_ARCH"
elif command -v npm >/dev/null 2>&1; then
  npm run build
  npx electron-builder --linux --"$LINUX_ARCH"
else
  echo "Error: Neither bun nor npm found." >&2
  exit 1
fi

echo ""
echo "=== Linux Build Complete ==="
echo "Artifacts generated in frontend/release/:"
ls -lh "${PROJECT_ROOT}/frontend/release/"*.deb "${PROJECT_ROOT}/frontend/release/"*.AppImage "${PROJECT_ROOT}/frontend/release/"*.tar.gz 2>/dev/null || true
