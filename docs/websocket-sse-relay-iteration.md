# Itération de latence du relais Responses WebSocket

## Résultat

Le relais d'un flux Responses SSE vers WebSocket évite désormais de parser puis
de sérialiser chaque delta ordinaire. Sur le corpus synthétique calibré sur le
p95 de sortie observé lors de l'audit local (1 064 tokens), le temps local du
relais diminue de **28,48 % à la médiane** et de **32,07 % au p95**.

| Mesure | Avant | Après | Écart |
| --- | ---: | ---: | ---: |
| Médiane | 1,019 ms | 0,728 ms | -0,290 ms (-28,48 %) |
| p95 | 1,200 ms | 0,815 ms | -0,385 ms (-32,07 %) |
| Parses JSON | 1 285 | 3 | -99,77 % |

Les 1 285 messages WebSocket produits par les deux variantes sont strictement
identiques, octet pour octet. L'état mémorisé des appels de fonction est
également identique.

## Changement

Le chemin précédent reconstruisait continuellement un buffer texte, normalisait
tous ses retours à la ligne, découpait chaque frame avec plusieurs tableaux
temporaires, exécutait `JSON.parse`, puis `JSON.stringify`.

Le nouveau chemin :

1. réutilise le découpage SSE progressif commun ;
2. extrait les lignes `data:` sans tableaux intermédiaires ;
3. relaie directement le JSON compact des événements Responses ordinaires ;
4. parse uniquement `response.output_item.added`,
   `response.output_item.done`, `response.completed` et les événements contenant
   explicitement un item `function_call` ;
5. conserve le parse/stringify historique pour les frames multilignes ou
   atypiques, ignore `[DONE]` et les payloads invalides de ce fallback.

Cette optimisation ne modifie ni les endpoints ni les schémas. Elle préserve un
message WebSocket par événement SSE ; aucun regroupement de deltas n'est tenté,
car il changerait la granularité visible par le client.

## Reproduction

Depuis la racine du dépôt :

```bash
node --import tsx scripts/benchmark-websocket-sse-relay.mjs --samples 1000
```

Le benchmark alterne l'ordre baseline/candidat. Il génère 1 024 deltas texte,
256 événements de raisonnement, un cycle d'appel de fonction et un
`response.completed`, puis découpe les 134 114 octets en neuf chunks de 16 KiB.
Il échoue si les messages relayés ou la mémoire des appels de fonction divergent.

Les résultats agrégés sont conservés dans
`docs/websocket-sse-relay-benchmark.json`.

## Limites

- Le benchmark exclut le réseau, TLS, le framing WebSocket, le traitement client
  et la latence modèle. Le gain absolu reste donc inférieur à une milliseconde
  sur ce corpus.
- La taille des chunks amont est synthétique. Le gain relatif dépend de leur
  fragmentation et du nombre réel d'événements.
- Le chemin direct cible le format compact contractuel des événements
  Responses réussis, avec `type` en première propriété. Les autres formats
  restent sur le fallback canonique.
- Cette itération améliore la consommation CPU et la latence du proxy. Elle ne
  réduit pas les tokens facturés.
