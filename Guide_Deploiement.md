# Collab Editor — Guide de déploiement AWS

## 1. Configuration AWS

Déployer dans la région **`eu-north-1`** (Stockholm), compte AWS `455592559083`.

| Ressource | Configuration |
|---|---|
| VPC | `vpc-0f0fd5d567a6a3af3` (`172.31.0.0/16`) |
| Sous-réseaux publics | `subnet-0e62876ec3185b4c2` (1a), `subnet-0b3aa2bebc06e0415` (1b), `subnet-054f58b40e5bab977` (1c) |
| Sous-réseaux privés | `collab-private-a` (`172.31.48.0/24`), `collab-private-b` (`172.31.49.0/24`) |
| Elastic Beanstalk | Application `collab-editor`, environnement `Collab-editor-env-1`, ID `e-w3exykwv8i` |
| Backend EC2 | Single instance, `t3.micro`, Node.js 22 / Amazon Linux 2023 |
| Groupe de sécurité backend | `sg-00898f24c936005d6` ; groupe EB `sg-09cc1c1ecb8a0e4b0` |
| RDS | `collab-editor-db`, PostgreSQL 17.10, port `5432`, endpoint `collab-editor-db.c3sm0o8couq7.eu-north-1.rds.amazonaws.com` |
| Valkey | `collab-editor-redis`, Valkey 9.1, port `6379`, SG `sg-0c53b05468bc57b00` |
| Bucket PDF | `colab-editor-pdfs` (privé) |
| Bucket frontend | `collab-editor-frontend-455592559083` (privé) |
| CloudFront | Distribution `E3980PPRULYQTO` ; `https://dlnopdrpomzao.cloudfront.net/` |
| Rôle EC2 | `collab-editor-eb-ec2-role` |
| Rôle de service EB | `aws-elasticbeanstalk-service-role` |

Autoriser le trafic **TCP 5432** depuis le groupe de sécurité backend vers RDS, et **TCP 6379** depuis ce même groupe vers Valkey. Conserver les deux services dans les sous-réseaux privés. Le bucket PDF est accessible au backend via son rôle IAM avec les permissions `s3:GetObject` et `s3:PutObject`.

## 2. Préparer le backend

Depuis la racine du dépôt :

```bash
npm ci
npm run build
```

Le backend compilé se trouve dans `apps/api/dist/`. Le démarrage utilise le `Procfile` :

```text
web: npm start
```

La commande `npm start` lance `node apps/api/dist/server.js`. Le serveur écoute sur `0.0.0.0` et sur le port défini par `PORT`.

Créer l'archive ZIP de déploiement Elastic Beanstalk avec les éléments suivants **à la racine** :

```text
package.json
package-lock.json
Procfile
.platform/hooks/predeploy/01_migrate.sh
apps/api/package.json
apps/api/dist/
apps/api/migrations/
apps/api/assets/fonts/NotoSans-Regular.ttf
apps/api/assets/certs/rds-eu-north-1-bundle.pem
```

Ne pas inclure `.env`, identifiants AWS, fichiers de test ni `node_modules` de la machine locale.

## 3. Configurer Elastic Beanstalk

Dans **Elastic Beanstalk → Collab-editor-env-1 → Configuration**, renseigner les variables suivantes :

| Variable | Valeur |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `DATABASE_URL` | Référence au secret AWS Secrets Manager ci-dessous |
| `REDIS_URL` | `rediss://master.collab-editor-redis.qljbe0.eun1.cache.amazonaws.com:6379` |
| `AWS_REGION` | `eu-north-1` |
| `PDF_STORAGE` | `s3` |
| `PDF_S3_BUCKET` | `colab-editor-pdfs` |
| `DOWNLOAD_RESERVATION_TTL_SECONDS` | `300` |

Configurer `DATABASE_URL` comme variable issue d'**AWS Secrets Manager**, avec la référence :

```text
arn:aws:secretsmanager:eu-north-1:455592559083:secret:collab-editor/production/database-url-88ThDN
```

Le rôle EC2 `collab-editor-eb-ec2-role` doit disposer de `secretsmanager:GetSecretValue` sur cet ARN via la politique `collab-editor-read-db-secret`.

Le certificat RDS est inclus dans `apps/api/assets/certs/rds-eu-north-1-bundle.pem` pour la connexion PostgreSQL avec validation TLS. La connexion Valkey utilise `rediss://`.

## 4. Publier le backend

Dans **Elastic Beanstalk → Collab-editor-env-1**, choisir **Upload and deploy**, sélectionner le ZIP du backend et publier une nouvelle version de l'application.

Pendant le déploiement, le hook `.platform/hooks/predeploy/01_migrate.sh` exécute :

```bash
node apps/api/dist/scripts/migrate.js
```

Le programme applique les migrations de `apps/api/migrations/` dans l'ordre, utilise `schema_migrations`, un verrou PostgreSQL et des empreintes SHA-256.

Tester ensuite le point de santé :

```bash
curl -i http://collab-editor-env-1.eba-68mxpaqg.eu-north-1.elasticbeanstalk.com/health
```

La réponse attendue est `HTTP 200` avec `{"status":"ok"}`.

## 5. Configurer CloudFront

Utiliser le bucket privé `collab-editor-frontend-455592559083` comme origine des fichiers statiques, avec un **Origin Access Control (OAC)**.

Configurer les chemins :

| Chemin | Destination | Traitement |
|---|---|---|
| `/*` | Bucket S3 frontend | Distribution des fichiers React/Vite |
| `/api/*` | Origine Elastic Beanstalk | Réécriture `/api/...` en `/...` avec `scripts/cloudfront-api-rewrite.js` |
| `/ws` | Origine Elastic Beanstalk | Transmission des connexions WebSocket |

Sur les comportements API et WebSocket, transmettre les cookies et les en-têtes nécessaires à l'authentification et à la mise à niveau WebSocket. Utiliser HTTPS/WSS entre le navigateur et CloudFront.

## 6. Compiler et publier le frontend

Depuis la racine du dépôt :

```bash
npm ci
VITE_API_BASE_URL=/api VITE_WS_URL=/ws npm run build -w @collab/web
```

Les fichiers compilés sont dans `apps/web/dist/`.

Pour publier avec le script du dépôt :

```bash
export FRONTEND_BUCKET=collab-editor-frontend-455592559083
export CLOUDFRONT_DISTRIBUTION_ID=E3980PPRULYQTO
bash scripts/deploy-frontend.sh
```

Le script synchronise les fichiers vers S3, applique les en-têtes de cache et invalide `/*` sur CloudFront.

L'application est accessible à :

**https://dlnopdrpomzao.cloudfront.net/**

## 7. Tester le déploiement

1. Ouvrir l'URL CloudFront et vérifier l'affichage du frontend.
2. Vérifier `GET /api/health` depuis CloudFront.
3. Créer une session et vérifier le cookie `collab_session`.
4. Ouvrir un document dans deux navigateurs et modifier son contenu simultanément.
5. Vérifier la connexion WebSocket sur `/ws`.
6. Publier un document, générer puis télécharger son PDF.
7. Modifier le document et contrôler que le téléchargement de la nouvelle révision restitue son contenu actualisé.
8. Contrôler le quota de téléchargements et les réponses HTTP associées.
9. Consulter les événements et journaux Elastic Beanstalk pour le démarrage, les migrations, PostgreSQL et Valkey.

