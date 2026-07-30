# Itération de latence de la détection d'images

Date : 30 juillet 2026

## Résultat

Les requêtes textuelles ne construisent plus de résumés détaillés de chaque
bloc de contexte uniquement pour déterminer si une image est présente.

Le chemin précédent :

1. résumait tout le payload entrant pour choisir le modèle ;
2. résumait à nouveau le payload entrant pour la trace d'images ;
3. résumait le payload upstream une troisième fois ;
4. jetait les trois structures lorsque la requête ne contenait aucune image.

Chaque résumé créait notamment un objet de diagnostic et un tableau de clés
pour chaque bloc texte. Ce travail augmentait avec toute la fenêtre Codex,
alors que le résultat utile pour une requête textuelle était un simple booléen.

Le nouveau chemin :

- parcourt le payload une seule fois avec sortie anticipée ;
- réutilise ce booléen pour le routage et la trace ;
- ne construit aucun résumé détaillé pour les requêtes sans image ;
- conserve le diagnostic détaillé entrant/upstream lorsque la requête contient
  une image ;
- ne modifie ni la conversion des images, ni le modèle de surcharge configuré,
  ni le payload upstream.

Cette itération ne change pas la consommation de tokens ou la génération du
modèle. Elle réduit uniquement le coût CPU et les allocations avant l'appel
upstream.

## Benchmark local

Le benchmark synthétique utilise une fenêtre textuelle de 10 000 éléments sur
200 paires :

| Variante | Scans | Médiane | p95 |
|---|---:|---:|---:|
| Baseline avec résumés détaillés | 3 | 3,698 ms | 8,030 ms |
| Détection booléenne réutilisée | 1 | 0,157 ms | 0,171 ms |

L'amélioration médiane de cette phase isolée atteint **95,76 %**.

Cette mesure ne représente pas la latence bout en bout. Le gain réel dépend du
nombre d'éléments du contexte et devient surtout visible sur les longues
fenêtres Responses/Codex.

## Validation fonctionnelle

Les tests couvrent :

- une image Responses dans un bloc `input_image` ;
- un payload Chat Completions textuel ;
- un type d'image générique au niveau d'un élément d'entrée ;
- le routage vers le modèle de surcharge pour les images ;
- la conservation des conversions d'images dans les deux directions.

## Reproduction

```bash
node --import tsx scripts/benchmark-image-detection.mjs \
  --samples 200 \
  --items 10000
```

Les résultats agrégés sont conservés dans
`docs/image-detection-latency-benchmark.json`.
