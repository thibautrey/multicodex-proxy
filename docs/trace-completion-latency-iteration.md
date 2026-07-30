# Itération de persistance des traces

Date : 30 juillet 2026

## Résultat

La fin d'une réponse streamée n'entraîne plus la réécriture synchrone de toute
la fenêtre des traces récentes.

Le chemin précédent :

- écrivait immédiatement un record `started`, afin de rendre les streams
  interrompus observables après un crash ;
- remplaçait ce record en mémoire à la fin du stream ;
- réécrivait alors jusqu'à 1 000 records dans un fichier temporaire avant de le
  renommer ;
- sérialisait toutes les fins concurrentes derrière cette réécriture ;
- testait une compaction à 150 % de la rétention après avoir déjà tronqué le
  cache à 100 %, ce qui rendait le seuil inaccessible et laissait croître le
  nombre de lignes physiques.

Le nouveau chemin conserve l'écriture durable du record `started`, puis ajoute
le record final avec le même identifiant. Au chargement, les lignes sont
dédupliquées par identifiant et seul le record le plus récent est exposé.

La compaction est déclenchée d'après le nombre de lignes physiques lorsque
celui-ci dépasse 150 % de la rétention. Elle reste sérialisée avec les écritures
pour éviter de perdre un append pendant le renommage, mais elle n'est pas
attendue par la requête qui franchit le seuil. Les records `started` encore
actifs sont préservés pendant la rétention, même s'ils sont plus anciens que les
dernières réponses terminées.

L'historique statistique conserve exactement un record final par requête. Le
format public des traces et les endpoints ne changent pas.

## Benchmark local

Le benchmark synthétique précharge 1 000 traces, démarre 64 streams, puis mesure
leurs 64 fins concurrentes. Chaque record final contient une charge de 512
octets. Sept paires sont exécutées dans un ordre alterné après un warm-up.

| Variante | Lot médian de 64 | p95 du lot | Médiane par fin |
|---|---:|---:|---:|
| Réécriture de la fenêtre | 47,67 ms | 50,20 ms | 0,745 ms |
| Append final | 6,46 ms | 6,85 ms | 0,101 ms |

La réduction médiane de la phase isolée est de **86,44 %**, soit environ
41,20 ms pour le lot et 0,644 ms par fin dans ce scénario concurrent. Le fichier
append-only est temporairement plus grand (environ 791 Ko contre 718 Ko) avant
le prochain compactage ; sa taille physique reste bornée par le seuil.

Ce benchmark mesure uniquement la persistance locale de la trace et de son
historique. Il ne mesure ni le routage du proxy, ni le réseau, ni la latence du
fournisseur ou du modèle. Il n'affecte pas les tokens ou les résultats générés.

## Validation fonctionnelle

Les tests vérifient :

- la présence immédiate du record `started` sur disque ;
- l'ajout du record final avec le même identifiant ;
- la déduplication après redémarrage ;
- l'unicité du record final dans l'historique statistique ;
- la compaction d'un journal contenant des doublons ;
- la préservation d'un stream actif pendant la rétention.

## Reproduction

```bash
node --import tsx scripts/benchmark-trace-completion.mjs \
  --retention 1000 \
  --completions 64 \
  --runs 7 \
  --payload-bytes 512
```

Les résultats agrégés sont conservés dans
`docs/trace-completion-latency-benchmark.json`.
