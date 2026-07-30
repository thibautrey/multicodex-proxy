# Audit de réduction des tokens de MultiVibe

Date : 30 juillet 2026
Modèle évalué : `gpt-5.6-sol`
Verdict : **ne pas activer automatiquement la compaction**

## Résumé exécutif

MultiVibe transmet déjà efficacement les longues fenêtres Codex au cache du
fournisseur, mais le cache ne réduit pas le nombre de tokens bruts traités.
L’optimisation susceptible de réduire réellement ce volume est la compaction du
contexte.

Le benchmark A/B ne valide pas son activation globale :

- économie médiane sur deux continuations : **-12,03 %** ;
- cas avec une économie réelle : **2 sur 6** ;
- meilleur cas : **39,35 %** de tokens bruts économisés ;
- pire cas : **48,76 %** de tokens supplémentaires ;
- qualité équivalente ou meilleure : **10 checkpoints sur 12** (83,3 %) ;
- erreur critique introduite par la compaction : **aucune** ;
- variation moyenne de qualité : **+0,17 point sur 4**.

La compaction produit un gain net lorsqu’une très grande fenêtre est suivie de
plusieurs continuations. Lorsqu’elle conserve presque toute la fenêtre, ou que
le contexte réellement rejoué est court, son propre appel ajoute une passe
complète et augmente la consommation.

## État du projet

### Chemin Responses/Codex

Le proxy :

- expose `/v1/responses` et `/v1/responses/compact` ;
- force `store=false` et retransmet l’élément de compaction canonique ;
- définit `prompt_cache_key` à partir du `session_id` lorsqu’il est disponible ;
- utilise par défaut `reasoning.effort=low` pour les comptes ChatGPT/Codex ;
- force actuellement `text.verbosity=medium` ;
- ne configure pas `context_management.compact_threshold` ;
- ne mesure pas `cache_write_tokens` ni le nombre d’éléments de compaction.

Une observation agrégée en lecture seule a confirmé l'utilité du cache fournisseur. Les volumes et percentiles de l'instance privée ne sont pas conservés dans le dépôt.

### Gestion actuelle des longues conversations

Les rollouts Codex locaux montrent que le client compacte déjà certaines
sessions. Sur un exemple long, l’appel de compaction a traité environ a large number of
tokens non cachés pour produire une nouvelle fenêtre d’environ a smaller number of tokens.
L’opération devient donc rentable seulement si la fenêtre réduite est réutilisée
sur suffisamment de tours.

`previous_response_id` n’est pas un levier de réduction brute : la
documentation OpenAI précise que les anciens tokens de la chaîne restent
comptabilisés. Dans le chemin WebSocket actuel, ce champ est par ailleurs
retiré avant le relais HTTP pour préserver la compatibilité existante.

## Méthode

### Isolation et confidentialité

- La production private environment n’a pas été modifiée.
- Une copie temporaire du store de comptes a été placée dans un répertoire
  `0700`, avec le fichier en `0600`.
- MultiVibe a été lancé localement sur le port 1456 avec des fichiers de trace
  temporaires et `TRACE_INCLUDE_BODY=false`.
- Aucun prompt, secret, résultat d’outil ou sortie brute du modèle n’est
  conservé dans Git.
- Les cas committés sont identifiés uniquement par un hash court et des
  métriques agrégées.

### Corpus

L’outil `scripts/audit-token-efficiency.mjs` parcourt les rollouts Codex locaux,
ignore le raisonnement et la télémétrie, reconstruit les messages et les paires
appel/résultat d’outil, puis vérifie qu’aucun appel n’est orphelin.

Le corpus gelé pour le benchmark contient dix tâches réelles. Au moment de sa
sélection, seulement trois tâches éligibles existaient entre 64k et 96k, même
après extension de la recherche à quatre-vingt-dix jours. La distribution
utilisée est donc 3/5/2 et cet écart est désormais signalé explicitement.

Le dry-run final, en excluant explicitement la tâche courante, reproduit la
sélection de dix cas sur quatre-vingt-dix jours avec la répartition 3/5/2.
La cible 4/4/2 reste donc impossible avec les traces locales actuellement
éligibles.

Une première reconstruction a révélé que les fenêtres remplacées par un
événement `compacted` devaient être instantanées plutôt que concaténées.
Vingt-deux tentatives, comprenant notamment les cas 64k–96k, ont servi à
découvrir et corriger cette limite ; elles sont exclues des résultats. Pour
respecter le plafond total, le benchmark final porte sur les six cas complets
restants et 36 appels supplémentaires, soit **58 tentatives sur 60**.

Les métriques de seuil provenant des rollouts incluent des instructions et
catalogues d’outils internes qui ne sont pas tous matérialisés sous forme de
`response_item`. Elles conviennent à l’analyse de fréquence, mais les économies
A/B sont calculées uniquement avec l’usage réellement renvoyé par le
fournisseur sur les payloads rejoués.

### Comparaison

Pour chaque cas valide :

1. la fenêtre initiale est envoyée à `/responses/compact` ;
2. deux réponses sont générées avec l’historique complet ;
3. les mêmes checkpoints sont générés depuis la sortie canonique de compaction ;
4. le coût du compactage est ajouté à la variante candidate ;
5. un jugement aveugle compare baseline, candidate et réponse historique.

Le total brut est `input_tokens + output_tokens`. Les tokens de raisonnement
sont un sous-ensemble de la sortie et ne sont pas comptés deux fois.

## Résultats

| Cas | Segment | Baseline | Avec compaction | Économie | Deltas qualité |
|---|---|---:|---:|---:|---|
| `4693d1c3e58cc102` | 96k–128k | 478 119 | 397 829 | **16,79 %** | +2, 0 |
| `9df8d59f150b99f6` | 96k–128k | 26 591 | 39 558 | **-48,76 %** | -1, 0 |
| `dfaa3ef458fb3218` | 96k–128k | 140 426 | 154 914 | **-10,32 %** | +1, 0 |
| `10cb31b104eb584f` | 96k–128k | 27 375 | 39 053 | **-42,66 %** | 0, 0 |
| `17f436dc16c3c2a3` | 128k+ | 124 293 | 141 377 | **-13,74 %** | 0, -1 |
| `fd0e00984c044017` | 128k+ | 514 900 | 312 284 | **39,35 %** | +1, 0 |

Dans le meilleur cas, les deux générations passent de 236,7k et 275,8k tokens
d’entrée à 15,9k et 55,0k. Le compactage coûte néanmoins 239,3k tokens : le
gain n’apparaît qu’après réutilisation de l’état compacté.

Dans les cas négatifs courts, l’endpoint conserve une fenêtre proche de
l’originale. Le compactage ajoute alors environ 11k à 14k tokens sans réduire
les deux appels suivants.

Les résultats complets, dépourvus de contenu utilisateur, sont disponibles dans
`docs/token-efficiency-benchmark.json`.

## Simulation des seuils

Les seuils 64k, 80k, 96k, 112k et 128k ont été simulés sur 141 checkpoints.
Aucun ne respecte la règle d’au moins huit appels par compaction :

| Seuil | Compactions | Appels par compaction | Gain théorique |
|---|---:|---:|---:|
| 64k | 41 | 3,44 | 36,90 % |
| 80k | 38 | 3,71 | 36,90 % |
| 96k | 37 | 3,81 | 36,54 % |
| 112k | 34 | 4,15 | 36,26 % |
| 128k | 20 | 7,05 | 38,28 % |

Ces gains sont théoriques et supposent un ratio de réduction dérivé des
compactions locales. L’A/B montre que l’endpoint peut conserver bien davantage
de contexte ; aucune valeur de ce balayage ne doit donc devenir une valeur par
défaut.

## Classement des techniques

### 1. Compaction explicite sur workflows très longs — utile mais opt-in

À réserver aux clients qui savent :

- qu’il reste au moins deux continuations significatives ;
- transmettre la sortie de `/responses/compact` sans la modifier ;
- supporter la latence d’une passe non cachée ;
- vérifier que l’objet retourné réduit réellement la fenêtre.

Le prochain benchmark devrait tester 160k, 192k et 224k, avec davantage de
continuations par compactage. Aucun de ces seuils n’est recommandé sans nouvelle
mesure.

### 2. Cache de prompt — conserver et mieux mesurer

Le cache est déjà très efficace sur `/responses`. Il faut préserver les préfixes
stables et `prompt_cache_key`, mais ne pas présenter `cached_tokens` comme des
tokens supprimés.

Pour GPT-5.6 et les familles ultérieures, la documentation officielle facture
les écritures de cache à 1,25 fois le tarif d'entrée non cachée. L'absence
actuelle de `cache_write_tokens` dans les traces empêche donc aussi de mesurer
le coût net réel de cette stratégie.

Ajouter lors d’une future évolution :

- `cacheWriteTokens` ;
- taux lecture/écriture du cache ;
- `effectiveUncachedTokens` ;
- segmentation par modèle, route et présence de `session_id`.

### 3. Compaction serveur automatique — ne pas activer actuellement

Une future interface pourrait rester strictement désactivée par défaut :

- `RESPONSES_COMPACTION_MODE=off|server` ;
- `RESPONSES_COMPACTION_PROVIDERS=openai` ;
- `RESPONSES_COMPACT_THRESHOLD_TOKENS=<valeur explicitement configurée>`.

L’activation devrait être limitée aux fournisseurs Responses compatibles et
exposer dans les traces :

- `compactionTriggered` ;
- `compactionItemCount` ;
- tokens avant/après ;
- nombre de réutilisations avant la compaction suivante.

### 4. Limites de sortie et verbosité — faible priorité

Les sorties `/responses` sont faibles par rapport aux entrées. Changer
globalement `text.verbosity` ou le raisonnement aurait un potentiel limité et
pourrait dégrader les résultats.

`max_output_tokens` a historiquement été retiré pour les modèles `gpt-5*` parce
que le backend Codex le rejetait. Toute réintroduction doit être testée par
backend et modèle, sans modifier le comportement global.

### 5. Résumé automatique de Chat Completions — déconseillé

Les contextes observés sont beaucoup plus petits et le proxy ne connaît pas les
invariants métier à conserver. Une synthèse automatique au niveau du routeur
introduirait un risque sémantique disproportionné.

## Décision

Les critères d’activation ne sont pas satisfaits :

- gain médian de 20 % : **non** ;
- huit cas positifs : **non** ;
- aucune erreur critique introduite : **oui** ;
- qualité équivalente ou meilleure dans 90 % des checkpoints : **non** ;
- baisse moyenne inférieure à 0,25 point : **oui**.

MultiVibe doit donc conserver son comportement actuel. La seule suite
raisonnable est une fonctionnalité de compaction explicitement opt-in pour des
workflows très longs, précédée d’un second benchmark ciblé sur des seuils
supérieurs à 128k.

## Reproduire l’audit

Le corpus brut doit rester dans un répertoire temporaire protégé :

```bash
node scripts/audit-token-efficiency.mjs corpus \
  --sessions-dir "$HOME/.codex/sessions" \
  --exclude-session "<session-courante>" \
  --output "/private/tmp/multivibe-token-audit/corpus.json" \
  --manifest docs/token-efficiency-benchmark.json
```

Puis, sur une instance isolée :

```bash
node scripts/audit-token-efficiency.mjs benchmark \
  --corpus "/private/tmp/multivibe-token-audit/corpus.json" \
  --base-url "http://127.0.0.1:1456" \
  --model "gpt-5.6-sol" \
  --max-calls 60 \
  --raw-output "/private/tmp/multivibe-token-audit/raw-results.json" \
  --aggregate docs/token-efficiency-benchmark.json
```

Références officielles :

- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
