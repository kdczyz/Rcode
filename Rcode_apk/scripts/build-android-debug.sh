#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ANDROID_STUDIO_JDK="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

if [ -x "$ANDROID_STUDIO_JDK/bin/java" ]; then
  JAVA_HOME="$ANDROID_STUDIO_JDK"
  export JAVA_HOME
fi

cd "$ROOT_DIR/android"

GRADLE_BIN=$(find "$HOME/.gradle/wrapper/dists/gradle-8.13-bin" -type f -path '*/gradle-8.13/bin/gradle' 2>/dev/null | head -n 1 || true)
if [ -n "$GRADLE_BIN" ] && [ -x "$GRADLE_BIN" ]; then
  "$GRADLE_BIN" assembleDebug
else
  ./gradlew assembleDebug
fi

VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
ARTIFACT_DIR="$ROOT_DIR/../artifacts/mobile"
OUTPUT_PATH="$ARTIFACT_DIR/Rcode-android-$VERSION-debug.apk"
mkdir -p "$ARTIFACT_DIR"
cp "$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk" "$OUTPUT_PATH"
echo "APK: $OUTPUT_PATH"
