# Itération de relais SSE par chunk

Date : 30 juillet 2026

## Résultat

Le chemin streaming relayait auparavant chaque frame SSE seulement après sa
reconstruction complète. Une réponse proche du p95 local pouvait ainsi
déclencher plus d'un millier de petits `res.write`, avec décodage puis
réencodage du contenu.

Le proxy transmet désormais chaque chunk amont byte-for-byte dès sa réception.
Une sonde incrémentale reconstruit séparément les frames nécessaires aux
diagnostics, à l'usage et à la classification de fin de stream.

Cette modification s'applique uniquement aux streams Responses natifs utilisés
par Codex. Elle ne modifie ni Chat Completions, ni les conversions de format,
ni les chemins bufferisés.

## Benchmark

Commande :

```bash
node --import tsx scripts/benchmark-sse-chunk-forwarding.mjs \
  --samples 1000 \
  --chunk-bytes 16384
```

Le corpus synthétique contient 1 282 frames et 133 426 octets. Les 1 024
deltas texte reprennent l'ordre de grandeur du p95 local observé de 1 064
tokens de sortie. Le découpage en chunks de 16 KiB est une calibration
synthétique et non une mesure du transport amont.

| Mesure | Baseline | Relais par chunk | Gain |
|---|---:|---:|---:|
| Médiane locale | 0,838 ms | 0,740 ms | 11,72 % |
| p95 local | 0,958 ms | 0,855 ms | 10,79 % |
| Écritures aval | 1 282 | 9 | 99,30 % |

La sortie concaténée, l'usage final et tous les diagnostics sont strictement
identiques. Un test supplémentaire couvre les séparateurs LF/CRLF, les
caractères UTF-8 coupés entre deux chunks et une dernière frame non terminée.

## Portée

Le gain absolu CPU isolé est inférieur à 0,1 ms dans ce benchmark en mémoire.
La réduction du nombre d'écritures devient plus importante sur une vraie
socket, mais ce benchmark ne prétend pas mesurer le réseau, Express, le
fournisseur ou le temps du modèle.

L'impact token est nul : ni le payload envoyé, ni le contenu SSE reçu, ni les
valeurs d'usage ne changent.
