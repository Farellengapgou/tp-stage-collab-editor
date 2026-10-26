# Rapport de tests — Collab Editor
**Date de campagne :** 26 octobre 2026  

**Environnement testé :** CloudFront `https://dlnopdrpomzao.cloudfront.net/` ; requêtes API effectuées par la même adresse publique.  

## 1. Objectifs
Les deux propriétés prioritaires du sujet sont :

1. un lien limité à `N` téléchargements ne livre jamais plus de `N` PDF, y compris sous concurrence ;

2. les opérations d’écriture acceptées convergent et ne sont pas perdues lorsque plusieurs rédacteurs modifient le même document.

Les scénarios portent aussi sur la persistance après rechargement et les réponses HTTP des téléchargements.

## 2. Méthode
### Données isolées
Les rédacteurs et documents créés pour les scénarios de concurrence ont été préfixés `E2E-CONCURRENCY`. Aucun lien existant n’a été réutilisé.

### Critère d’un PDF livré
Une réponse est comptée comme une livraison seulement si les trois conditions suivantes sont vraies :

- statut HTTP `200` ;

- en-tête `Content-Type` contenant `application/pdf` ;

- corps non vide commençant par la signature `%PDF-`.

Une réponse JSON, y compris si elle arrive vite, n’est jamais comptée comme une livraison.

### Téléchargements concurrents
Pour chaque campagne, un rédacteur crée un document et une publication de quota 10 par l’interface publique. Vingt `POST /api/downloads/:token` indépendants sont ensuite libérés derrière une barrière commune, chacun avec une clé d’idempotence UUID différente. Les requêtes passent par l’URL CloudFront publique ; aucun appel direct à Elastic Beanstalk n’est effectué.

### Écriture collaborative
Les scénarios utilisent de vrais contextes Chromium indépendants, des cookies de session distincts et le WebSocket ShareDB exposé par l’application. Les marqueurs de texte sont choisis pour être uniques ; ils permettent de constater une opération conservée ou perdue sans se limiter à comparer deux textes visuellement proches.

## 3. Résultats : intégrité du quota
### Campagne 1 — 20 requêtes, quota 10
Fenêtre de départ : `04:37:30.794` à `04:37:30.820` UTC.

| # | HTTP | Type | Taille | Durée | Résultat |

| ---: | ---: | --- | ---: | ---: | --- |

| 1 | 200 | application/pdf | 11 149 o | 2 886 ms | PDF valide |

| 2 | 200 | application/pdf | 11 149 o | 2 833 ms | PDF valide |

| 3 | 409 | application/json | 36 o | 2 811 ms | Refus temporaire, sans PDF |

| 4 | 200 | application/pdf | 11 149 o | 2 883 ms | PDF valide |

| 5 | 409 | application/json | 36 o | 2 844 ms | Refus temporaire, sans PDF |

| 6 | 409 | application/json | 36 o | 2 834 ms | Refus temporaire, sans PDF |

| 7 | 200 | application/pdf | 11 149 o | 2 691 ms | PDF valide |

| 8 | 409 | application/json | 36 o | 2 816 ms | Refus temporaire, sans PDF |

| 9 | 409 | application/json | 36 o | 2 826 ms | Refus temporaire, sans PDF |

| 10 | 200 | application/pdf | 11 149 o | 2 646 ms | PDF valide |

| 11 | 409 | application/json | 36 o | 2 829 ms | Refus temporaire, sans PDF |

| 12 | 200 | application/pdf | 11 149 o | 2 869 ms | PDF valide |

| 13 | 200 | application/pdf | 11 149 o | 2 577 ms | PDF valide |

| 14 | 200 | application/pdf | 11 149 o | 2 872 ms | PDF valide |

| 15 | 200 | application/pdf | 11 149 o | 2 576 ms | PDF valide |

| 16 | 409 | application/json | 36 o | 2 807 ms | Refus temporaire, sans PDF |

| 17 | 200 | application/pdf | 11 149 o | 2 847 ms | PDF valide |

| 18 | 409 | application/json | 36 o | 2 841 ms | Refus temporaire, sans PDF |

| 19 | 409 | application/json | 36 o | 2 833 ms | Refus temporaire, sans PDF |

| 20 | 409 | application/json | 36 o | 2 830 ms | Refus temporaire, sans PDF |

Résultat : 10 PDF valides, 10 refus sans PDF, 0 erreur technique, 0 timeout. La page publique relue dans Chromium indiquait `10/10 téléchargements consommés` et le bouton désactivé.

### Répétitions
| Campagne | Fenêtre UTC | PDF valides | Refus 409 sans PDF | Erreurs / timeout | Taille PDF | État public final | Verdict |

| --- | --- | ---: | ---: | ---: | --- | --- | --- |

| 1 | 04:37:30.794–04:37:30.820 | 10 | 10 | 0 | 11 149 o | 10/10, bouton désactivé | PASS |

| 2 | 04:46:18.666–04:46:18.698 | 10 | 10 | 0 | 11 176 o | 10/10, bouton désactivé | PASS |

| 3 | 04:46:27.901–04:46:27.928 | 10 | 10 | 0 | 10 847 o | 10/10, bouton désactivé | PASS |

Sur les trois liens neufs, les seules réponses observées sont des PDF valides ou des JSON `409` sans signature PDF. Aucun onzième PDF n’a été reçu.

### Après épuisement
Une requête unique, effectuée après épuisement de la première campagne, a retourné :

```text

HTTP 410

Content-Type: application/json; charset=utf-8

Corps : {"status":"exhausted"}

Taille : 22 octets

Signature PDF : absente

```

****Comportement des réservations :**** `reserveDownload()` renvoie `410` quand `consumed_downloads >= max_downloads`; il renvoie `409` quand `consumed_downloads + active_reservations >= max_downloads`. La route HTTP traduit ces états respectivement par `exhausted` et `temporarily_unavailable`.

****Verdict intégrité du quota : PASS.**** Les trois campagnes donnent exactement 10 livraisons pour un quota de 10. Les `409` sont des réservations temporaires concurrentes, non des téléchargements supplémentaires.

## 4. Résultats : collaboration concurrente et durabilité
### Deux rédacteurs
- deux insertions simultanées à des positions différentes ;

- deux insertions simultanées au même emplacement ;

- une insertion au début et la suppression concurrente du marqueur `DELETE-ME` ;

- deux séquences rapides supplémentaires.

Tous les marqueurs d’insertion sont présents dans les deux éditeurs, `DELETE-ME` est absent, et les deux contextes atteignent la même révision : départ `[1, 1]`, arrivée `[16, 16]`. Après rechargement des deux pages, le contenu reste identique (longueur 292).

### Cinq rédacteurs
Cinq contextes Chromium authentifiés ont inséré simultanément les marqueurs `FIVE-1` à `FIVE-5` dans le même document. Les cinq marqueurs sont présents dans chaque éditeur. Les révisions passent de `[1, 1, 1, 1, 1]` à `[11, 11, 11, 11, 11]`. Après rechargement, le contenu reste identique dans les cinq contextes (longueur 177).

****Verdict convergence collaborative : PASS.**** Aucune opération acceptée par les scénarios n’a été perdue.

****Verdict durabilité : PASS.**** L’état convergent a été retrouvé après rechargement des navigateurs.

## 5. Crédit quotidien multi-session
Deux sessions distinctes de la même identité ont ouvert le même document, effectué une insertion courte chacune, puis rechargé le document. Les deux insertions ont convergé et persisté (longueur finale 72).

Les deux sessions partagent la même identité et leurs modifications persistent. Le plafond quotidien de 10 000 caractères n’a pas été atteint pendant cet essai.

****Verdict sessions et persistance : PASS.****  

****Plafond quotidien partagé de 10 000 caractères : NON TESTÉ.****

## 6. Tests automatisés du dépôt
En plus de la campagne AWS, le dépôt contient les suites suivantes. Elles utilisent Node.js `node:test`; les suites d’intégration écrivent des données aléatoires et doivent donc être exécutées sur une base PostgreSQL isolée.

| Fichier | Type | Vérifications principales |

| --- | --- | --- |

| `apps/api/tests/unit/app.test.ts` | Unitaire | Réponse `200` de `GET /health`. |

| `apps/api/tests/integration/api.integration.test.ts` | Intégration API + PostgreSQL | Création/réutilisation d’identité, cookie de session haché, création et accès aux documents, validation et erreurs HTTP. |

| `apps/api/tests/integration/collaboration.integration.test.ts` | Intégration ShareDB + PostgreSQL | OT concurrent, Unicode, débit quotidien atomique, dépassement de crédit, multi-instance et retransmission idempotente. |

| `apps/api/tests/integration/collaboration.websocket.integration.test.ts` | Intégration WebSocket | Authentification par cookie, opérations ShareDB réelles, refus d’accès non autorisé et persistance. |

| `apps/api/tests/integration/collaboration.redis.integration.test.ts` | Intégration Redis + deux backends | Pub/Sub ShareDB, propagation bidirectionnelle, rattrapage après reconnexion, présence et curseurs. Cette suite utilise `REDIS_URL`. |

| `apps/api/tests/integration/document-history.integration.test.ts` | Intégration PostgreSQL + ShareDB | Révision initiale, reconstruction, historique, restauration, permissions et conflit de restauration. |

| `apps/api/tests/integration/download-reservations.integration.test.ts` | Intégration PostgreSQL | Réservations, TTL PostgreSQL, expiration, confirmation, idempotence et concurrence de 50 tentatives pour une place. |

| `apps/api/tests/integration/pdf.integration.test.ts` | Intégration PostgreSQL + PDFKit | Reconstruction d’une révision, Unicode, PDF valide, immutabilité d’une ancienne révision et réutilisation d’artefact. |

| `apps/api/tests/integration/pdf-delivery.integration.test.ts` | Intégration API + PostgreSQL + stockage simulé | Livraison PDF, quota 3 puis refus, libération après échec de lecture, idempotence et document N puis N+1 avec le même lien. |

La commande est :

```sh

npm test

```

Elle requiert `DATABASE_URL` vers une base de test ayant reçu les migrations. Les tests Redis multi-instance exigent aussi `REDIS_URL`. Les tests PDF remplacent S3 par un stockage mémoire : ils valident le protocole de l’application sans appel AWS réel.

Pendant la présente préparation documentaire, cette suite n’a pas été relancée sur la base applicative locale afin de ne pas y injecter de données de test. Les résultats ****PASS**** de ce rapport restent donc ceux des campagnes AWS réellement exécutées décrites aux sections 3 à 5. La prochaine exécution doit créer ou réutiliser une base dédiée, par exemple `collab_editor_test`, puis appliquer les migrations avant `npm test`.

**Présence et curseur distant — FAIL :** lors du scénario Playwright, le marqueur attendu n’est pas apparu dans l’éditeur du propriétaire après la saisie du collaborateur, dans le délai imparti. Les tests de convergence du texte et de persistance sont distincts de ce scénario.

## 7. Limites de la campagne
- Aucun test de charge à 15 000 visiteurs ou 300 rédacteurs n’a été réalisé.

- Les résultats de concurrence de téléchargement portent sur 20 requêtes simultanées, répétées trois fois.

- Le plafond quotidien partagé n’a pas été épuisé sur AWS ; les deux sessions ont uniquement validé la synchronisation et la persistance.

- L’envoi de l’e-mail de dernier téléchargement, le blocage après tentatives répétées et le tableau de supervision ne sont pas implémentés.

## 8. Synthèse
| Contrainte | Verdict | Preuve |

| --- | --- | --- |

| Intégrité du quota | ****PASS**** | Trois campagnes : exactement 10 PDF pour un quota de 10 ; aucun onzième PDF. |

| Sémantique HTTP | ****PASS**** | `409` pour réservation temporaire ; `410 exhausted` observé après consommation. |

| Convergence collaborative | ****PASS**** | Deux puis cinq rédacteurs ; marqueurs simultanés conservés. |

| Durabilité des opérations | ****PASS**** | Même contenu et même révision après rechargement. |

| Crédit quotidien partagé | ****BLOCKED**** | Pas de mesure AWS du plafond 10 000, volontairement non épuisé. |

| Charge cible 15 000 / 300 | ****NON TESTÉ**** | Hors périmètre de cette campagne. |
