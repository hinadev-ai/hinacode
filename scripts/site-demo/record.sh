#!/bin/zsh
set -e
ab() { agent-browser --session site-demo "$@"; }
ref() { ab snapshot -i 2>/dev/null | grep "$1" | head -1 | grep -o 'ref=e[0-9]*' | cut -d= -f2; }
open_thread() { ab click @$(ref "link \"$1\"") >/dev/null; sleep 2.5; }
LIVE=$1; TOKEN=$2; FLAKY=$3; OUT=$4
[[ -n $OUT ]] || { echo "Usage: record.sh <host:port> <token> <flaky-login thread id> <out.json>"; exit 1 }
ab open "http://localhost:4419/app/" >/dev/null
ab eval "localStorage.clear(); localStorage.setItem('hinacode.location','/thread/$FLAKY'); 1" >/dev/null
ab open "http://localhost:4419/app/?live=$LIVE&token=$TOKEN" >/dev/null
sleep 5
for t in "Upgrade to Vite 8" "Translate settings to Japanese" "Render HTML in PR discussion" "Add a CSV export to reports" "Fix the flaky login test"; do open_thread "$t"; done
ab find role tab click --name "Changes" --exact >/dev/null; sleep 2.5
ab find role tab click --name "Details" --exact >/dev/null; sleep 1
open_thread "Rebuild the site around a working demo"
ab find role tab click --name "Pull requests" --exact >/dev/null; sleep 5
ab find role tab click --name "Details" --exact >/dev/null; sleep 1
open_thread "Add a CSV export to reports"
ab fill @$(ref 'combobox "Message"') "Add a CSV export to the reports endpoint." >/dev/null; ab press Enter >/dev/null; sleep 3
open_thread "Fix the flaky login test"
ab fill @$(ref 'combobox "Message"') "The login e2e test fails about one run in five on CI. Find out why and fix it." >/dev/null; ab press Enter >/dev/null
sleep 12
ab find role button click --name "Allow" --exact >/dev/null; sleep 6
ab click @$(ref 'radio "Ready for review') >/dev/null; sleep 0.5
ab find role button click --name "Submit" --exact >/dev/null; sleep 9
ab eval 'JSON.stringify(window.hinacodeRecording())' > $OUT
echo "saved $OUT"
