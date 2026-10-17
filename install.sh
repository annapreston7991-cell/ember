#!/usr/bin/env bash
# Ember installer — part of the LLYVerse (https://llyverse.org)
# Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
#
# Usage (from a clone):   ./install.sh
# Installs the `ember` command globally with npm. If npm's global folder isn't writable
# (the usual cause of EACCES errors), it switches npm to a per-user prefix (~/.npm-global)
# and adds it to your PATH. It never uses sudo.
set -euo pipefail

say() { printf '\033[1;33m▲ ember\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"

command -v node >/dev/null || die "Node.js is not installed. Get Node 18+ from https://nodejs.org (or: nvm install --lts)."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || die "Node.js $(node -v) is too old; Ember needs 18 or newer."
command -v npm >/dev/null || die "npm is missing (it normally comes with Node.js)."

prefix=$(npm prefix -g)
target="$prefix/lib/node_modules"; [ -d "$target" ] || target="$prefix/lib"; [ -d "$target" ] || target="$prefix"
if [ ! -w "$target" ] || { [ -d "$prefix/bin" ] && [ ! -w "$prefix/bin" ]; }; then
  say "npm's global folder ($prefix) isn't writable; using ~/.npm-global instead (no sudo needed)."
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  prefix="$HOME/.npm-global"
fi

say "installing dependencies and the ember command…"
npm install --no-fund --no-audit
npm install -g . --no-fund --no-audit
chmod +x bin/ember.js

bindir="$prefix/bin"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *)
    line="export PATH=\"$bindir:\$PATH\""
    for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"; do
      [ -f "$rc" ] || continue
      grep -qsF "$bindir" "$rc" || { printf '\n# added by Ember installer\n%s\n' "$line" >> "$rc"; say "added $bindir to PATH in $rc"; }
    done
    export PATH="$bindir:$PATH"
    say "open a new terminal (or run: source ~/.bashrc) so 'ember' is on your PATH."
    ;;
esac

"$bindir/ember" --version >/dev/null || die "install finished but $bindir/ember doesn't run."
say "installed $("$bindir/ember" --version). Type 'ember' in any project folder; first run sets everything up."
