# Itération d’efficacité du chemin Responses

Date : 30 juillet 2026

## Résultat

Cette itération réduit le temps de préparation des requêtes lorsqu’un snapshot
d’usage existe mais a dépassé son TTL.

Auparavant, la requête modèle attendait le rafraîchissement d’usage de tous les
comptes actifs. Désormais :

- le premier snapshot reste bloquant ;
- un snapshot périmé est servi pendant son actualisation en arrière-plan ;
- un snapshot vieux de plus de trente minutes redevient bloquant ;
- les actualisations concurrentes d’un même compte sont fusionnées ;
- la tâche d’arrière-plan travaille sur une copie et ne persiste que le champ
  `usage`, afin de ne pas écraser une modification administrative récente ;
- un compte ayant un reset hebdomadaire programmé conserve un rafraîchissement
  bloquant, car sa valeur d’usage peut déclencher la consommation du crédit ;
- `USAGE_STALE_WHILE_REVALIDATE=false` restaure le comportement antérieur.

La borne de trente minutes est configurable avec
`USAGE_STALE_MAX_AGE_MS`.

## Benchmark local

Le script `scripts/benchmark-usage-refresh.mjs` compare la préparation
historique et la préparation candidate avec quatre comptes et des sondes
simulées de 50 ms.

Sur vingt paires :

| Variante | Médiane | p95 |
|---|---:|---:|
| Baseline bloquante | 52,10 ms | 52,14 ms |
| Candidate stale-while-revalidate | 0,04 ms | 0,07 ms |

L’amélioration médiane de la phase de préparation est de **99,91 %** dans ce
test isolé. Ce résultat ne mesure pas la latence du modèle ou du réseau
upstream.

Le benchmark réel sur une copie du store private environment n’a pas été rejoué pendant
cette itération : l’hôte `192.0.2.223` était inaccessible depuis la machine
de développement (`Network is unreachable`). Aucune tentative n’a modifié la
production.

## Instrumentation ajoutée

Les traces exposent désormais :

- `latencyBreakdown.preparationMs` ;
- `latencyBreakdown.upstreamHeadersMs` ;
- `usageRefresh.background`, `blocking` et `shared` ;
- `tokensInputCacheWrite` ;
- `tokensReasoning` ;
- `inputContext.compactionItemCount` ;
- `inputContext.itemsBeforeLatestCompaction`.

Les deux compteurs de compaction permettent de détecter des préfixes
potentiellement superflus sans persister le contenu des requêtes.

L’estimation de coût distingue aussi les écritures de cache GPT-5.6 des
lectures et des entrées ordinaires. Une écriture est comptée au tarif officiel
de 1,25 fois l’entrée non cachée, sans recompter les mêmes tokens dans les
entrées ordinaires.

## Tokens : décision conservatrice

Cette itération n’effectue aucune suppression automatique de contexte.

La documentation OpenAI autorise à supprimer l’ancien préfixe après une
compaction serveur stateless, mais exige de transmettre intacte la fenêtre
canonique renvoyée par `/responses/compact`. Le proxy ne peut pas distinguer
ces deux origines à partir d’un élément `type: "compaction"` seul. Un pruning
automatique risquerait donc de supprimer un élément conservé par le compactage
standalone.

Les nouvelles traces permettront de mesurer la fréquence de ces formes avant
de définir un contrat explicite et dépendant du fournisseur.

## Reproduction

```bash
node --import tsx scripts/benchmark-usage-refresh.mjs \
  --samples 20 \
  --accounts 4 \
  --delay-ms 50
```

Référence officielle :

- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
