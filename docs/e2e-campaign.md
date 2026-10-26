# Campagne E2E Playwright

## Exécution

- Date : 26 octobre 2026
- Cible : `https://dlnopdrpomzao.cloudfront.net`
- Navigateur : Chromium Playwright 1.64.1
- Mode : un worker, contextes navigateur isolés, API et WebSocket réels
- Données créées : identités et documents distincts préfixés `E2E`, adresses `example.test`

## Résultats

| Scénario | Résultat | Preuve / observation |
| --- | --- | --- |
| E2E-01 accès | PASS | Frontend CloudFront chargé dans Chromium. |
| E2E-02 identification | PASS | Sessions créées pour deux identités E2E. |
| E2E-03 création | PASS | Document E2E créé depuis la modale. |
| E2E-04 persistance | PASS | Texte conservé après rechargement. |
| E2E-05 partage | PASS | Le second rédacteur accède au document partagé. |
| E2E-06 synchronisation | PASS | Insertion de A reçue par B sans rechargement. |
| E2E-07 concurrence | PASS | Insertions A/B convergentes et conservées. |
| E2E-08 présence / curseur | FAIL | Après ouverture dans de nouveaux contextes et frappe réelle de B, A ne reçoit pas l’opération ni l’avatar/cursor dans le délai de 15 s. |
| E2E-09 historique | PASS | Révision consultée depuis la modale. |
| E2E-10 restauration | PASS | Révision 1 restaurée par le propriétaire et reçue par le collaborateur. |
| E2E-11 crédit quotidien | SKIPPED | Solde absent de l’interface ; limite irréversible de 10 000 non consommée. |
| E2E-12 crédit partagé | SKIPPED | Solde absent de l’interface. |
| E2E-13 publication | PASS | Publication E2E créée avec quota 2. |
| E2E-14 PDF vivant / quota | PARTIEL | Deux téléchargements Chromium, puis bouton `Quota atteint`. Le même lien reste utilisable après modification, mais le texte interne du second PDF n’est pas encore extrait et comparé par la suite. |
| E2E-15 Unicode | PASS | `café`, `€` et `漢字` synchronisés entre les deux contextes. |

Synthèse Playwright : **10 tests PASS, 1 test FAIL, 2 tests SKIPPED**. Au niveau des exigences, E2E-14 reste partiel sur la vérification sémantique du contenu PDF.

## Anomalie à traiter

### Présence et reprise de collaboration — gravité majeure

Reproduction : créer et partager un document E2E, fermer les premiers contextes, ouvrir le même document dans deux nouveaux contextes authentifiés, puis saisir `¤` dans le contexte B. B accepte l’écriture, mais A conserve la valeur antérieure pendant 15 secondes. L’avatar de B et le curseur distant ne sont donc pas affichés.

Le même run valide E2E-06 et E2E-07 avant cette reprise de contextes : le défaut paraît lié à la reprise/reconnexion ou à la diffusion de présence, pas à toutes les opérations OT. Aucune correction applicative n’a été appliquée dans cette campagne.

Preuves locales générées :

- `playwright-report/index.html`
- `test-results/results.json`
- `test-results/junit.xml`
- `test-results/artifacts/collab-editor-E2E-08-présence-et-curseur-distant-chromium/trace.zip`
- captures d’échec dans ce même dossier
