#!/bin/bash
# Devin Orchestrator - Installation Script
# Installs the devin-agent CLI and its dependencies.
# Uses only official package managers. No third-party scripts.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

INSTALL_DIR="${DEVIN_ORCHESTRATOR_HOME:-$HOME/.devin-orchestrator}"
REPO_URL="${DEVIN_ORCHESTRATOR_REPO:-https://github.com/leofmarciano/devin-orchestrator.git}"

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; }

# -------------------------------------------------------------------
# Platform detection
# -------------------------------------------------------------------
detect_platform() {
  case "$(uname -s)" in
    Linux*)   PLATFORM="linux" ;;
    Darwin*)  PLATFORM="macos" ;;
    CYGWIN*|MINGW*|MSYS*)
      error "Windows is not directly supported."
      echo ""
      echo "Please use WSL (Windows Subsystem for Linux):"
      echo "  1. Install WSL: wsl --install"
      echo "  2. Open a WSL terminal"
      echo "  3. Re-run this script inside WSL"
      exit 1
      ;;
    *)
      error "Unsupported platform: $(uname -s)"
      exit 1
      ;;
  esac

  info "Platform: $PLATFORM ($(uname -m))"
}

# -------------------------------------------------------------------
# Detect package manager (Linux only)
# -------------------------------------------------------------------
detect_linux_pkg_manager() {
  if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
  elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
  elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
  elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
  elif command -v apk &>/dev/null; then
    PKG_MANAGER="apk"
  elif command -v zypper &>/dev/null; then
    PKG_MANAGER="zypper"
  else
    PKG_MANAGER=""
  fi
}

# -------------------------------------------------------------------
# Check and install tmux
# -------------------------------------------------------------------
check_tmux() {
  if command -v tmux &>/dev/null; then
    success "tmux: $(tmux -V)"
    return 0
  fi

  warn "tmux not found. Installing..."

  if [ "$PLATFORM" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      error "Homebrew not found. Install it from https://brew.sh then re-run this script."
      exit 1
    fi
    brew install tmux
  elif [ "$PLATFORM" = "linux" ]; then
    detect_linux_pkg_manager
    case "$PKG_MANAGER" in
      apt)     sudo apt-get update && sudo apt-get install -y tmux ;;
      dnf)     sudo dnf install -y tmux ;;
      yum)     sudo yum install -y tmux ;;
      pacman)  sudo pacman -S --noconfirm tmux ;;
      apk)     sudo apk add tmux ;;
      zypper)  sudo zypper install -y tmux ;;
      *)
        error "No supported package manager found. Install tmux manually:"
        echo "  https://github.com/tmux/tmux/wiki/Installing"
        exit 1
        ;;
    esac
  fi

  if command -v tmux &>/dev/null; then
    success "tmux installed: $(tmux -V)"
  else
    error "tmux installation failed."
    exit 1
  fi
}

# -------------------------------------------------------------------
# Check and install Bun
# -------------------------------------------------------------------
check_bun() {
  if command -v bun &>/dev/null; then
    success "bun: $(bun --version)"
    return 0
  fi

  warn "Bun not found. Installing via official installer..."
  echo ""
  info "Bun install page: https://bun.sh"
  echo ""

  # Official Bun installer from bun.sh
  curl -fsSL https://bun.sh/install | bash

  # Source the updated profile so bun is on PATH
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    success "bun installed: $(bun --version)"
  else
    error "Bun installation failed. Install manually from https://bun.sh"
    exit 1
  fi
}

# -------------------------------------------------------------------
# Check for Devin CLI
# -------------------------------------------------------------------
check_devin() {
  if command -v devin &>/dev/null; then
    success "devin CLI: found"
    return 0
  fi

  warn "Devin CLI not found."
  echo ""
  echo "The Devin CLI is the coding agent that devin-orchestrator controls."
  echo ""
  echo "Install it with the official installer:"
  echo "  curl -fsSL https://cli.devin.ai/install.sh | sh"
  echo ""
  echo "Then authenticate:"
  echo "  devin auth login"
  echo ""

  read -p "Do you want to install it now? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if command -v curl &>/dev/null; then
      curl -fsSL https://cli.devin.ai/install.sh | sh
      if command -v devin &>/dev/null || [[ -x "$HOME/.local/bin/devin" ]]; then
        success "devin CLI installed"
        echo ""
        warn "You still need to authenticate: devin auth login"
      else
        error "Devin CLI installation failed."
        exit 1
      fi
    else
      error "curl not found. Install the Devin CLI manually: https://cli.devin.ai/install.sh"
      exit 1
    fi
  else
    warn "Skipping Devin CLI install. You'll need it before using devin-agent."
  fi
}

# -------------------------------------------------------------------
# Install devin-orchestrator
# -------------------------------------------------------------------
install_orchestrator() {
  if [ -d "$INSTALL_DIR" ]; then
    info "Updating existing installation at $INSTALL_DIR"
    cd "$INSTALL_DIR"
    git pull --ff-only origin main
  else
    info "Cloning devin-orchestrator to $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  info "Installing dependencies..."
  bun install

  # Add to PATH
  local BIN_DIR="$INSTALL_DIR/bin"
  local PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""

  if command -v devin-agent &>/dev/null; then
    success "devin-agent already on PATH"
  else
    # Detect shell profile
    local SHELL_PROFILE=""
    if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "$(which zsh 2>/dev/null)" ]; then
      SHELL_PROFILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
      SHELL_PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
      SHELL_PROFILE="$HOME/.bash_profile"
    fi

    if [ -n "$SHELL_PROFILE" ]; then
      # Check if already in profile
      if grep -q "devin-orchestrator/bin" "$SHELL_PROFILE" 2>/dev/null; then
        info "PATH entry already in $SHELL_PROFILE"
      else
        echo "" >> "$SHELL_PROFILE"
        echo "# devin-orchestrator" >> "$SHELL_PROFILE"
        echo "$PATH_LINE" >> "$SHELL_PROFILE"
        success "Added to PATH in $SHELL_PROFILE"
      fi
    else
      warn "Could not detect shell profile."
      echo ""
      echo "Add this line to your shell profile manually:"
      echo "  $PATH_LINE"
    fi

    # Make it available in current session
    export PATH="$BIN_DIR:$PATH"
  fi
}

# -------------------------------------------------------------------
# Verify installation
# -------------------------------------------------------------------
verify() {
  echo ""
  info "Running health check..."
  echo ""

  if command -v devin-agent &>/dev/null; then
    devin-agent health
  elif [ -f "$INSTALL_DIR/bin/devin-agent" ]; then
    "$INSTALL_DIR/bin/devin-agent" health
  else
    error "devin-agent binary not found after installation."
    exit 1
  fi

  echo ""
  success "Installation complete!"
  echo ""
  echo "Quick start:"
  echo "  devin-agent start \"Review this codebase for issues\" --map"
  echo "  devin-agent jobs --json"
  echo "  devin-agent capture <jobId>"
  echo ""

  if ! command -v devin &>/dev/null; then
    warn "Reminder: Install the Devin CLI before using devin-agent:"
    echo "  curl -fsSL https://cli.devin.ai/install.sh | sh"
    echo "  devin auth login"
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------
main() {
  echo ""
  echo "========================================="
  echo "  Devin Orchestrator - Setup"
  echo "========================================="
  echo ""

  detect_platform
  echo ""

  check_tmux
  check_bun
  check_devin

  echo ""
  install_orchestrator

  verify
}

main "$@"
