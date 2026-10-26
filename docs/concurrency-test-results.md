# Tests de concurrence AWS

## Portée

Exécution réelle le 26 octobre 2026 contre `https://dlnopdrpomzao.cloudfront.net/`. Les données créées sont isolées et préfixées `E2E-CONCURRENCY`. Aucun appel n’a ciblé directement Elastic Beanstalk.

## Test 1 — 20 téléchargements simultanés, quota 10

### Protocole

1. Chromium a créé un rédacteur, un document et une publication neufs via l’interface CloudFront.
2. La publication a reçu un quota de 10.
3. Vingt `POST /api/downloads/:token`, chacun avec une clé d’idempotence UUID distincte, ont été libérés derrière une barrière commune. Les départs sont répartis sur 26 ms.
4. Une livraison est comptée uniquement si le statut est 200, le type contient `application/pdf` et les octets commencent par `%PDF-`.
5. La page publique a ensuite été relue dans Chromium : elle affiche `10/10 téléchargements consommés` et le bouton `Quota atteint` désactivé.

Parcours public : `/#/journal/[token E2E non reproduit dans ce rapport]`.

### Résultats bruts

| # | Départ UTC | HTTP | Type | Taille | Durée | Résultat |
| ---: | --- | ---: | --- | ---: | ---: | --- |
| 1 | 04:37:30.794 | 200 | application/pdf | 11 149 | 2 886 ms | PDF valide |
| 2 | 04:37:30.814 | 200 | application/pdf | 11 149 | 2 833 ms | PDF valide |
| 3 | 04:37:30.814 | 409 | application/json | 36 | 2 811 ms | temporairement indisponible |
| 4 | 04:37:30.815 | 200 | application/pdf | 11 149 | 2 883 ms | PDF valide |
| 5 | 04:37:30.815 | 409 | application/json | 36 | 2 844 ms | temporairement indisponible |
| 6 | 04:37:30.815 | 409 | application/json | 36 | 2 834 ms | temporairement indisponible |
| 7 | 04:37:30.816 | 200 | application/pdf | 11 149 | 2 691 ms | PDF valide |
| 8 | 04:37:30.816 | 409 | application/json | 36 | 2 816 ms | temporairement indisponible |
| 9 | 04:37:30.816 | 409 | application/json | 36 | 2 826 ms | temporairement indisponible |
| 10 | 04:37:30.817 | 200 | application/pdf | 11 149 | 2 646 ms | PDF valide |
| 11 | 04:37:30.817 | 409 | application/json | 36 | 2 829 ms | temporairement indisponible |
| 12 | 04:37:30.817 | 200 | application/pdf | 11 149 | 2 869 ms | PDF valide |
| 13 | 04:37:30.818 | 200 | application/pdf | 11 149 | 2 577 ms | PDF valide |
| 14 | 04:37:30.818 | 200 | application/pdf | 11 149 | 2 872 ms | PDF valide |
| 15 | 04:37:30.818 | 200 | application/pdf | 11 149 | 2 576 ms | PDF valide |
| 16 | 04:37:30.819 | 409 | application/json | 36 | 2 807 ms | temporairement indisponible |
| 17 | 04:37:30.819 | 200 | application/pdf | 11 149 | 2 847 ms | PDF valide |
| 18 | 04:37:30.819 | 409 | application/json | 36 | 2 841 ms | temporairement indisponible |
| 19 | 04:37:30.819 | 409 | application/json | 36 | 2 833 ms | temporairement indisponible |
| 20 | 04:37:30.820 | 409 | application/json | 36 | 2 830 ms | temporairement indisponible |

### Assertions et verdict

- 10 PDF valides reçus : **PASS**.
- Aucun onzième PDF : **PASS**.
- 10 réponses non PDF : **PASS**.
- Erreur technique ou timeout : **0**, **PASS**.
- État final public : quota totalement consommé, **PASS**.
- Les dix refus concurrents `409 temporarily_unavailable` : **PASS**. Ils correspondent aux places temporairement réservées, pas à un quota déjà consommé.
- Une unique requête post-épuisement : `410 application/json`, `{"status":"exhausted"}`, 22 octets, aucune signature PDF : **PASS**.

Verdict du test 1 : **PASS**. Aucun dépassement de l’invariant « jamais plus de N PDF ».

### Preuves

- Script reproductible : `scripts/e2e-concurrency-downloads.mjs`.
- Résultat brut local temporaire : `/private/tmp/e2e-concurrency-downloads.json`.
- Vérification Chromium finale : `public_ui_quota=exhausted`.

## Répétitions du quota — 20 requêtes, quota 10

| Campagne | Fenêtre de départ UTC | PDF valides | Refus 409 sans PDF | Erreurs / timeout | Taille PDF | État final Chromium | Verdict |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 1 | 04:37:30.794–04:37:30.820 | 10 | 10 | 0 | 11 149 octets | 10/10, bouton désactivé | PASS |
| 2 | 04:46:18.666–04:46:18.698 | 10 | 10 | 0 | 11 176 octets | 10/10, bouton désactivé | PASS |
| 3 | 04:46:27.901–04:46:27.928 | 10 | 10 | 0 | 10 847 octets | 10/10, bouton désactivé | PASS |

Les trois campagnes ont reçu uniquement des réponses `200 application/pdf` avec signature `%PDF-` ou des réponses `409 application/json` de 36 octets avec `status: temporarily_unavailable`. Aucun refus n’a contenu un PDF.

Les résultats bruts complets sont conservés localement, hors Git :

- `test-results/concurrency/downloads-run-1.json`
- `test-results/concurrency/downloads-run-2.json`
- `test-results/concurrency/downloads-run-3.json`

## Sémantique HTTP vérifiée en lecture seule

`reserveDownload()` retourne `410 Download quota exhausted.` lorsque `consumed_downloads >= max_downloads`. Il retourne `409 Download availability is temporarily reserved.` lorsque `consumed_downloads + active_reservations >= max_downloads`. La route traduit ces erreurs en `{status:"exhausted"}` et `{status:"temporarily_unavailable"}` respectivement.

La requête réelle post-épuisement confirme ce comportement : `410`, JSON `exhausted`, zéro PDF.

## Test 2 — Concurrence éditoriale ShareDB

### Deux rédacteurs

- Deux insertions simultanées à des positions différentes : convergentes.
- Deux insertions simultanées au même emplacement : les deux marqueurs sont conservés.
- Insertion au début et suppression concurrente de `DELETE-ME` : insertion conservée, suppression conservée.
- Deux séquences rapides supplémentaires : les quatre marqueurs sont conservés.
- Révisions observées : `[1, 1]` au départ, `[16, 16]` à la fin.
- Après rechargement : contenus identiques, longueur 292 dans les deux contextes.

Verdict convergence : **PASS**. Verdict durabilité : **PASS**.

### Cinq rédacteurs

- Cinq insertions déclenchées simultanément via cinq contextes Playwright authentifiés.
- Les cinq marqueurs `FIVE-1` à `FIVE-5` sont présents dans chaque éditeur.
- Révisions observées : `[1, 1, 1, 1, 1]` au départ, `[11, 11, 11, 11, 11]` à la fin.
- Après rechargement : contenus identiques, longueur 177 dans les cinq contextes.

Verdict convergence : **PASS**. Verdict durabilité : **PASS**.

Résultat brut : `test-results/concurrency/collaboration.json`.

## Test 3 — Crédit quotidien multi-session

Deux sessions indépendantes de la même identité E2E ont créé, modifié puis rechargé le même document. Les deux insertions courtes ont convergé et ont persisté (longueur finale 72).

Verdict partage de session et durabilité : **PASS**.

Verdict du crédit quotidien de 10 000 caractères : **BLOCKED**. L’interface ne rend pas le solde disponible, et vérifier le plafond ou son débit inter-session exigerait une consommation presque irréversible du quota quotidien. Aucun essai à la limite ni blocage anti-abus n’a été provoqué.

Résultat brut : `test-results/concurrency/credit-multisession.json`.

## Verdicts des contraintes

| Contrainte | Verdict | Preuve |
| --- | --- | --- |
| Intégrité quota | **PASS** | Trois campagnes : exactement 10 PDF pour quota 10, aucun onzième PDF. |
| Sémantique HTTP | **PASS** | `409` pour réservation temporaire ; `410 exhausted` constaté après consommation. |
| Convergence collaborative | **PASS** | Deux et cinq rédacteurs, marqueurs simultanés tous conservés. |
| Durabilité des opérations | **PASS** | Même contenu et même révision après rechargement. |
| Crédit quotidien multi-session | **BLOCKED** | Solde non visible ; plafond non consommé volontairement. |

