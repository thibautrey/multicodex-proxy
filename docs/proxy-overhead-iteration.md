# Analyse de l’overhead du proxy

Date : 22 août 2026

## Résultat

Le chemin nominal reste sous quelques millisecondes d’overhead local. Deux
attentes réseau qui pouvaient ralentir une première requête ont été retirées
du chemin critique :

- une requête arrivant pendant la découverte initiale des modèles utilise le
  catalogue de secours pendant que la découverte continue en arrière-plan ;
- un compte sans snapshot d’usage peut être sélectionné avec ses valeurs
  locales par défaut pendant que sa première sonde d’usage s’exécute en
  arrière-plan.

Les endpoints d’administration continuent d’attendre un catalogue complet.
Un reset hebdomadaire programmé conserve aussi sa préparation bloquante, car
elle doit disposer d’une valeur d’usage fraîche.

## Mesure bout-en-bout locale

Commande :

```bash
node --import tsx scripts/benchmark-proxy-overhead.mjs --samples 100 --items 1
node --import tsx scripts/benchmark-proxy-overhead.mjs --samples 30 --items 10000
```

Le benchmark compare un serveur Express direct à MultiVibe, avec un upstream
simulé en mémoire et une connexion HTTP locale persistante.

| Charge | Overhead médian ajouté | Overhead p95 ajouté |
|---|---:|---:|
| requête courte | 0,18 ms | 0,23 ms |
| 10 000 éléments Responses | 3,30 ms | 3,49 ms |

La requête longue est dominée par le parsing JSON et la sérialisation du
payload ; elle reste dans l’ordre de grandeur visé. Le champ
`proxyPreparationBeforeFetchMs` mesure le temps de préparation avant l’appel
upstream et reste inférieur à 1 ms dans ces mesures.

## Limites

Cette mesure n’inclut pas le réseau, TLS, le fournisseur ni le temps de
réponse du modèle. Les taux de rafraîchissement d’usage, les quotas et le
catalogue sont donc à surveiller séparément en production via
`latencyBreakdown.preparationMs`, `usageRefresh` et `modelCatalogRefresh`.
