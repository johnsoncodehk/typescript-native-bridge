#!/usr/bin/env bash
# Install + build a volar checkout against this repo — the one recipe behind
# ci.yml, nightly.yml and the AGENTS.md local setup.
#   tools/install-volar.sh <volar-dir>
#
# Frozen: volar's lockfile is the resolution pnpm 11's supply-chain policies
# already vetted. Rewriting its `typescript` override to link: this repo made
# pnpm re-resolve every `latest` specifier from scratch (vitest 5.0.2 pulled
# why-is-node-running@3.2.2, which trustPolicy rejects), so the lockfile's
# released TNB is installed and its store entries are repointed here instead.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$1"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
pnpm install --frozen-lockfile
shopt -s nullglob
entries=(node_modules/.pnpm/typescript-native-bridge@*/node_modules/typescript-native-bridge)
((${#entries[@]})) || { echo "install-volar: volar's lockfile has no typescript-native-bridge entry" >&2; exit 1; }
for d in "${entries[@]}"; do
	rm -rf "$d"
	ln -s "$repo" "$d"
done
# The released package's platform bridges resolve ahead of <repo>/native
# (tsgoChecker's bridge lookup order) from any non-realpath load of the store
# entry — pairing this commit's JS with the pinned release's bridge.node.
rm -rf node_modules/.pnpm/@typescript-native-bridge+* node_modules/.pnpm/typescript-native-bridge@*/node_modules/@typescript-native-bridge
pnpm run build
