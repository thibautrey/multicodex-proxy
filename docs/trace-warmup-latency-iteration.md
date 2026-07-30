# Itération de préchauffage des traces

Date : 30 juillet 2026

## Résultat

Le gestionnaire de traces chargeait son cache à la demande. Le premier stream
Responses devait donc attendre, avant l'appel upstream :

1. la lecture et la déduplication du journal de traces ;
2. la lecture et l'agrégation de tout l'historique statistique ;
3. l'ajout durable de son record `started`.

Le cache est désormais initialisé avant l'ouverture du port HTTP. Cette
initialisation s'exécute en parallèle avec celles des stores de comptes et
OAuth. La lecture du journal de traces et celle de l'historique statistique
sont également lancées en parallèle, puisqu'elles alimentent des structures
indépendantes.

`beginTrace` attend toujours l'ajout du record `started` sur disque. La
durabilité des streams interrompus n'est donc pas affaiblie ; seul le travail
de chargement préexistant est déplacé hors de la première requête.

## Benchmark

Commande :

```bash
node --import tsx scripts/benchmark-trace-warmup.mjs \
  --runs 20 \
  --trace-lines 1000 \
  --history-lines 20000
```

| Mesure | Initialisation paresseuse | Préchauffage | Gain |
|---|---:|---:|---:|
| Première écriture de stream, médiane | 13,125 ms | 0,308 ms | 97,65 % |
| Première écriture de stream, p95 | 16,629 ms | 0,733 ms | 95,59 % |
| Travail déplacé au démarrage, médiane | 0 ms | 12,439 ms | — |

La mesure est synthétique et utilise des fichiers locaux déjà présents dans le
cache système. Elle isole l'initialisation des traces et l'append durable ; elle
n'inclut ni le routage, ni le réseau, ni le fournisseur ou le modèle.

## Validation

Les tests vérifient :

- la création des répertoires pendant `initialize` ;
- l'écriture durable du premier record après préchauffage ;
- la finalisation sans doublon statistique ;
- la déduplication et la compaction après rechargement.

Cette modification ne change aucun endpoint, schéma de trace, token ou contenu
de réponse. Le service écoute seulement après que ses stores indispensables
sont prêts, ce qui évite qu'un healthcheck précède une initialisation encore en
cours.
