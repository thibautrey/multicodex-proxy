# Itération de latence du catalogue de modèles

Date : 30 juillet 2026

## Résultat

Les requêtes modèle n'attendent plus systématiquement une découverte réseau
lorsque le catalogue en mémoire vient de dépasser son TTL.

Le chemin précédent appelait `discoverModels()` pendant la préparation de la
requête. Après expiration du cache, cette fonction interrogeait séquentiellement
les endpoints de modèles des comptes actifs avant de laisser partir l'appel
Responses ou Chat Completions.

Le nouveau comportement est :

- un catalogue encore frais est utilisé immédiatement ;
- le premier catalogue reste bloquant ;
- un catalogue périmé de moins de trente minutes est servi pendant son
  actualisation en arrière-plan ;
- un catalogue plus ancien redevient bloquant ;
- les actualisations concurrentes sont fusionnées ;
- `/v1/models` et les rafraîchissements planifiés conservent leur comportement
  bloquant ;
- `MODELS_STALE_WHILE_REVALIDATE=false` restaure le comportement antérieur ;
- `MODELS_STALE_MAX_AGE_MS` configure la borne, fixée à 1 800 000 ms par
  défaut.

La sélection de compte, la validation des alias, le filtrage des outils et le
payload upstream ne changent pas.

## Instrumentation

Les traces de requête exposent désormais `modelCatalogRefresh` :

- `background` compte les catalogues périmés servis pendant l'actualisation ;
- `blocking` compte les requêtes ayant attendu l'actualisation ;
- `shared` compte les requêtes ayant rejoint une actualisation existante.

La métrique existante `latencyBreakdown.preparationMs` permet de vérifier le
gain sur une instance réelle.

## Benchmark local

Le benchmark synthétique simule une découverte de 50 ms et huit requêtes
concurrentes, sur cinquante paires :

| Variante | Médiane | p95 |
|---|---:|---:|
| Baseline bloquante | 52,06 ms | 52,10 ms |
| Candidate stale-while-revalidate | 0,020 ms | 0,033 ms |

L'amélioration médiane de la phase isolée est de **99,96 %**. Les cinquante
échantillons candidats ont déclenché exactement cinquante actualisations, soit
une seule par groupe de huit requêtes concurrentes.

Ce benchmark mesure uniquement l'attente locale liée à un catalogue expiré.
Il ne mesure pas la latence du modèle, le temps au premier token ou le réseau
bout en bout.

Le benchmark live sur une copie du store private environment n'a pas été rejoué : l'hôte
restait inaccessible et aucun tunnel local n'écoutait sur le port 1455. La
production n'a pas été modifiée.

## Reproduction

```bash
node --import tsx scripts/benchmark-model-catalog-refresh.mjs \
  --samples 50 \
  --concurrent 8 \
  --delay-ms 50
```

Les résultats agrégés sont conservés dans
`docs/model-catalog-latency-benchmark.json`.
