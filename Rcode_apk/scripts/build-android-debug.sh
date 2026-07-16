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
  exec "$GRADLE_BIN" assembleDebug
fi

exec ./gradlew assembleDebug
