#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

npm run verify

version=$(node -p 'require("./manifest.json").version')
dist_dir="$project_dir/dist"
mkdir -p "$dist_dir"
archive="$dist_dir/hunkmark-$version.zip"
checksum_file="$archive.sha256"
staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/hunkmark.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM

cp manifest.json core.js content.js content.css LICENSE PRIVACY.md "$staging_dir/"
cp -R content "$staging_dir/content"
cp -R icons "$staging_dir/icons"

export TZ=UTC
find "$staging_dir" -type d -exec chmod 755 {} +
find "$staging_dir" -type f -exec chmod 644 {} +
find "$staging_dir" -exec touch -t 200001010000 {} +

rm -f "$archive" "$checksum_file"
(
  cd "$staging_dir"
  find . -type f -print | LC_ALL=C sort | zip -X -q "$archive" -@
)

unzip -t "$archive"
checksum=$(shasum -a 256 "$archive" | awk '{print $1}')
printf '%s  %s\n' "$checksum" "$(basename "$archive")" > "$checksum_file"
echo "Created $archive"
echo "Created $checksum_file"
