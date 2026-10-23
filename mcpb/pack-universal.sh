#!/usr/bin/env bash
# Pack the universal MCP Bundle: the macOS and Windows native binaries in one .mcpb, with the manifest's
# platform_overrides choosing the right one at launch. This is the bundle for when one file has to serve
# both platforms; direct downloads should use the per-platform bundles. Linux is left out: Claude Desktop
# does not run there, and it keeps the bundle small; Linux users take the standalone binary.
#
#   mcpb/pack-universal.sh <version> <binaries-dir> <output.mcpb> [artifact-prefix]
#
#   version       release version without the "v" prefix, e.g. 1.0.12
#   binaries-dir  directory holding <prefix>-<version>-{macos-aarch64,windows-x86_64.exe}
#   output        path of the bundle to write
#   artifact-prefix  defaults to email-mcp-server; use mcp-email-server for historical releases
#
# Run on Linux or macOS: the executable bit of the macOS binary must end up in the zip, and a pack done on
# Windows cannot set it.
set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
	echo "usage: $0 <version> <binaries-dir> <output.mcpb> [artifact-prefix]" >&2
	exit 2
fi
VERSION="$1"; SRC="$2"; OUTPUT="$3"
ARTIFACT_PREFIX="${4:-email-mcp-server}"
case "$ARTIFACT_PREFIX" in
	email-mcp-server|mcp-email-server) ;;
	*) echo "unsupported artifact prefix: $ARTIFACT_PREFIX" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/server"
cp "$HERE/../docs/assets/email-mcp-icon.png" "$STAGE/icon.png"
for suffix in macos-aarch64 windows-x86_64.exe; do
	name="${ARTIFACT_PREFIX}-${VERSION}-${suffix}"
	if [ ! -f "$SRC/$name" ]; then
		echo "missing binary: $SRC/$name" >&2
		exit 1
	fi
	cp "$SRC/$name" "$STAGE/server/$name"
	chmod +x "$STAGE/server/$name"
done
sed -e "s/__VERSION__/${VERSION}/g" -e "s/__ARTIFACT_PREFIX__/${ARTIFACT_PREFIX}/g" \
	"$HERE/manifest-universal.json" > "$STAGE/manifest.json"

npx -y @anthropic-ai/mcpb validate "$STAGE/manifest.json"
npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUTPUT"
echo "packed $OUTPUT (universal)"
