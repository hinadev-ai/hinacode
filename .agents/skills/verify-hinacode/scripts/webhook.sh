#!/usr/bin/env bash
# Usage: webhook.sh <webhook-url> <secret> '<json body>' [idempotency-key] [--hmac]
# POSTs the body with `Authorization: Bearer <secret>`, or with --hmac signed as X-Hub-Signature-256: sha256=<hmac of raw body>.
# The idempotency key makes a retry start nothing; without one every call starts a thread.
# Prints the response body, then the HTTP status on its own line.
set -euo pipefail
url=${1:?webhook url from routines.webhook}
secret=${2:?secret from routines.rotateWebhookSecret}
body=${3:?json body}
key=${4:-}
args=(-sS -X POST -H 'content-type: application/json' --data-binary "$body" -w '\n%{http_code}\n')
if [[ "${5:-}" == "--hmac" ]]; then
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)
  args+=(-H "x-hub-signature-256: sha256=$sig")
else
  args+=(-H "authorization: Bearer $secret")
fi
[[ -n "$key" ]] && args+=(-H "idempotency-key: $key")
curl "${args[@]}" "$url"
