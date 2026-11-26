// Runner distribution: the bundle (one .mjs file that runs on Node 22+ or Bun) and install.sh.
// A plain install script downloads the bundle without checking anything; here the script carries the sha256 of the
// bundle this same server serves and will not install when the downloaded file does not match (cache, proxy or CDN on the way).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { PRODUCT } from "@vanr/product";
import { BUNDLE_NAME, bundleRunner } from "@vanr/runner/bundle";

export interface RunnerBundle {
  bytes: Uint8Array;
  sha256: string;
}

let cached: Promise<RunnerBundle> | null = null;

const PREBUILT = new URL(`../../../runner/dist/${BUNDLE_NAME}`, import.meta.url).pathname;

async function build(): Promise<RunnerBundle> {
  const path = process.env.RUNNER_BUNDLE || (existsSync(PREBUILT) ? PREBUILT : null);
  const bytes = path ? new Uint8Array(readFileSync(path)) : await bundleRunner();
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The bundle is built once per process (on the first request for it). */
export function runnerBundle(): Promise<RunnerBundle> {
  cached ??= build().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The server address the script pairs with: an http(s) URL, without credentials and without control
 * characters (a line break would start a new command in the script). Returned as the URL normalizes it.
 */
export function installServerUrl(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("The server URL has a control character");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The server URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("The server URL must be http(s)");
  if (url.username || url.password) throw new Error("The server URL must not carry credentials");
  if (url.search || url.hash) throw new Error("The server URL must not have a query or a fragment");
  return url.toString().replace(/\/$/, "");
}

/** Names the script uses outside quotes or inside double quotes: letters, digits, dot, dash and underscore. */
const safeName = (name: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unsafe name in the install script: ${name}`);
  return name;
};

export function installScript(input: { server: string; sha256: string }): string {
  const server = installServerUrl(input.server);
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("The bundle sha256 must be 64 hex characters");
  const homeVar = safeName(`${PRODUCT.slug.toUpperCase()}_RUNNER_HOME`);
  const runnerDir = safeName(PRODUCT.runnerDir);
  const quotedServer = shellQuote(server);
  const quotedInstall = shellQuote(`${server}/api/v1/runners/install.sh`);
  return `#!/bin/sh
# Installs ${safeName(PRODUCT.runnerName)} on this computer and pairs it with ${quotedServer}.
# Usage: curl -fsSL ${quotedInstall} | sh -s -- [--name NAME] [--dir FOLDER] [--no-exec] [--no-service] [--no-pair]
set -eu

SERVER=${quotedServer}
BUNDLE_SHA256=${shellQuote(input.sha256)}
NAME=${shellQuote(PRODUCT.runnerName)}
RUNNER_HOME="\${${homeVar}:-$HOME/${runnerDir}}"
BUNDLE="$RUNNER_HOME/$NAME.mjs"
BIN_DIR="$RUNNER_HOME/bin"

RUNNER_NAME=""
WORKDIR=""
NO_EXEC=0
NO_SERVICE=0
NO_PAIR=0

fail() { echo "$NAME: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) RUNNER_NAME="\${2:-}"; shift 2 ;;
    --name=*) RUNNER_NAME="\${1#*=}"; shift ;;
    --dir) WORKDIR="\${2:-}"; shift 2 ;;
    --dir=*) WORKDIR="\${1#*=}"; shift ;;
    --no-exec) NO_EXEC=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-pair) NO_PAIR=1; shift ;;
    -h|--help) echo "options: --name NAME --dir FOLDER --no-exec --no-service --no-pair"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done

RUNTIME=""
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -ge 22 ] 2>/dev/null; then RUNTIME="$(command -v node)"; fi
fi
if [ -z "$RUNTIME" ] && command -v bun >/dev/null 2>&1; then RUNTIME="$(command -v bun)"; fi
if [ -z "$RUNTIME" ] && [ -x "$HOME/.bun/bin/bun" ]; then RUNTIME="$HOME/.bun/bin/bun"; fi
[ -n "$RUNTIME" ] || fail "needs Node.js 22+ or Bun (https://nodejs.org or https://bun.sh)"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else return 1
  fi
}

mkdir -p "$BIN_DIR"
chmod 700 "$RUNNER_HOME"
TMP="$BUNDLE.download"
rm -f "$TMP"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SERVER/runner/$NAME.mjs" -o "$TMP" || fail "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$SERVER/runner/$NAME.mjs" || fail "download failed"
else
  fail "needs curl or wget"
fi

GOT="$(sha256_of "$TMP")" || { rm -f "$TMP"; fail "needs sha256sum, shasum or openssl to check the download"; }
if [ "$GOT" != "$BUNDLE_SHA256" ]; then
  rm -f "$TMP"
  fail "checksum mismatch: expected $BUNDLE_SHA256, got $GOT. Nothing was installed."
fi
mv "$TMP" "$BUNDLE"
chmod 644 "$BUNDLE"

cat > "$BIN_DIR/$NAME" <<LAUNCHER
#!/bin/sh
exec "$RUNTIME" "$BUNDLE" "\\$@"
LAUNCHER
chmod 755 "$BIN_DIR/$NAME"
echo "Installed $NAME in $BIN_DIR (sha256 ok)."

# Without bubblewrap and socat, the runner rejects the agents' commands (the sandbox is mandatory on Linux).
if [ "$(uname -s)" = "Linux" ]; then
  MISSING=""
  command -v bwrap >/dev/null 2>&1 || MISSING="$MISSING bubblewrap"
  command -v socat >/dev/null 2>&1 || MISSING="$MISSING socat"
  if [ -n "$MISSING" ]; then
    echo "Agent commands run isolated and need:$MISSING. Install with: sudo apt install$MISSING (or your distro's package manager)."
  fi
fi

if [ "$NO_PAIR" = 1 ]; then exit 0; fi

if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json"; then
  echo "This computer is already connected. To pair again: $BIN_DIR/$NAME pair --new"
else
  set -- pair --server "$SERVER"
  [ -n "$RUNNER_NAME" ] && set -- "$@" --name "$RUNNER_NAME"
  [ -n "$WORKDIR" ] && set -- "$@" --dir "$WORKDIR"
  [ "$NO_EXEC" = 1 ] && set -- "$@" --no-exec
  "$BIN_DIR/$NAME" "$@" || fail "pairing did not finish"
fi

if [ "$NO_SERVICE" = 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$NAME.service" <<UNIT
[Unit]
Description=$NAME
After=network-online.target

[Service]
ExecStart=$BIN_DIR/$NAME start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.service" && echo "Running as a user service ($NAME.service)."
elif [ "$NO_SERVICE" = 0 ] && [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$NAME.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$NAME</string>
<key>ProgramArguments</key><array><string>$BIN_DIR/$NAME</string><string>start</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLIST_END
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
  echo "Running as a launch agent ($NAME)."
else
  echo "Start it with: $BIN_DIR/$NAME start"
fi
`;
}
