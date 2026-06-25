#!/usr/bin/env bash
set -euo pipefail

OWNER="${WORKCTL_GITHUB_OWNER:-justdoswift}"
REPO="${WORKCTL_GITHUB_REPO:-workctl}"
REF="${WORKCTL_REF:-main}"
INSTALL_DIR="${WORKCTL_INSTALL_DIR:-"$HOME/.workctl/cli"}"
BIN_DIR="${WORKCTL_BIN_DIR:-"$HOME/.workctl/bin"}"
OLD_INSTALL_DIR="$HOME/.kslog/cli"
OLD_BIN="$HOME/.kslog/bin/kslog"
TARBALL_URL="https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${REF}"

info() {
  printf '==> %s\n' "$1"
}

fail() {
  printf 'workctl install error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "需要先安装 $1"
}

require_command curl
require_command tar
require_command cargo
require_command rustc

PARENT_DIR="$(dirname "$INSTALL_DIR")"
mkdir -p "$PARENT_DIR" "$BIN_DIR"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workctl-install.XXXXXX")"
NEW_DIR="$(mktemp -d "${PARENT_DIR}/.workctl-cli.XXXXXX")"
BACKUP_DIR=""

cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "${NEW_DIR:-}" ] && [ -d "$NEW_DIR" ]; then
    rm -rf "$NEW_DIR"
  fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
  fi
}
trap cleanup EXIT

info "Downloading ${OWNER}/${REPO}@${REF}"
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/workctl.tar.gz"
tar -xzf "$TMP_DIR/workctl.tar.gz" --strip-components=1 -C "$NEW_DIR"

[ -f "$NEW_DIR/Cargo.toml" ] || fail "安装包缺少 Cargo.toml"

info "Building release binary with cargo"
(
  cd "$NEW_DIR"
  cargo build --release --locked
)

[ -x "$NEW_DIR/target/release/workctl" ] || fail "构建产物缺少 target/release/workctl"

if [ -e "$INSTALL_DIR" ]; then
  BACKUP_DIR="${INSTALL_DIR}.previous.$$"
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi

mv "$NEW_DIR" "$INSTALL_DIR"
NEW_DIR=""
rm -rf "$BACKUP_DIR"
BACKUP_DIR=""

cp "$INSTALL_DIR/target/release/workctl" "$BIN_DIR/workctl"
chmod +x "$BIN_DIR/workctl"

rm -rf "$OLD_INSTALL_DIR" "$OLD_BIN"

VERSION="$("$BIN_DIR/workctl" --version)"
info "Installed workctl ${VERSION}"
printf 'Binary: %s\n' "$BIN_DIR/workctl"
printf 'Profiles: %s\n' "$HOME/.workctl/profiles.json"
printf 'Legacy profiles, if present, remain in: %s\n' "$HOME/.kslog/profiles.json"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nAdd workctl to PATH:\n'
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    printf '\nFor zsh, you can run:\n'
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$BIN_DIR"
    ;;
esac
