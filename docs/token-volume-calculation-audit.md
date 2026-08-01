# Audit du volume de tokens

Date du contrôle : 1er août 2026

## Verdict

Le calcul d’addition du snapshot committé est cohérent, mais son interprétation
temporelle est incorrecte : les **13 210 480 315 tokens d’entrée** correspondent
à un horizon de **30 jours**, pas à une tranche de 7 jours.

Le fichier source indique `horizonDays: 30` et l’audit associé parle également
des trente derniers jours. La somme des valeurs par modèle retombe exactement
sur les totaux globaux.

## Conversion correcte

Le snapshot global contient :

| Mesure | Valeur |
|---|---:|
| Tokens d’entrée bruts | 13 210 480 315 |
| Dont lus depuis le cache | 12 760 839 168 |
| Entrée non cachée observée | 449 641 147 |
| Tokens de sortie | 32 932 034 |
| Total brut entrée + sortie | 13 243 412 349 |

Les `cached_input_tokens` sont un sous-ensemble des tokens d’entrée, pas des
tokens supplémentaires. Les `reasoning_output_tokens` sont un sous-ensemble de
la sortie et ne doivent pas être ajoutés une deuxième fois.

Sur 30 jours (2 592 000 secondes), cela donne :

- **5 096,6 tokens d’entrée par seconde** ;
- **5 109,3 tokens bruts par seconde**, entrée et sortie incluses ;
- **12,7 tokens de sortie par seconde**.

Si l’on force à tort ces 13 210 480 315 tokens dans une fenêtre de 7 jours,
le résultat est **21 842,7 tokens d’entrée par seconde**, pas 27 000.
À 27 000 tokens par seconde, une semaine représenterait 16 329 600 000
tokens, et le snapshot de 13,21 milliards ne durerait que 5,66 jours.

## Contrôle sur les données locales actuelles

Une nouvelle exécution de l’analyse, avec la session courante exclue, donne
pour les 7 derniers jours :

| Mesure | Valeur |
|---|---:|
| Appels analysés | 45 230 |
| Tokens d’entrée | 6 224 175 266 |
| Tokens de sortie | 12 672 736 |
| Total brut | 6 236 848 002 |
| Débit moyen d’entrée | 10 291,3 tokens/s |
| Débit moyen de sortie | 21,0 tokens/s |

Cette mesure est un nouveau snapshot local et peut évoluer. L’outil sélectionne
les fichiers de rollout modifiés dans la fenêtre, puis additionne
`last_token_usage` pour chaque appel ; il ne somme pas le compteur cumulatif
`total_token_usage`. La sélection par date de fichier est une approximation aux
bornes de la fenêtre, mais elle ne peut pas expliquer un écart de 6 à 13
milliards.

## Conclusion opérationnelle

Le proxy ne génère donc pas 27 000 tokens de sortie par seconde. Le chiffre
élevé concerne surtout les tokens d’entrée, dont environ 96,6 % sont répétés
depuis le cache dans le snapshot historique. Pour parler de « tokens générés »,
il faut utiliser `output_tokens` ; pour parler de volume traité, il faut
utiliser `input_tokens` et préciser la fenêtre temporelle.

Reproduction :

```bash
node scripts/analyze-codex-prompt-cache.mjs \
  --sessions-dir "$HOME/.codex/sessions" \
  --days 7 \
  --exclude-session "<session-courante>"
```
