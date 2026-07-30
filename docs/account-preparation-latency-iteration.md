# Itération de préparation des comptes

Date : 30 juillet 2026

## Résultat

Le proxy ne réinsère plus tous les comptes actifs dans le store lorsque leurs
tokens et leurs snapshots d'usage sont déjà frais.

Le chemin précédent, pour chaque requête :

- appelait les deux fonctions asynchrones de validation de token et d'usage
  pour chaque compte actif ;
- marquait chaque compte comme modifié après la validation du token, même sans
  changement ;
- le marquait une seconde fois pour un snapshot d'usage frais ;
- appelait la vérification de reset hebdomadaire pour chaque compte OpenAI,
  même lorsqu'aucun reset n'était programmé.

Le nouveau chemin détecte d'abord de façon synchrone si un compte exige
réellement une préparation. Le chemin asynchrone n'est utilisé que pour :

- un token OpenAI arrivé dans sa fenêtre de rafraîchissement ;
- un snapshot d'usage absent ou périmé ;
- un reset hebdomadaire effectivement programmé.

Un compte n'est marqué comme modifié que lorsqu'un nouvel objet de token ou
d'usage a réellement été produit.

## Préservation des erreurs OAuth

L'échec de rafraîchissement OAuth mutait auparavant directement l'objet issu du
store. Il retourne désormais une copie contenant `needsTokenRefresh`,
`lastError` et `recentErrors`. Le routeur reconnaît cette nouvelle référence et
la persiste, sans modifier silencieusement le snapshot original.

Les rafraîchissements OAuth réussis, les erreurs OAuth et les rafraîchissements
d'usage bloquants restent donc persistés. Les actualisations d'usage en
arrière-plan continuent d'utiliser `patchAccount`.

## Benchmark local

Le benchmark synthétique utilise 64 comptes dont les tokens et l'usage sont
frais, sur 5 000 paires :

| Variante | Médiane | p95 | Mutations par requête |
|---|---:|---:|---:|
| Baseline | 0,0208 ms | 0,0284 ms | 128 |
| Fast path | 0,0052 ms | 0,0056 ms | 0 |

La réduction médiane de cette phase isolée est de **74,95 %**, soit environ
0,016 ms dans ce scénario. Le gain absolu est volontairement présenté : cette
itération améliore surtout le comportement sous de nombreux comptes et réduit
le churn interne ; elle ne prétend pas modifier sensiblement la latence du
modèle.

Cette itération ne change aucun token, payload upstream ou résultat généré.

Les traces exposent `accountPreparation.skipped` et
`accountPreparation.asynchronous` afin de mesurer la proportion réelle de
comptes empruntant le fast path.

## Reproduction

```bash
node --import tsx scripts/benchmark-account-preparation.mjs \
  --samples 5000 \
  --accounts 64
```

Les résultats agrégés sont conservés dans
`docs/account-preparation-latency-benchmark.json`.
