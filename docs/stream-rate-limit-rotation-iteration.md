# Itération de rotation après un rate limit SSE

Date : 30 juillet 2026

## Résultat

Une réponse upstream en échec n'est plus considérée comme un stream à relayer
uniquement parce que son en-tête contient `Content-Type: text/event-stream`.

Le test de bout en bout a révélé une limite de l'itération précédente :

1. le premier compte renvoyait un HTTP `429` sous forme SSE ;
2. le détecteur de stream classait cette réponse avant l'analyse de quota ;
3. le proxy relayait le `429` au client et terminait la requête ;
4. le second compte, pourtant disponible, n'était jamais essayé.

Désormais, un statut upstream en échec est toujours bufferisé avant tout relais.
Le routeur peut alors inspecter le corps, marquer le couple compte/modèle comme
bloqué et essayer le compte suivant. Les réponses SSE réussies conservent leur
relais immédiat, y compris le chemin OpenAI sans en-tête `Content-Type`.

Les timers de rafraîchissement du catalogue sont également passés en `unref` :
ils continuent de fonctionner tant que le serveur tourne, mais ne retiennent
plus artificiellement un processus en phase d'arrêt ou un test local terminé.

## Preuve de régression et validation

Le nouveau test lance un vrai routeur Express local avec :

- deux comptes OpenAI en mémoire ;
- un upstream simulé qui renvoie un `429` SSE au premier compte ;
- une réponse `200` au second compte ;
- des traces capturées sans aucun secret ni appel réseau.

Avant la correction, le test échouait avec `429 !== 200`. Après correction :

- le client reçoit le statut `200` du second compte ;
- les appels upstream sont exactement `account-one`, puis `account-two` ;
- le premier compte reçoit un bloc `quota/rate-limit: 429` ;
- les deux tentatives sont présentes dans les traces.

## Benchmark déterministe

| Variante | Statut final | Comptes essayés | Résultat |
|---|---:|---|---|
| Relais SSE basé sur le seul Content-Type | 429 | premier | erreur relayée |
| Classification du statut avant relais | 200 | premier, second | succès |

Ce scénario mesure le résultat de routage, pas une durée réseau. Le gain de
latence sur un vrai rate limit reste celui de la politique précédente : aucun
backoff sur le compte limité avant la rotation, contre au moins 62 secondes
avec les réglages historiques.

## Reproduction

```bash
node --import tsx scripts/benchmark-stream-rate-limit-rotation.mjs
node --import tsx --test src/routes/proxy/account-rotation.test.ts
```

Les résultats agrégés sont conservés dans
`docs/stream-rate-limit-rotation-benchmark.json`.
