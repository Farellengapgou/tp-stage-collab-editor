# Matrice E2E

| Scénario | Parcours réel | Précondition | Exécution prévue |
| --- | --- | --- | --- |
| E2E-01 | Chargement public | CloudFront disponible | Chromium public |
| E2E-02 | Identification | Identité `example.test` inédite | Cookie HttpOnly réel |
| E2E-03 | Création | Session propriétaire | Document préfixé `E2E` |
| E2E-04 | Persistance | Document créé | Écriture puis rechargement |
| E2E-05 | Partage | Deux identités E2E | Invitation propriétaire |
| E2E-06 | Synchronisation | Deux contextes autorisés | Modification A observée par B |
| E2E-07 | Concurrence | Même état initial | Insertions A/B simultanées contrôlées |
| E2E-08 | Présence | Deux contextes connectés | Avatar et curseur distant |
| E2E-09 | Historique | Plusieurs révisions | Consultation via modale |
| E2E-10 | Restauration | Propriétaire et révision 1 | Restauration via interface |
| E2E-11 | Crédit quotidien | Solde visible requis | BLOQUÉ : solde absent, limite irréversible |
| E2E-12 | Crédit partagé | Solde visible requis | BLOQUÉ : solde absent |
| E2E-13 | Publication PDF | Document E2E | Publication quota 2 |
| E2E-14 | PDF vivant/quota | Publication E2E | Deux téléchargements, quota UI épuisé |
| E2E-15 | Unicode | Deux contextes autorisés | Texte Unicode synchronisé |

La suite utilise `workers: 1`, des contextes isolés et ne touche à aucune identité ou document préexistant.
