# Audit des breakpoints de cache GPT-5.6

Date : 30 juillet 2026

Verdict : **ne pas ajouter automatiquement de breakpoint explicite**

## Résumé

Le cache de prompt est déjà très efficace sur les appels Codex locaux. Sur les
traces des trente derniers jours, après exclusion de la tâche courante :

- 73 386 enregistrements d'usage GPT-5.6 ont été analysés ;
- le ratio de lecture agrégé atteint **96,68 %** des tokens d'entrée ;
- le ratio médian par appel atteint **98,84 %** ;
- le cinquième percentile reste à **89,95 %** ;
- 746 appels éligibles sur 73 386 n'ont lu aucun token depuis le cache, soit
  **1,02 %** ;
- `cache_write_input_tokens` est présent sur 64 342 appels, mais aucune écriture
  non nulle n'est observée.

Avec les tarifs GPT-5.6, et sans confondre cette économie de coût avec une
réduction de tokens bruts, le volume observé représente environ **87,02 %**
d'économie d'entrée par rapport à un traitement entièrement non mis en cache.

Il reste possible que certaines écritures ne soient pas exposées par les
anciennes versions de la télémétrie. L'absence d'écriture observée ne prouve
donc pas qu'aucune écriture n'a jamais lieu. Elle montre en revanche qu'il
n'existe pas, dans les traces disponibles, de surcoût mesurable qu'un
breakpoint automatique permettrait de corriger.

## Mécanisme officiel

Pour GPT-5.6 et les familles suivantes, OpenAI place par défaut un breakpoint
implicite sur le dernier message utilisateur ou outil. Un breakpoint explicite
peut coexister avec ce mode implicite et marque la fin d'un préfixe réutilisable.

Dans l'API Responses, le marqueur ne peut être placé que sur un bloc
`input_text`, `input_image` ou `input_file`. Il ne peut pas être ajouté
directement au champ `instructions`.

Les écritures de cache GPT-5.6 coûtent 1,25 fois le tarif d'entrée non mise en
cache. Un marqueur explicite ne doit donc être ajouté que si le préfixe est
stable, assez long pour être éligible et réellement réutilisé.

Référence :
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Vérification du préfixe local

Le corpus sécurisé de l'audit de compaction a été reconstruit à nouveau depuis
les rollouts Codex locaux, sans la tâche courante. Le premier bloc compatible
avec un breakpoint :

- existe dans les dix cas ;
- se trouve dans le premier élément des dix cas ;
- reste strictement identique entre les deux checkpoints des dix cas ;
- contient au moins 4 096 caractères de texte dans cinq cas sur dix.

Les cinq autres cas peuvent malgré tout dépasser le minimum officiel de 1 024
tokens une fois les instructions et les outils rendus avant le bloc. Le corpus
Codex ne matérialise toutefois pas tout ce préfixe dans les `response_item`.
Le proxy ne peut donc pas prouver cette éligibilité à partir du payload
reconstruit.

Cette stabilité montre qu'un A/B explicite est techniquement plausible. Elle ne
justifie pas une activation globale : le cache implicite couvre déjà presque
toute l'entrée et un marqueur supplémentaire peut créer une écriture facturée.

## Décision d'implémentation

Aucun endpoint, schéma public, payload upstream ni comportement de production
n'est modifié.

En particulier, cette itération :

- conserve `prompt_cache_key` basé sur `session_id` ;
- conserve le mode implicite du fournisseur ;
- n'ajoute pas de `prompt_cache_options.mode=explicit` ;
- n'ajoute aucun marqueur aux blocs fournis par le client ;
- ne modifie ni la verbosité, ni le raisonnement, ni la compaction.

Ce choix évite aussi d'écraser ou de dupliquer d'éventuels breakpoints fournis
explicitement par un client.

## Limite du benchmark live

Un A/B upstream n'a pas pu être exécuté car l'environnement de validation
distant était indisponible. Aucun environnement ni store distant n'a été
modifié ou copié pendant cette itération.

Lorsque l'hôte sera de nouveau accessible, le test utile consistera à :

1. copier le store dans un répertoire temporaire `0700`, fichier `0600` ;
2. lancer une instance locale isolée avec des traces temporaires ;
3. alterner des paires avec et sans breakpoint sur le premier bloc stable ;
4. comparer `cached_tokens`, `cache_write_tokens`, le temps jusqu'aux headers
   et au premier token, ainsi que l'équivalence des sorties ;
5. refuser l'activation par défaut si les écritures augmentent ou si le gain de
   latence et de coût n'est pas mesurable.

## Reproduction

L'analyse agrégée ne persiste aucun prompt, contenu d'outil ou identifiant de
session :

```bash
node scripts/analyze-codex-prompt-cache.mjs \
  --sessions-dir "$HOME/.codex/sessions" \
  --days 30 \
  --exclude-session "<session-courante>" \
  --output docs/prompt-cache-breakpoint-benchmark.json
```

Pour reproduire également la vérification structurelle, générer le corpus brut
dans un répertoire temporaire protégé, puis le fournir avec `--corpus`. Le
fichier brut ne doit jamais être ajouté à Git :

```bash
node scripts/audit-token-efficiency.mjs corpus \
  --sessions-dir "$HOME/.codex/sessions" \
  --exclude-session "<session-courante>" \
  --output "/private/tmp/multivibe-cache-audit/corpus.json" \
  --manifest "/private/tmp/multivibe-cache-audit/manifest.json"

node scripts/analyze-codex-prompt-cache.mjs \
  --sessions-dir "$HOME/.codex/sessions" \
  --days 30 \
  --exclude-session "<session-courante>" \
  --corpus "/private/tmp/multivibe-cache-audit/corpus.json" \
  --output docs/prompt-cache-breakpoint-benchmark.json
```

Les résultats agrégés sont disponibles dans
`docs/prompt-cache-breakpoint-benchmark.json`.
