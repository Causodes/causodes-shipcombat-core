#!/bin/zsh

set -euo pipefail

readonly repository="Causodes/causodes-shipcombat-core"
local_token=""

if ! command -v gh >/dev/null 2>&1; then
  print -u2 "GitHub CLI is required: https://cli.github.com/"
  exit 1
fi
gh auth status --hostname github.com >/dev/null

print "Create a fine-grained token with Contents and Pull requests read/write access"
print "to the four Causodes ship-combat repositories."
read -r -s "local_token?Enter the compatibility bot token: "
print
if [[ -z "$local_token" ]]; then
  print -u2 "The token cannot be empty."
  exit 1
fi

print -rn -- "$local_token" | gh secret set COMPATIBILITY_BOT_TOKEN --repo "$repository"
unset local_token
print "Configured COMPATIBILITY_BOT_TOKEN for ${repository}. The value was not written to disk or a command argument."
