#!/usr/bin/env bash
set -euo pipefail

if [ -f /var/app/staging/apps/api/dist/scripts/migrate.js ]; then
  cd /var/app/staging
fi

node apps/api/dist/scripts/migrate.js
