#!/usr/bin/env bash
# Verifies every task in TASKS.md in a single pass.
#
# This exists so the implementing agent can confirm its work with one Bash call
# instead of re-reading six HTML files. Run it from the repo root after each
# batch. It is read-only and idempotent.
#
#   ./docs/agent-backlog/verify.sh
#
# Exit 0 = every implementable task passed. Exit 1 = at least one FAIL.
# T1 reporting BLOCKED is expected and does not affect the exit code.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PAGES=(index.html system.html speaking.html academy.html about.html contact.html)
fails=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '  \033[33m%s\033[0m  %s\n' "$2" "$1"; }

# check <label> <file> <pattern>   — pattern must be present
has() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then pass "$1"; else fail "$1"; fi
}
# lacks <label> <file> <pattern>   — pattern must be gone
lacks() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then fail "$1"; else pass "$1"; fi
}

echo "T1  contact email (fixed — regression guard)"
# Counts cover what the site publishes, so the test suites are excluded: a
# spec asserting on the address is not a page a visitor can read, and counting
# them made this guard fail on the very commit that fixed the specs.
# practice-lab/ is excluded because it is a staged package for
# negotiatorsondemand.com, not a route on this site — see its README.
SCAN_EXCLUDES=(--exclude-dir=test --exclude-dir=e2e --exclude-dir=practice-lab
               --exclude-dir=node_modules --exclude-dir=.git)

n=$(grep -roF 'negotiationsondemand@gmail.com' \
      --include='*.html' --include='*.js' --include='*.txt' \
      "${SCAN_EXCLUDES[@]}" . 2>/dev/null | wc -l)
if [ "$n" -eq 0 ]; then
  pass "old address gone"
else
  fail "old address is back in $n place(s)"
fi
# 11 = the original 10, plus the 504 timeout message added when the lead path
# was hardened. (Briefly 13, when contact.html routed to email while the booking
# link was dead; those reverted once a real Calendly event existed.)
# Bump this deliberately if a new user-facing route is added.
#
# 14 = the 11 above, plus 3 in guide/assessment/state-check.html (two runtime
# fallback strings and the deployment note). Added 2026-08-04 when the Six
# Before Yes assessment landed carrying the WRONG spelling, with a comment
# asserting it was "confirmed correct, not a typo" -- it was not, and Dan
# confirmed he does not read that inbox. guide/ is deliberately NOT added to
# SCAN_EXCLUDES: unlike practice-lab/, it has no README staging it to another
# repo and it deploys to either domain, so it stays under this guard. An
# unwatched guide is precisely where this bug lived.
#
# Counts shipped files only. test/ and e2e/ also assert this address -- that is
# the suite doing its job, not a site occurrence, and folding them in here would
# make the number move whenever coverage changes.
n=$(grep -roF 'negotiatorsondemand@gmail.com' \
      --include='*.html' --include='*.js' --include='*.txt' \
      "${SCAN_EXCLUDES[@]}" . 2>/dev/null | wc -l)
if [ "$n" -eq 14 ]; then
  pass "correct address in all 14 places"
else
  fail "expected 14 occurrences of the correct address, found $n"
fi

echo
echo "Booking links (regression guard)"
# Verify a slug against the Calendly API, never by HTTP status: calendly.com
# returns 200 with an empty client-rendered shell for a slug that is deactivated
# or absent, so a status-code probe reports those as healthy when they are not.
# Check for real <meta name="description"> content, or read active:true from the
# API. State when this list was last confirmed:
#
#   corporate-training-call  ACTIVE, 15min, free   created 2026-08-03
#   virtualcoffeewithdan     ACTIVE, 60min, paid   the $1,500 Negotiator Hour
#                                                  (repriced from $500 on
#                                                  2026-08-03; the Calendly
#                                                  charge amount is not exposed
#                                                  by their API, so it can only
#                                                  be confirmed in the UI)
#   30min / 60min            INACTIVE              (200, empty shell)
#   corporate-training       never existed         (404)
#   15min                    never existed         (200, empty shell)
#
# Allowlist, not a denylist: extract every Calendly slug the site references and
# assert each one is a confirmed-active event. A denylist missed that
# "corporate-training-call" contains "corporate-training" as a substring.
ACTIVE="corporate-training-call virtualcoffeewithdan"
used=$(grep -rhoE 'calendly\.com/negotiatorsondemand/[a-z0-9-]+' \
         --include='*.html' --include='*.txt' "${SCAN_EXCLUDES[@]}" . 2>/dev/null \
       | sed 's|.*/||' | sort -u)
bad=""
for slug in $used; do
  case " $ACTIVE " in
    *" $slug "*) ;;
    *) bad="$bad $slug" ;;
  esac
done
if [ -z "$bad" ]; then
  pass "every Calendly slug used is active ($(echo "$used" | tr '\n' ' '))"
else
  fail "links to non-bookable slug(s):$bad"
fi

echo
echo "Batch 1 — defects"
if [ -e nod-coin.png ]; then fail "T2  nod-coin.png deleted"; else pass "T2  nod-coin.png deleted"; fi
# The two in-use sizes must survive the delete.
if [ -f nod-coin-176.png ] && [ -f nod-coin-64.png ]; then
  pass "T2  in-use coin sizes intact"
else
  fail "T2  in-use coin sizes intact"
fi
has   "T3  ad honours prefers-reduced-motion" index.html '.mm-adlivedot,.mm-adtab.listen{animation:none}'
has   "T4  rotator bails on reduced-motion"   index.html "if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;"
has   "T4  rotator skips hidden tab"          index.html 'if (document.hidden) return;'
has   "T4  rotator skips off-screen"          index.html 'if (box.bottom < 0 || box.top > innerHeight) return;'
has   "T5  hero parallax clamped"             assets/site.js 'Math.min(scrollY, 600)'
has   "T5  skyline parallax clamped"          assets/site.js 'Math.min(scrollY, 900)'
lacks "T5  old hero cutoff removed"           assets/site.js 'if (y < 600)'
lacks "T5  old skyline cutoff removed"        assets/site.js 'if (y < 900)'

echo
echo "Batch 2 — structured data and head"
has "T6  contact.html FAQPage"   contact.html '"@type": "FAQPage"'
has "T7  system.html FAQPage"    system.html  '"@type": "FAQPage"'
has "T8  about.html ProfilePage" about.html   '"@type": "ProfilePage"'
has "T8  speaking.html Service"  speaking.html '"@type": "Service"'
has "T8  academy.html ItemList"  academy.html '"@type": "ItemList"'

for p in "${PAGES[@]}"; do
  has "T9  $p theme-color"      "$p" '<meta name="theme-color" content="#08080f">'
  has "T9  $p apple-touch-icon" "$p" '<link rel="apple-touch-icon" href="/nod-coin-176.png">'
  has "T9  $p calendly preconnect" "$p" '<link rel="preconnect" href="https://calendly.com">'
  has "T9  $p og:image:alt"     "$p" '<meta property="og:image:alt"'
done

echo
echo "Batch 3 — infra and polish"
has "T10 assets cache header" vercel.json '"source": "/assets/(.*)"'
has "T10 image cache header"  vercel.json 'max-age=604800'
if [ -f 404.html ]; then
  pass "T11 404.html exists"
  has   "T11 404 is noindex"          404.html '<meta name="robots" content="noindex">'
  lacks "T11 404 has no canonical"    404.html 'rel="canonical"'
  lacks "T11 404 kept out of sitemap" sitemap.xml '404'
else
  fail "T11 404.html exists"
fi
has "T12 Real Estate tile has icon" index.html '<div class="industry">🏠 Real Estate</div>'

echo
echo "Sanity — nothing broken in passing"
# Every inline JSON-LD block must be valid JSON, or the schema is worse than absent.
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import re, json, sys, glob
bad = []
for path in sorted(glob.glob('*.html')):
    src = open(path, encoding='utf-8').read()
    for i, block in enumerate(re.findall(
            r'<script type="application/ld\+json">(.*?)</script>', src, re.S)):
        try:
            json.loads(block)
        except json.JSONDecodeError as e:
            bad.append(f"{path} block {i + 1}: {e}")
print('  \033[31mFAIL\033[0m  JSON-LD parses' if bad else
      '  \033[32mPASS\033[0m  JSON-LD parses')
for b in bad:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
  [ $? -ne 0 ] && fails=$((fails + 1))
else
  note "python3 unavailable — JSON-LD not parsed" "SKIP"
fi

# Every local href must resolve to a file that exists.
missing=0
for p in "${PAGES[@]}" 404.html; do
  [ -f "$p" ] || continue
  while read -r href; do
    case "$href" in
      /|''|\#*|*@*) continue ;;
    esac
    target="${href%%\?*}"; target="${target%%\#*}"
    [ -f ".${target}.html" ] || [ -f ".${target}" ] || [ -d ".${target}" ] || {
      echo "        broken in $p: $href"; missing=$((missing + 1))
    }
  done < <(grep -o 'href="/[^"]*"' "$p" | sed 's/href="//;s/"$//' | sort -u)
done
[ "$missing" -eq 0 ] && pass "internal links resolve" || fail "internal links resolve"

echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n\n'
else
  printf '\033[31m%d check(s) failed.\033[0m\n\n' "$fails"
fi
exit $(( fails > 0 ))
