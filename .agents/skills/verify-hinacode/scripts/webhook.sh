#!/usr/bin/env bash
# Usage: webhook.sh <webhook-url> <secret> '<json body>' [delivery-id]
# POSTs the body signed the way hinacode checks it (X-HINACODE-Signature: sha256=<hmac of raw body>).
# The delivery id becomes the dedup key; without one hinacode dedups on the body hash.
# Prints the response body, then the HTTP status on its own line.
set -euo pipefail
url=${1:?webhook url from automations.webhookUrl}
secret=${2:?secret from automations.create}
body=${3:?json body}
delivery=${4:-}
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)
args=(-sS -X POST -H 'content-type: application/json' -H "x-hinacode-signature: sha256=$sig" --data-binary "$body" -w '\n%{http_code}\n')
[[ -n "$delivery" ]] && args+=(-H "x-github-delivery: $delivery")
curl "${args[@]}" "$url"
