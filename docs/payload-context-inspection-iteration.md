# Itération d'inspection du contexte Responses

Date : 30 juillet 2026

## Résultat

La préparation d'une requête Responses native parcourait deux fois le tableau
`input` :

1. une première fois pour détecter les images et choisir un éventuel modèle de
   surcharge ;
2. une seconde fois pour compter les éléments de compaction ajoutés aux traces.

Le proxy produit désormais ces deux résultats pendant une seule inspection.
Lorsque la normalisation conserve la même référence `input`, ce qui est le cas
du chemin Responses/Codex natif, le diagnostic initial est réutilisé après le
routage. Une rotation entre plusieurs comptes ne répète donc plus le parcours.

Les conversions Chat Completions et les payloads qui remplacent réellement
`input` continuent d'être inspectés après conversion afin que les traces
décrivent le payload upstream effectif.

## Benchmark

Commande :

```bash
node --import tsx scripts/benchmark-payload-context-inspection.mjs \
  --samples 1000 \
  --items 10000
```

Le payload synthétique contient 10 000 éléments textuels, dont un élément de
compaction.

| Mesure | Deux parcours | Parcours fusionné | Gain |
|---|---:|---:|---:|
| Médiane | 0,197 ms | 0,173 ms | 12,25 % |
| p95 | 0,282 ms | 0,257 ms | 8,72 % |
| Parcours de `input` | 2 | 1 | 50 % |

Le gain absolu isolé est d'environ 24 microsecondes sur cette machine. Il est
donc secondaire face au réseau et au modèle, mais il s'applique avant chaque
appel upstream et augmente avec le nombre d'éléments, de comptes essayés et de
candidats de routage.

## Équivalence

Les tests couvrent :

- plusieurs éléments de compaction et leur dernier index ;
- une image dans un contenu Responses ;
- une image Chat Completions ;
- un long contexte textuel sans image ;
- les tests de routage et de conversion d'images existants.

Cette modification ne change ni le payload envoyé au fournisseur, ni le modèle
sélectionné, ni les tokens, ni le contenu de la réponse.
