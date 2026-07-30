# Itération de diagnostic des streams SSE

Date : 30 juillet 2026

## Résultat

Le relais natif des streams `/responses` ne parse plus systématiquement en JSON
chaque delta uniquement pour mettre à jour les diagnostics.

Les événements dont le payload est réellement nécessaire continuent d'être
parsés intégralement :

- `response.completed` et les événements contenant l'usage ;
- appels de fonctions et fonctions internes masquées ;
- appels d'outils personnalisés et leurs deltas ;
- chunks Chat Completions ;
- frames sans type SSE fiable ou contenant plusieurs lignes `data:`.

Pour les événements à haute fréquence dont seul le type est utilisé, le proxy
lit maintenant le type SSE et met directement à jour les compteurs :

- `response.output_text.delta` et `response.output_text.done` ;
- familles `response.reasoning*` ;
- familles `response.refusal*`.

Le passthrough Chat Completions évite également tout parse JSON tant qu'une
frame ne contient pas de propriété `usage`. La frame finale reste parsée et les
totaux sont inchangés.

## Équivalence

Les tests rejouent un stream mixte contenant texte, raisonnement, refus,
fonction interne, outil personnalisé, usage final, chunk Chat, payload invalide
et frame multi-`data`.

Les structures `ResponseStreamDiagnostics` baseline et candidate sont comparées
champ par champ. Les usages extraits sont également identiques.

## Benchmark local

Le corpus synthétique utilise :

- 1 024 deltas texte, proches du p95 local observé de 1 064 tokens de sortie
  `/responses` ;
- 256 événements de raisonnement ;
- une fonction et un événement `response.completed` ;
- pour le passthrough Chat, 1 024 chunks ordinaires et une frame d'usage finale.

Cette calibration est un stress proxy : un token ne correspond pas
nécessairement à une frame SSE.

| Chemin | Baseline médiane | Candidate médiane | Gain | Gain absolu |
|---|---:|---:|---:|---:|
| Diagnostics Responses, 1 283 frames | 0,604 ms | 0,405 ms | 32,93 % | 0,199 ms |
| Extraction usage Chat, 1 026 frames | 0,575 ms | 0,081 ms | 85,99 % | 0,494 ms |

Les diagnostics et usages sont strictement équivalents dans les 500 paires.
Ces durées isolent uniquement l'inspection locale avant le relais. Elles
n'incluent ni décodage, ni écriture Express, ni réseau, ni latence fournisseur
ou modèle. Cette itération ne modifie aucun token.

## Reproduction

```bash
node --import tsx scripts/benchmark-sse-diagnostics.mjs \
  --samples 500 \
  --text-deltas 1024 \
  --reasoning-events 256
```

Les résultats agrégés sont conservés dans
`docs/sse-diagnostics-latency-benchmark.json`.
