export const MACHINE_PORT = 48081

export const DEV_PACKAGE_PATH = "/tmp/hinacode-dev.tgz"

const unit = (devPackage: boolean) => `[Unit]
Description=HinaCode cloud
After=network-online.target
Wants=network-online.target

[Service]
User=user
WorkingDirectory=/home/user
${devPackage ? "Environment=HINACODE_SERVE_AUTO_UPDATE=0\n" : ""}ExecStart=/bin/bash -lc "exec hinacode serve --host 127.0.0.1 --port ${MACHINE_PORT}"
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`

const install = (devPackage: boolean) =>
  devPackage
    ? `npm install -g ${DEV_PACKAGE_PATH} --allow-scripts=node-pty >&2
restart=1`
    : `if ! command -v hinacode >/dev/null; then
  npm install -g hinacode --allow-scripts=node-pty >&2
fi
restart=0`

export const machineScript = (devPackage: boolean) => `set -eu
${install(devPackage)}
sudo tee /etc/systemd/system/hinacode.service >/dev/null <<'UNIT'
${unit(devPackage)}UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now hinacode >&2
if [ "$restart" = 1 ]; then sudo systemctl restart hinacode >&2; fi
for attempt in $(seq 1 60); do
  if ss -Hltn "sport = :${MACHINE_PORT}" | grep -q "127.0.0.1:${MACHINE_PORT}" && pairing=$(hinacode pair 2>/dev/null); then
    printf '%s\\n' "$pairing"
    exit 0
  fi
  sleep 1
done
echo "hinacode serve did not start" >&2
sudo journalctl -u hinacode -n 20 --no-pager >&2
exit 1
`
