#!/usr/bin/env bash
# Recopie la source d'un module de feature depuis son checkout frère (à la
# racine du chantier) vers node_modules, pour le serveur tsx. Le client, lui,
# n'en a pas besoin en dev : vite.config.ts aliase le checkout directement.
# Même routine que le miroir deveye-types. Un module in-repo (features/*) n'en
# a jamais besoin : le lien de workspace rend ses éditions vivantes.
#
# Usage : scripts/dev-sync-feature.sh deveye-feature-<nom>
set -euo pipefail

pkg="${1:?usage: dev-sync-feature.sh deveye-feature-<nom>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/../$pkg"
dest="$root/node_modules/$pkg"

[ -d "$src/src" ] || { echo "checkout introuvable : $src" >&2; exit 1; }
[ -d "$dest" ] || { echo "package non installé : $dest (npm install ?)" >&2; exit 1; }

rsync -a --delete "$src/src/" "$dest/src/"
rsync -a --delete "$src/assets/" "$dest/assets/" 2>/dev/null || true
cp "$src/package.json" "$src/deveye-feature.json" "$dest/" 2>/dev/null || true
echo "miroir à jour : $pkg"
