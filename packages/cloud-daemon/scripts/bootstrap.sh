#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "provider_runtime_unsupported" >&2
  exit 1
fi

node -e '
const [major, minor, patch] = process.version.slice(1).split(".").map(Number);
if (major < 22 || (major === 22 && (minor < 13 || (minor === 13 && patch < 0)))) {
  console.error("provider_runtime_unsupported");
  process.exit(1);
}
'

: "${WATT_DAEMON_TARBALL_URL:?}"
: "${WATT_DAEMON_TARBALL_SHA256:?}"
: "${WATT_DAEMON_CONFIG_VERSION:?}"
: "${CLOUD_DAEMON_TOKEN:?}"
: "${PORT:=8788}"

RUNTIME_ROOT="/workspace/watt/runtime"
CURRENT_LINK="/workspace/watt/current"
RUNTIME_DIR="${RUNTIME_ROOT}/${WATT_DAEMON_TARBALL_SHA256}"
STAMP="${RUNTIME_DIR}/.installed"

if [ ! -f "$STAMP" ]; then
  mkdir -p "$RUNTIME_DIR"
  tmp="$(mktemp)"
  curl -fsSL "$WATT_DAEMON_TARBALL_URL" -o "$tmp"
  printf '%s  %s\n' "$WATT_DAEMON_TARBALL_SHA256" "$tmp" | sha256sum -c -
  tar -xzf "$tmp" -C "$RUNTIME_DIR"
  rm -f "$tmp"
  touch "$STAMP"
fi

ln -sfn "$RUNTIME_DIR" "$CURRENT_LINK"

CONFIG_STAMP="/workspace/watt/.daemon-config-version"
config_changed=1
if [ -f "$CONFIG_STAMP" ] && [ "$(cat "$CONFIG_STAMP")" = "$WATT_DAEMON_CONFIG_VERSION" ]; then
  config_changed=0
fi

if ! getent group watt >/dev/null 2>&1; then
  groupadd --system --gid 10001 watt
fi
if ! id -u watt >/dev/null 2>&1; then
  useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/watt --create-home watt
fi

mkdir -p /var/lib/watt/state /var/lib/watt/worktrees /var/lib/watt/repositories /run/watt
chown root:root /var/lib/watt/repositories
chmod 0755 /var/lib/watt/repositories
install -d -o watt -g watt /var/lib/watt/state /var/lib/watt/worktrees
install -d -o root -g root /run/watt

supervisor="${CURRENT_LINK}/dist/supervisor.js"
if [ ! -f "$supervisor" ]; then
  echo "bootstrap_layout_invalid" >&2
  exit 1
fi

running=0
stale_pids=""
for pid in $(pgrep -f -- "${CURRENT_LINK}/dist/supervisor.js" || true); do
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [ "$cwd" = "$RUNTIME_DIR" ] && [ "$config_changed" -eq 0 ]; then
    running=1
  else
    stale_pids="${stale_pids} ${pid}"
    kill "$pid" 2>/dev/null || true
  fi
done
if [ -n "$stale_pids" ]; then
  for _ in $(seq 1 50); do
    alive=0
    for pid in $stale_pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.1
  done
  for pid in $stale_pids; do kill -KILL "$pid" 2>/dev/null || true; done
fi
if [ "$running" -eq 0 ]; then
  (
    cd "$CURRENT_LINK"
    nohup env \
      CLOUD_DAEMON_TOKEN="$CLOUD_DAEMON_TOKEN" \
      CURSOR_API_KEY="${CURSOR_API_KEY:-}" \
      PORT="$PORT" \
      WATT_STATE_DIR=/var/lib/watt/state \
      WATT_WORKTREE_ROOT=/var/lib/watt/worktrees \
      WATT_REPOSITORY_ROOT=/var/lib/watt/repositories \
      node "$supervisor" \
      >/var/log/watt-supervisor.log 2>&1 &
  )
fi

for _ in $(seq 1 60); do
  if curl -fsS -H "X-Watt-Daemon-Token: ${CLOUD_DAEMON_TOKEN}" "http://127.0.0.1:${PORT}/health" >/dev/null; then
    printf '%s\n' "$WATT_DAEMON_CONFIG_VERSION" > "$CONFIG_STAMP"
    exit 0
  fi
  sleep 1
done

echo "host_start_timeout" >&2
exit 1
