#!/usr/bin/env bash
# Usage: webhook.sh <webhook-url> <secret> '<json body>' [idempotency-key] [--hmac]
# POSTs the body with `Authorization: Bearer <secret>`, or with --hmac signed as X-Hub-Signature-256: sha256=<hmac of raw body>.
# The idempotency key makes a retry start nothing; without one every call starts a thread.
# GITHUB_EVENT=issue_comment adds the X-GitHub-Event header that /hooks/github reads.
# LINEAR_EVENT=Comment signs the body for /hooks/linear instead: Linear-Signature: <hex hmac of raw body>, plus Linear-Event.
# Prints the response body, then the HTTP status on its own line.
set -euo pipefail
url=${1:?webhook url from routines.webhook}
secret=${2:?secret from routines.rotateWebhookSecret}
body=${3:?json body}
key=${4:-}
args=(-sS -X POST -H 'content-type: application/json' --data-binary "$body" -w '\n%{http_code}\n')
hmac() { printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1; }
if [[ -n "${LINEAR_EVENT:-}" ]]; then
  args+=(-H "linear-signature: $(hmac)" -H "linear-event: $LINEAR_EVENT")
elif [[ "${5:-}" == "--hmac" ]]; then
  args+=(-H "x-hub-signature-256: sha256=$(hmac)")
else
  args+=(-H "authorization: Bearer $secret")
fi
[[ -n "$key" ]] && args+=(-H "idempotency-key: $key")
[[ -n "${GITHUB_EVENT:-}" ]] && args+=(-H "x-github-event: $GITHUB_EVENT")
curl "${args[@]}" "$url"
