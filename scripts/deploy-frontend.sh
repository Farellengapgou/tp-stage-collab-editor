#!/usr/bin/env bash
set -euo pipefail

bucket="${FRONTEND_BUCKET:-collab-editor-frontend-455592559083}"
distribution_id="${CLOUDFRONT_DISTRIBUTION_ID:?CLOUDFRONT_DISTRIBUTION_ID is required}"

npm run build -w @collab/web
aws s3 sync apps/web/dist/ "s3://${bucket}/" --delete --cache-control "public, max-age=31536000, immutable" --exclude "index.html"
aws s3 cp apps/web/dist/index.html "s3://${bucket}/index.html" --cache-control "no-cache, no-store, must-revalidate" --content-type "text/html; charset=utf-8"
aws cloudfront create-invalidation --distribution-id "${distribution_id}" --paths "/*"
