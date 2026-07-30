# Itération de sérialisation des payloads upstream

Date : 30 juillet 2026

## Résultat

Lorsqu'un compte échouait et que le routeur essayait le suivant, chaque
tentative reconstruisait puis resérialisait l'intégralité de la fenêtre
Responses. Sur les longues tâches Codex, cette opération parcourt à nouveau
plusieurs centaines de milliers de tokens avant même l'appel réseau.

Le proxy utilise désormais un cache limité à une seule requête entrante :

- l'identité du tableau `input` représente la grande fenêtre immuable ;
- la sérialisation de tous les autres champs forme la clé de variante ;
- toute variation de modèle, outils, instructions, raisonnement, mode ou
  valeur ajoutée par le routage provoque automatiquement un miss ;
- les corps inférieurs à 64 K caractères restent sur la sérialisation directe
  et ne construisent pas de clé ;
- les payloads sans tableau `input` conservent la sérialisation directe ;
- aucun état n'est partagé entre deux requêtes clientes.

Ce mécanisme s'applique principalement aux rotations de comptes Responses
natives. Le retry du même compte réutilisait déjà la chaîne passée à
`fetchUpstreamWithRetry`.

## Benchmark

Commande :

```bash
node --import tsx scripts/benchmark-upstream-payload-serialization.mjs \
  --samples 500 \
  --items 10000 \
  --attempts 3
```

Le payload synthétique mesure 1 159 229 octets et contient 10 000 éléments
Responses stables.

| Mesure | Baseline | Cache par requête | Gain |
|---|---:|---:|---:|
| Sérialisations complètes | 3 | 1 | 66,67 % |
| Médiane | 2,350 ms | 0,788 ms | 66,48 % |
| p95 | 2,625 ms | 0,895 ms | 65,92 % |

Le gain médian absolu atteint environ 1,56 ms pour trois tentatives. Une
requête réussissant sur le premier compte ne gagne pas cette économie : elle
effectue toujours une sérialisation complète, avec seulement la petite
sérialisation de la variante en supplément lorsque le corps dépasse 64 K.
Sur le même payload long avec une seule tentative, la surcharge médiane mesurée
est de 0,004 ms ; les petits payloads n'ont pas cette surcharge.

## Équivalence et limites

Les tests vérifient :

- un hit avec le même `input` et tous les autres champs identiques ;
- un miss dès qu'un champ hors `input` change ;
- un miss pour une autre identité de tableau, même avec le même contenu ;
- le comportement direct des payloads Chat Completions ;
- l'égalité byte-for-byte des corps envoyés aux deux comptes d'une rotation.

Le tableau `input` n'est plus modifié après la préparation du payload dans le
routeur. Le cache reste néanmoins volontairement local à la requête afin de ne
jamais réutiliser une fenêtre entre deux conversations.

Cette modification ne change ni les tokens, ni le contenu upstream, ni la
réponse du modèle.
