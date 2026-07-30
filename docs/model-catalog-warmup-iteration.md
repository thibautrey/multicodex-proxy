# Itération de préchauffage du catalogue de modèles

Date : 30 juillet 2026

## Résultat

Le rafraîchissement initial du catalogue était planifié une seconde après la
création du routeur. Une première requête arrivant pendant cette fenêtre
déclenchait elle-même la découverte et attendait tous les appels réseau aux
fournisseurs.

La découverte commence désormais immédiatement en arrière-plan :

- elle ne retarde pas l'ouverture du serveur ;
- une requête arrivant pendant la découverte rejoint le même travail grâce au
  coordinateur existant ;
- une requête arrivant après la découverte utilise directement le catalogue
  frais ;
- les rafraîchissements périodiques restent inchangés ;
- les erreurs continuent de produire le catalogue de secours selon le
  comportement existant.

## Benchmark

Commande :

```bash
node --import tsx scripts/benchmark-model-catalog-warmup.mjs \
  --samples 50 \
  --probe-ms 20 \
  --request-after-ms 30
```

Le scénario simule une première requête 30 ms après le démarrage et une
découverte de 20 ms.

| Mesure | Délai initial de 1 s | Démarrage immédiat | Gain |
|---|---:|---:|---:|
| Première requête, médiane | 21,051 ms | 0,0004 ms | 99,998 % |
| Première requête, p95 | 21,213 ms | 0,0015 ms | 99,993 % |
| Découvertes par démarrage | 1 | 1 | identique |

Cette mesure isole uniquement la fenêtre de planification. Si la requête
arrive avant la fin de la découverte, elle attend encore la durée restante,
mais elle ne recommence pas une seconde découverte.

## Validation

Les tests de route utilisent maintenant des stores conformes à l'interface
réelle et vérifient :

- la disponibilité du modèle avant une rotation sur rate limit ;
- le stream Responses natif après préchauffage ;
- l'absence de découverte dupliquée via le coordinateur ;
- une sonde fournisseur par compte pendant l'unique découverte ;
- la conservation des réponses et diagnostics existants.

Cette modification ne change ni les tokens, ni le payload upstream, ni le
catalogue exposé. La production n'est ni modifiée ni sollicitée.
