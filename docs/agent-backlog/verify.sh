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

echo
echo "T1  contact email (blocked on owner)"
n=$(grep -rlF 'negotiationsondemand@gmail.com' \
      --include='*.html' --include='*.js' --include='*.txt' . 2>/dev/null | wc -l)
if [ "$n" -gt 0 ]; then
  note "still publishing negotiationsondemand@gmail.com in $n file(s) — awaiting owner" "BLOCKED"
else
  pass "no unconfirmed address remains"
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
