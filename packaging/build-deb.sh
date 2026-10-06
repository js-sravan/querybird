#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

version="${1:-${VERSION:-1.0.0}}"
architecture="$(dpkg --print-architecture)"

case "$version" in
  ''|[!0-9]*|*[!0-9A-Za-z.+:~_-]*)
    echo "Invalid Debian package version: $version" >&2
    exit 1
    ;;
esac

if [ "$architecture" != "amd64" ]; then
  echo "This package script currently targets amd64 Ubuntu/Debian systems." >&2
  exit 1
fi

for tool in wails dpkg dpkg-deb install; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required packaging tool not found: $tool" >&2
    exit 1
  fi
done

wails build -platform linux/amd64

package_root="$(mktemp -d "${TMPDIR:-/tmp}/querybird-deb.XXXXXX")"
trap 'rm -rf "$package_root"' EXIT HUP INT TERM

mkdir -p \
  "$package_root/DEBIAN" \
  "$package_root/usr/bin" \
  "$package_root/usr/share/applications" \
  "$package_root/usr/share/icons/hicolor/512x512/apps" \
  build/bin

sed "s/^Version: .*/Version: $version/; s/^Architecture: .*/Architecture: $architecture/" \
  packaging/debian/control > "$package_root/DEBIAN/control"
install -m 0644 packaging/debian/dbclient.desktop "$package_root/usr/share/applications/QueryBird.desktop"
install -m 0755 build/bin/QueryBird "$package_root/usr/bin/QueryBird"
install -m 0644 frontend/public/querybird-mark.png "$package_root/usr/share/icons/hicolor/512x512/apps/QueryBird.png"
chmod 0755 "$package_root"

package_file="build/bin/QueryBird_${version}_${architecture}.deb"
dpkg-deb --root-owner-group --build "$package_root" "$package_file"

echo "Created $package_file"
