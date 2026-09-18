#!/bin/zsh

set -euo pipefail

readonly repositories=(
  "Causodes/causodes-shipcombat-core"
  "Causodes/causodes-shipcombat-dnd5e"
  "Causodes/causodes-shipcombat-sf2e"
  "Causodes/causodes-shipcombat-impmal"
)

if ! command -v gh >/dev/null 2>&1; then
  print -u2 "GitHub CLI is required: https://cli.github.com/"
  exit 1
fi
gh auth status --hostname github.com >/dev/null

set_secret() {
  local name="$1"
  local optional="${2:-false}"
  local prompt_suffix=""
  local value

  [[ "$optional" == "true" ]] && prompt_suffix=" (optional; Return to skip)"
  read -r -s "value?Enter ${name}${prompt_suffix}: "
  print
  if [[ -z "$value" ]]; then
    if [[ "$optional" == "true" ]]; then
      print "Skipping ${name}."
      return
    fi
    print -u2 "${name} cannot be empty."
    exit 1
  fi

  for repository in "${repositories[@]}"; do
    print -rn -- "$value" | gh secret set "$name" --repo "$repository"
    print "Configured ${name} for ${repository}."
  done
  unset value
}

set_secret "FOUNDRY_USERNAME"
set_secret "FOUNDRY_PASSWORD"
set_secret "FOUNDRY_LICENSE_KEY"
set_secret "FOUNDRY_ADMIN_KEY" true

print "Foundry integration secrets are configured. Values were not written to disk or command arguments."
