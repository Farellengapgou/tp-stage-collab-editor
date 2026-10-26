# Tests E2E Playwright

Les tests utilisent l’application réellement déployée et ne simulent aucune API métier.

```bash
npm exec playwright install chromium
E2E_BASE_URL=https://dlnopdrpomzao.cloudfront.net npm run test:e2e
```

Les données créées sont préfixées `E2E` et utilisent des adresses `example.test`. La suite est séquentielle (`workers: 1`) et n’effectue aucun nettoyage global.

Les rapports sont générés dans `playwright-report/` et `test-results/`, deux dossiers ignorés par Git.
