#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf '%s\n' 'Usage: sh build.sh OUTPUT.app [LLAMA_RELEASE_ARCHIVE]' >&2
    exit 2
fi
output=$1
if [ -e "$output" ]; then
    printf '%s\n' "Output already exists: $output" >&2
    exit 1
fi

source_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
release=b12359
name="llama-$release-bin-macos-arm64.tar.gz"
archive=${2:-"$work/$name"}
if [ "$#" -eq 1 ]; then
    /usr/bin/curl -fsSL --retry 2 --max-time 120 \
        "https://github.com/ggml-org/llama.cpp/releases/download/$release/$name" -o "$archive"
fi
printf '%s  %s\n' 82b00abc740160e1b9980e6cc79c117345fa34af058c80e6c0a69aa8ddccde75 "$archive" | /usr/bin/shasum -a 256 -c -
/usr/bin/tar -xzf "$archive" -C "$work"

app="$work/PLaMoを起動.app"
runtime="$app/Contents/Helpers/llama"
resources="$app/Contents/Resources"
payload="$work/llama-$release"
mkdir -p "$app/Contents/MacOS" "$runtime" "$resources" "$work/PLaMo.iconset"
/bin/cp -P "$payload/llama-server" "$payload"/libggml*.dylib \
    "$payload"/libllama.*dylib "$payload"/libllama-common*.dylib \
    "$payload/libllama-server-impl.dylib" "$payload"/libmtmd*.dylib "$runtime/"
/bin/cp "$payload/LICENSE" "$resources/llama-LICENSE"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>local.plamo.launcher</string>
    <key>CFBundleName</key><string>PLaMoを起動</string>
    <key>CFBundleDisplayName</key><string>PLaMoを起動</string>
    <key>CFBundleExecutable</key><string>PLaMoLauncher</string>
    <key>CFBundleIconFile</key><string>PLaMo.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>6</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$source_dir/icon.png" --out "$work/PLaMo.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -z "$double" "$double" "$source_dir/icon.png" --out "$work/PLaMo.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$work/PLaMo.iconset" -o "$resources/PLaMo.icns"
/usr/bin/swiftc -parse-as-library -target arm64-apple-macos14.0 -module-cache-path "$work/module-cache" \
    -warnings-as-errors "$source_dir/main.swift" -o "$app/Contents/MacOS/PLaMoLauncher"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"
/bin/mv -n "$app" "$output"
test ! -e "$app"
printf 'Built %s\n' "$output"
