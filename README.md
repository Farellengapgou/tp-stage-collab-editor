# Collab Editor

Application web d’écriture collaborative pour la préparation d’un journal numérique. Un rédacteur est identifié par son nom et son adresse e-mail, peut créer et partager un document texte, le modifier à plusieurs en temps réel, consulter son historique, restaurer une version et publier un lien de téléchargement PDF limité par un quota.

Ce dépôt contient le backend Fastify/ShareDB, le frontend React/Vite, les migrations PostgreSQL et les tests. Les fonctionnalités décrites ci-dessous correspondent au code présent sur cette branche ; les limites connues sont indiquées explicitement dans la dernière section.

## Architecture

```text
Navigateur React/Vite
  ├── HTTPS → API Fastify
  └── WebSocket /ws → ShareDB
                         ├── PostgreSQL : états, opérations OT, crédits,
                         │                sessions, liens et réservations
                         ├── Redis Pub/Sub : diffusion ShareDB inter-instances
                         └── S3 privé : artefacts PDF
```

- `apps/web` : interface React/Vite ; elle emploie les cookies de session et ShareDB côté navigateur.
- `apps/api` : API Fastify, serveur WebSocket ShareDB, services PostgreSQL et génération/livraison PDF.
- PostgreSQL est la source de vérité durable : `document_states` conserve l’état courant et `edit_operations` l’historique OT.
- Redis est utilisé uniquement pour la diffusion ShareDB entre processus ; il n’est pas un stockage durable.
- Les PDF sont générés avec PDFKit et la police incluse `NotoSans-Regular.ttf`. En production, les artefacts sont stockés dans un bucket S3 privé ; l’API les lit et les livre, sans URL S3 publique ni URL présignée.

## Fonctionnalités réalisées

- Identification légère par nom et e-mail, avec session stockée dans un cookie `HttpOnly`, `SameSite=Lax` et `Secure` en production.
- Création de documents, liste des documents accessibles et partage avec un rédacteur déjà connu.
- Édition collaborative de texte Unicode avec ShareDB et `ot-text-unicode`.
- Contrôles d’accès serveur pour les opérations WebSocket et HTTP.
- Présence collaborative : rédacteurs présents, sélection/curseur et indication de saisie transmis via ShareDB.
- Historique des révisions, consultation d’une révision et restauration par le propriétaire. Une restauration est une nouvelle opération OT ; elle ne remplace pas l’historique.
- Crédit quotidien de 10 000 points de code Unicode par rédacteur : le débit et la persistance de l’opération sont dans la même transaction PostgreSQL. Les suppressions ne consomment pas de crédit.
- Publication d’un document, Journal public, lien de téléchargement avec quota, réservation transactionnelle, expiration des réservations et livraison du PDF.
- Le lien public conserve son token et son compteur : au téléchargement, la révision durable courante est capturée, afin qu’une correction postérieure à la publication soit incluse dans le PDF suivant.

## Invariants importants

### Quota de téléchargement

Le serveur verrouille la ligne `download_links` avec `SELECT … FOR UPDATE`. Une réservation possède une clé d’idempotence unique par lien et incrémente `active_reservations` dans la même transaction. La confirmation décrémente cette valeur et incrémente `consumed_downloads` dans une autre transaction atomique. Les contraintes PostgreSQL empêchent que `consumed_downloads + active_reservations` dépasse le quota.

Un `409 temporarily_unavailable` signifie que les dernières places sont temporairement réservées par d’autres requêtes ; ce n’est pas un PDF livré. Un `410 exhausted` signifie que le quota est définitivement consommé.

### Écriture collaborative

Pour chaque opération acceptée, l’adaptateur ShareDB verrouille l’état du document, calcule le coût Unicode, débite le crédit si nécessaire, met à jour l’état courant et enregistre l’opération dans une seule transaction PostgreSQL. La paire `(document_id, source, sequence)` protège les retransmissions contre une seconde application ou facturation.

## Prérequis

- Node.js `>=20 <23` (Node.js 22 est la cible Elastic Beanstalk).
- PostgreSQL accessible via `DATABASE_URL`.
- Redis/Valkey accessible via `REDIS_URL` pour la diffusion multi-instance. `redis://` et `rediss://` sont acceptés ; `rediss://` active la validation TLS.
- Pour les PDF de production : un bucket S3 privé et des identifiants AWS fournis par la chaîne standard du SDK (rôle IAM sur Elastic Beanstalk). Aucune clé AWS n’est attendue dans le dépôt.

## Configuration locale

Copier le modèle, puis compléter les valeurs locales sans versionner le fichier :

```sh
cp .env.example .env
```

Variables utilisées par le backend :

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | URL PostgreSQL obligatoire. |
| `REDIS_URL` | URL Redis/Valkey ; utiliser `rediss://` lorsque TLS est imposé. |
| `PORT` | Port Fastify ; `3000` par défaut. |
| `NODE_ENV` | `production` active notamment les cookies sécurisés et TLS PostgreSQL. |
| `AWS_REGION` | Région utilisée par le SDK AWS. |
| `PDF_STORAGE` | `s3` en production ; `local` uniquement pour un diagnostic local. |
| `PDF_S3_BUCKET` | Bucket privé des PDF lorsque `PDF_STORAGE=s3`. |
| `PDF_LOCAL_DIRECTORY` | Répertoire d’artefacts, uniquement lorsque `PDF_STORAGE=local`. |
| `DOWNLOAD_RESERVATION_TTL_SECONDS` | Durée d’une réservation de téléchargement ; `300` par défaut. |

Le frontend emploie `apps/web/.env.example` :

| Variable | Rôle |
| --- | --- |
| `VITE_API_BASE_URL` | Base HTTP de l’API, `/api` en développement avec proxy Vite. |
| `VITE_WS_URL` | Point WebSocket ShareDB, `/ws` en développement. |
| `VITE_API_TARGET` | Cible du proxy Vite, `http://localhost:3000` par défaut. |

Les variables préfixées par `VITE_` sont publiques dans le build frontend : elles ne doivent jamais contenir de secret.

## Installation et démarrage local

```sh
npm ci
npm run build
npm run migrate
npm run dev:api
```

Dans un second terminal :

```sh
npm run dev -w @collab/web -- --host 127.0.0.1 --port 5173
```

Ouvrir `http://127.0.0.1:5173`. L’API écoute par défaut sur `http://127.0.0.1:3000` et expose `GET /health`.

`npm run migrate` est idempotent : il suit les fichiers exécutés dans `schema_migrations`, vérifie leur empreinte SHA-256 et utilise un verrou consultatif PostgreSQL. Il ne doit jamais être exécuté contre une base que l’on souhaite réinitialiser ou écraser.

Pour les tests d’intégration, toujours utiliser une base PostgreSQL isolée des données de développement ou de production, appliquer les migrations sur cette base, puis lancer :

```sh
npm test
```

Les tests Redis multi-instance ne s’exécutent que si `REDIS_URL` est défini. Les tests PDF utilisent une implémentation de stockage simulée : ils ne nécessitent ni appel AWS réel ni credential.

## API HTTP principale

Les routes authentifiées requièrent le cookie de session créé par `POST /editors`.

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/health` | Vérification de santé. |
| `POST` | `/editors` | Crée ou retrouve un rédacteur et crée une session. |
| `GET` | `/editors/me` | Rédacteur de la session. |
| `GET` | `/editors/lookup?email=` | Recherche d’un rédacteur existant. |
| `POST` / `GET` | `/documents` | Création et liste des documents accessibles. |
| `GET` | `/documents/:id` | Métadonnées d’un document accessible. |
| `POST` | `/documents/:id/editors` | Ajout d’un collaborateur par le propriétaire. |
| `GET` | `/documents/:id/editors` | Liste des collaborateurs. |
| `GET` | `/documents/:id/history` | Liste des révisions. |
| `GET` | `/documents/:id/history/:revision` | Contenu reconstruit d’une révision. |
| `POST` | `/documents/:id/history/:revision/restore` | Restaure une révision sous forme d’une nouvelle opération. |
| `POST` | `/documents/:id/publication` | Prépare le PDF et crée la publication du propriétaire. |
| `PATCH` / `DELETE` | `/documents/:id/publication` | Modifie le quota ou retire la publication. |
| `GET` | `/journal` | Liste publique des publications actives. |
| `GET` | `/journal/:token` | Métadonnées publiques d’une publication. |
| `POST` | `/downloads/:token` | Télécharge un PDF ; corps JSON : `{ "idempotencyKey": "…" }`. |

Le WebSocket ShareDB est servi sur `/ws`. Il utilise la même session par cookie que les routes HTTP et refuse les opérations ou présences d’un rédacteur non autorisé sur le document.

## Déploiement AWS

La cible est un frontend statique S3/CloudFront et un backend Node.js natif Elastic Beanstalk, avec RDS PostgreSQL, ElastiCache/Valkey et S3 privé pour les PDF.

- Le `Procfile` démarre `npm start`, soit `node apps/api/dist/server.js`.
- L’application écoute sur `0.0.0.0` et lit `PORT` ; Elastic Beanstalk peut donc lui fournir son port de service.
- Le hook `.platform/hooks/predeploy/01_migrate.sh` lance les migrations déjà compilées avant le déploiement du processus web. Une erreur de migration arrête le déploiement.
- La police PDFKit et le certificat RDS présents dans `apps/api/assets/` doivent être inclus dans le bundle avec `apps/api/dist/`, `apps/api/migrations/`, `package.json`, `package-lock.json`, `Procfile` et `.platform/`.
- Le rôle IAM de l’instance, non des clés statiques, doit avoir les droits minimaux de lecture/écriture sur le bucket PDF privé.
- Le proxy public doit autoriser les connexions WebSocket et fournir HTTPS/WSS. Le frontend HTTPS doit employer l’URL HTTPS/WSS de l’API afin d’éviter le mixed content.

Le script `scripts/deploy-frontend.sh` construit le frontend, synchronise son répertoire `dist/` vers le bucket configuré, puis invalide CloudFront. Il nécessite des permissions AWS locales et les variables `FRONTEND_BUCKET` et `CLOUDFRONT_DISTRIBUTION_ID`. Ne pas l’exécuter sans vérifier la cible AWS.

## Limites connues

- L’identité par nom et e-mail est volontairement légère : ce n’est pas une authentification forte.
- Le modèle de données contient les tables d’événements/notifications et de blocage, mais le code actuel ne fournit ni envoi effectif de courriel au dernier téléchargement ni tableau de supervision de l’association ni politique de blocage après abus. Ces exigences restent à terminer avant de les revendiquer comme livrées.
- La campagne de concurrence documentée dans `docs/rapport-de-tests.md` valide des scénarios à 20 téléchargements simultanés et jusqu’à cinq rédacteurs. Elle ne prouve pas encore l’objectif complet de 15 000 visiteurs et 300 rédacteurs.
- Les routes de diagnostic PDF ne sont enregistrées que hors production ; elles ne font pas partie du parcours métier public.

## Documentation de validation

Le rapport de tests et l’analyse des preuves disponibles sont dans [documents/Rapport_de_Tests.md](documents/Rapport_de_Tests.md). La configuration de déploiement est décrite dans [documents/Guide_Deploiement.md](documents/Guide_Deploiement.md).
