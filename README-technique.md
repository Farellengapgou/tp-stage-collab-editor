# Collab Editor — guide technique : où chaque responsabilité est gérée

Ce document complète le [README principal](README.md). Il ne décrit pas le parcours utilisateur : il indique où se trouve chaque mécanisme dans le code et quelle couche en est responsable.

## Vue d’ensemble

```text
apps/web
  React : écrans, appels HTTP, WebSocket ShareDB, affichage de présence
       │
       ├── /api/* → Fastify (apps/api/src/routes)
       └── /ws     → ShareDB (apps/api/src/services/collaboration.ts)
                         │
                         ├── PostgreSQL : vérité durable
                         ├── Redis : diffusion inter-instances
                         └── S3 : artefacts PDF privés
```

## 1. Frontend

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Point d’entrée React et navigation par hash | `apps/web/src/main.tsx` | Écrans de connexion, documents, édition, partage, historique, publication et Journal public. |
| Appels HTTP | `apps/web/src/api.ts` | Utilise `fetch` avec `credentials: "include"`; appelle les routes Fastify et transforme les erreurs HTTP en `ApiError`. |
| Édition collaborative | `apps/web/src/collaboration.ts` | Ouvre le WebSocket `/ws`, s’abonne au document ShareDB, calcule les opérations `ot-text-unicode`, gère reconnexion, synchronisation et état d’enregistrement. |
| Présence et curseurs | `apps/web/src/collaboration.ts`, `apps/web/src/main.tsx`, `apps/web/src/styles.css` | Envoie sélection et état de saisie ; affiche les avatars, indicateurs de saisie et curseurs distants. |
| Apparence responsive | `apps/web/src/styles.css` | Mise en page, modales, éditeur, cartes de documents, Journal et indicateurs de présence. |
| URL API et WebSocket | `apps/web/.env.example`, `apps/web/vite.config.ts` | En développement, Vite route `/api` et `/ws` vers Fastify. En production, ces chemins doivent être servis par la même origine publique. |

Le frontend n’est jamais l’autorité pour les permissions, les quotas, les crédits ou la révision livrée : il les affiche après validation côté serveur.

## 2. Démarrage Fastify et erreurs HTTP

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Démarrage HTTP | `apps/api/src/server.ts` | Crée l’application et écoute sur `0.0.0.0` avec `process.env.PORT`. |
| Assemblage de l’API | `apps/api/src/app.ts` | Enregistre `/health`, les routes, ShareDB et le gestionnaire d’erreurs commun. |
| Erreurs métier | `apps/api/src/services/errors.ts` | Représente une erreur attendue avec son code HTTP. |
| Validation des entrées | `apps/api/src/routes/validation.ts` | Vérifie corps JSON, UUID, texte, entier et champs autorisés. |
| Authentification légère | `apps/api/src/routes/auth.ts` | Lit le cookie `collab_session`, vérifie la session et crée le cookie sécurisé en production. |

Les erreurs métier sont envoyées sous la forme JSON `{ "error": "…" }`. Les erreurs imprévues sont journalisées par Fastify et renvoient `500 { "error": "Internal server error." }` sans détail interne.

## 3. Éditeurs et sessions

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Routes | `apps/api/src/routes/editors.ts` | `POST /editors`, `GET /editors/me`, recherche d’un rédacteur existant. |
| Service | `apps/api/src/services/editors.ts` | Normalise l’e-mail, retrouve ou crée l’éditeur, crée une session et stocke seulement le hash du jeton. |
| Tables | migrations `002_editors_access.sql`, `007_create_editor_sessions.sql` | `editors`, `editor_sessions`, unicité de l’e-mail normalisé et expiration des sessions. |

Le client ne peut pas définir `is_admin`. L’identification par e-mail reste volontairement légère : elle n’est pas une authentification forte.

## 4. Documents, accès et historique

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Routes documents | `apps/api/src/routes/documents.ts` | Création, liste, consultation, collaborateurs, historique et restauration. |
| Service documents | `apps/api/src/services/documents.ts` | Vérifie les rôles, crée le document et l’association propriétaire dans une transaction, reconstruit les révisions et applique une restauration. |
| Autorisations | table `document_editors` et service documents | La table d’association est la source de vérité : rôle `owner` ou `editor`. |
| État courant | table `document_states` | Contenu texte courant et révision durable. |
| Historique | table `edit_operations` | Opérations OT acceptées, auteur, révisions et coût Unicode. |
| Référence de version | table `document_versions` | Référence déterministe vers la reconstruction par opérations, sans dupliquer le texte. |

La migration `002_editors_access.sql` impose au plus un propriétaire par document grâce à un index unique partiel. Les migrations `003` et `004` complètent les contraintes de document, l’état courant et l’historique.

## 5. Collaboration temps réel, OT et crédits

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Serveur WebSocket | `apps/api/src/services/collaboration.ts` | Monte ShareDB sur `/ws`, récupère la session par cookie, contrôle l’accès au document, valide la présence et raccorde Redis. |
| Type OT | `ot-text-unicode` dans frontend et backend | Représente les positions et insertions par points de code Unicode. |
| Adaptateur ShareDB durable | `apps/api/src/services/sharedb-db.ts` | Transforme un commit ShareDB accepté en transaction PostgreSQL. |
| Débit de crédit | `sharedb-db.ts`, table `daily_credits` | Compte les insertions Unicode après OT et refuse le débit au-delà de 10 000 points de code UTC. Les suppressions coûtent zéro. |
| Idempotence d’opération | migration `008_add_operation_idempotency.sql` | L’index `(document_id, source, sequence)` empêche double persistance et double débit lors d’une retransmission. |
| Synchronisation multi-instance | `createRedisPubSub()` dans `collaboration.ts` | Redis Pub/Sub diffuse les opérations ShareDB après leur persistance PostgreSQL. |
| Présence | `receivePresence` dans `collaboration.ts` | Remplace tout `editorId` transmis par le client par l’identité de la session ; transmet seulement sélection et état de saisie. |

Dans `DocumentShareDb.commit`, le verrou sur `document_states` protège l’ordre des révisions. La transaction met à jour l’état courant, le numéro de révision, l’opération OT et le crédit avant son `COMMIT`.

## 6. PDF, publication et quota

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Routes publication/téléchargement | `apps/api/src/routes/downloads.ts` | Publication propriétaire, Journal public, mise à jour/retrait, réponses `202`, `409`, `410` et livraison du PDF. |
| Service de quota | `apps/api/src/services/downloads.ts` | Création de lien, réservation, expiration, confirmation ou libération de réservation ; capture la révision durable au moment de la réservation. |
| Génération et stockage | `apps/api/src/services/pdf.ts` | Reconstruit une révision, génère le PDF PDFKit, dépose/récupère l’artefact S3 privé ou le stockage local de diagnostic. |
| Tables | migration `006_create_download_delivery_tables.sql` et migration `009_add_publications.sql` | Liens, réservations, artefacts PDF, publication et compteurs. |

Le flux est le suivant :

1. `reserveDownload()` verrouille le lien PostgreSQL, expire les réservations échues, vérifie le quota et capture `document_states.revision`.
2. `prepareDocumentPdf()` réutilise l’artefact de la même paire `(document_id, revision)` ou le génère une seule fois.
3. La route lit et valide le PDF avant de confirmer la réservation.
4. `confirmDownloadReservation()` incrémente `consumed_downloads` et décrémente `active_reservations` dans la même transaction.
5. Fastify envoie le Buffer PDF avec `Content-Type: application/pdf`.

`409 temporarily_unavailable` signifie que le dernier emplacement est temporairement réservé ; `410 exhausted` signifie que le quota est consommé. Les deux réponses ne contiennent pas de PDF.

## 7. Base de données et migrations

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Pool PostgreSQL | `apps/api/src/db.ts` | Lit `DATABASE_URL`, applique le certificat RDS de la région et active la validation TLS stricte en production/RDS. |
| Migrations | `apps/api/migrations/001_…sql` à `009_…sql` | Schéma, contraintes, index et tables métier. |
| Exécuteur | `apps/api/src/scripts/migrate.ts` | Ordre lexical, table `schema_migrations`, empreinte SHA-256 et verrou consultatif PostgreSQL. |
| Commande | `npm run migrate` | Exécute les migrations compilées. |

Les migrations sont idempotentes là où le schéma l’exige, mais le suivi par checksum interdit de modifier silencieusement une migration déjà appliquée.

## 8. Déploiement et infrastructure

| Sujet | Fichier(s) | Responsabilité |
| --- | --- | --- |
| Démarrage Elastic Beanstalk | `Procfile` | Lance `npm start`. |
| Migration EB | `.platform/hooks/predeploy/01_migrate.sh` | Lance les migrations avant le démarrage du processus web. |
| Déploiement frontend | `scripts/deploy-frontend.sh` | Build Vite, synchronisation S3, en-têtes de cache et invalidation CloudFront. |
| Réécriture API CloudFront | `scripts/cloudfront-api-rewrite.js` | Retire `/api` avant transmission à l’origine API. |
| Paramètres détaillés | `docs/deploiement-aws.md` | Variables, TLS, S3, Redis, archive EB et points de vérification. |

Le backend utilise le rôle IAM de l’instance via le SDK AWS. Aucun credential AWS n’est lu depuis le frontend ou codé dans les fichiers applicatifs.

## 9. Tests : où ils sont gérés

| Type | Fichiers | Rôle |
| --- | --- | --- |
| Unitaire | `apps/api/tests/unit/` | Santé de l’application. |
| Intégration API et PostgreSQL | `apps/api/tests/integration/api.integration.test.ts`, `document-history.integration.test.ts` | Sessions, autorisations, documents, historique et restauration. |
| Intégration collaboration | `collaboration.integration.test.ts`, `collaboration.websocket.integration.test.ts`, `collaboration.redis.integration.test.ts` | OT, Unicode, crédit, WebSocket, Redis, présence et reconnexion. |
| Intégration PDF | `pdf.integration.test.ts`, `pdf-delivery.integration.test.ts`, `download-reservations.integration.test.ts` | Génération, quotas, concurrence, réservation, expiration et livraison. |
| Rapport réel AWS | `docs/rapport-de-tests.md` | Campagnes de concurrence exécutées via le frontend public. |

Les tests d’intégration nécessitent une base PostgreSQL dédiée. Ils ne doivent pas être lancés contre les données de développement ou de production.

## 10. Éléments non gérés par le code actuel

- L’envoi effectif d’un e-mail au dernier téléchargement n’est pas encore relié à SES/SMTP.
- Les tables de blocage et d’outbox existent, mais il n’y a pas encore de politique de détection d’acharnement ni d’écran de supervision de l’association.
- La capacité complète de 15 000 visiteurs et 300 rédacteurs n’est pas démontrée par un test de charge.

Ces points sont des limites du projet actuel et ne doivent pas être présentés comme terminés.
