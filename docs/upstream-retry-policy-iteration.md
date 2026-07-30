# Itération de rotation après rate limit

Date : 30 juillet 2026

## Résultat

Les réponses de quota et de rate limit ne sont plus réessayées plusieurs fois
sur le même compte avant que le routeur puisse sélectionner le suivant.

Le comportement précédent avait deux effets cumulés :

- `fetchCodexWithRetry` classait les réponses HTTP `429` et les messages
  `rate limit` comme des erreurs transitoires du compte courant ;
- après épuisement de ces retries, la réponse d'erreur était envoyée au client
  avant que la branche de rotation marque le compte comme bloqué et poursuive
  sur le compte suivant.

Le proxy distingue désormais :

- quota, usage limit et rate limit : retour immédiat vers le routeur, blocage du
  couple compte/modèle, puis essai du compte suivant sans avoir envoyé l'erreur
  intermédiaire au client ;
- erreurs serveur `500`, `502`, `503`, `504`, surcharge et erreurs de transport :
  retries sur le même compte avec le backoff et `Retry-After` existants ;
- autres erreurs : retour immédiat sans retry.

La politique documentée de rotation des comptes correspond ainsi au
comportement effectif. Le payload upstream, les tokens et la réponse générée par
le compte qui réussit ne changent pas.

## Signal dans les rollouts Codex locaux

Une recherche en lecture seule sur les rollouts locaux de juillet a trouvé 223
lignes portant un motif explicite parmi `Too Many Requests`, `HTTP 429`,
`status 429`, `upstream 429` et `quota/rate-limit: 429`, réparties dans 35
fichiers de rollout.

Ces nombres mesurent des répétitions textuelles, pas des incidents uniques : un
même échec peut être cité dans un prompt, une sortie d'outil et un récapitulatif.
Ils confirment seulement que le chemin de rate limit est fréquent dans le corpus
local et mérite une politique sans attente inutile.

## Benchmark déterministe

Avec la configuration par défaut (`MAX_UPSTREAM_RETRIES=5`,
`UPSTREAM_BASE_DELAY_MS=2000`) et sans compter le jitter :

| Scénario | Appels avant | Appels après | Attente minimale avant | Après |
|---|---:|---:|---:|---:|
| HTTP 429 | 6 | 1 | 62 000 ms | 0 ms |
| Message `rate limit` | 6 | 1 | 62 000 ms | 0 ms |
| 503 puis succès | 2 | 2 | 2 000 ms | 2 000 ms |
| 503 persistant | 6 | 6 | 62 000 ms | 62 000 ms |

Le gain de 62 secondes est la borne minimale avant rotation : l'ancien chemin
ajoutait aussi jusqu'à 2,5 secondes de jitter cumulé. Cette mesure isole la
politique locale et ne prétend pas mesurer la latence réseau ou fournisseur.

## Validation

Les tests couvrent :

- le retour immédiat d'un `429` ;
- les erreurs métier de quota sans statut `429` ;
- la conservation du retry et de `Retry-After` pour un `503` transitoire ;
- la conservation du retry après erreur de transport ;
- l'absence de retry pour une exception de quota.

## Reproduction

```bash
node --import tsx scripts/benchmark-upstream-retry-policy.mjs \
  --max-retries 5 \
  --base-delay-ms 2000
```

Les résultats agrégés sont conservés dans
`docs/upstream-retry-policy-benchmark.json`.
