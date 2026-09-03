# Audit du système de cache — 2026-08-23

## Verdict

Le projet bénéficie déjà fortement du **prompt caching fournisseur** sur le
trafic agentique `Responses`. Il ne faut pas ajouter maintenant un cache
sémantique global ni un cache transparent de toutes les réponses : les appels
observés sont majoritairement conversationnels, streamés, munis d'outils et
potentiellement non déterministes. Une réponse « proche » ou ancienne peut
déclencher le mauvais outil, restituer un état obsolète ou traverser une
frontière d'application.

La trajectoire recommandée est progressive :

1. conserver et mieux mesurer le prompt caching fournisseur ;
2. ajouter des empreintes HMAC de requête, sans contenu, pour mesurer les
   doublons exacts pendant au moins sept jours ;
3. introduire une idempotence explicite et un single-flight pour les retries
   non streamés ;
4. compléter les caches de métadonnées HTTP et les agrégats d'administration ;
5. n'activer ensuite un cache exact de réponse que par opt-in, sur les classes
   de requêtes démontrées sûres et rentables ;
6. réserver le cache sémantique à une future application FAQ/RAG avec ses
   propres évaluations, namespaces et règles de fraîcheur.

Avec le déploiement actuel à un seul processus, un cache mémoire borné suffit
pour la première version. Redis n'est justifié que si plusieurs réplicas
doivent partager les clés d'idempotence ou si un cas d'usage sémantique dédié
est validé.

## Périmètre et méthode

L'audit couvre le commit `5a8361b`, les chemins HTTP/SSE/WebSocket, la
découverte de modèles, le rafraîchissement des quotas, les traces et les routes
d'administration. Le trafic live a été lu via les endpoints d'administration
d'une instance privée, sans rejouer de requête vers un fournisseur et sans
extraire de prompt.

L'interface graphique n'était pas disponible dans le navigateur interne de la
session. Les endpoints utilisés par cette interface ont toutefois fourni les
agrégats et les traces structurées nécessaires. `TRACE_INCLUDE_BODY` est
désactivé sur les traces observées : c'est une bonne propriété de sécurité,
mais cela empêche de calculer rétroactivement le taux de doublons exacts.

CCE a été lancé avant les lectures larges. Le serveur répondait, mais la
synchronisation du snapshot est restée bloquée ; l'analyse a continué avec les
lectures ciblées, Git et les endpoints live.

## Observation agrégée

Les statistiques exactes et les constats de configuration de l'instance observée ne sont pas conservés dans le dépôt.

## Ce qui existe déjà

| Couche | Implémentation | Évaluation |
|---|---|---|
| Prompt cache OpenAI | `prompt_cache_key` reçoit le `session_id` si le client n'en fournit pas | Très efficace ; à conserver |
| Catalogue de modèles | TTL `MODELS_CACHE_MS`, stale-while-revalidate, catalogue de secours, refresh single-flight | Bonne base ; ajouter ETag/cache HTTP |
| Validation de modèles | `Set` reconstruits toutes les 60 s | Adapté et borné |
| Usage/quota | snapshot stale-while-revalidate et déduplication par compte/base URL | Bonne base |
| Refresh OAuth | déduplication des refresh concurrents par compte | Bonne base |
| Stats d'administration | cache mémoire 30 s, 50 variantes maximum | Borné, mais masque seulement le rescan de l'historique |
| Sérialisation upstream | mémoïsation par identité d'objet et variante | Optimisation locale sûre |
| Réponses LLM | aucun cache | Décision saine tant que l'éligibilité n'est pas connue |

Le principal défaut des caches existants n'est pas leur algorithme, mais leur
observabilité : aucun métrique homogène `hit/miss/stale/refresh/error`, aucune
taille en octets et aucune indication de raison d'inéligibilité.

## Techniques actuelles et adéquation au projet

### 1. Prompt/prefix caching fournisseur — recommandé

Le fournisseur réutilise le calcul du préfixe commun sans réutiliser la réponse
finale. C'est le bon mécanisme pour les longues conversations : il conserve la
fraîcheur du raisonnement et des outils tout en réduisant le coût du contexte.

La documentation OpenAI actuelle recommande une clé stable pour les requêtes
qui partagent réellement un préfixe, avec partition stable au-delà d'environ
15 requêtes par minute par clé. GPT-5.6 prend aussi en charge des breakpoints
explicites ; leurs écritures valent 1,25 fois le tarif d'entrée non cachée.
Compte tenu des ratios live déjà élevés et de l'absence d'écritures mesurées,
il ne faut pas ajouter de breakpoint explicite global. Il faut journaliser les
lectures et écritures par modèle, clé anonymisée et classe de requête, puis
tester un breakpoint seulement par A/B.

### 2. Cache exact de réponse — utile, mais opt-in

Une clé exacte est sûre uniquement si elle inclut tout ce qui peut modifier la
sortie : contrat de route, payload canonique, modèle résolu, fournisseur,
paramètres de génération, outils et schémas, version des conversions du proxy,
scope applicatif et version de politique. Il faut aussi distinguer une réponse
JSON d'une restitution SSE.

Ce cache convient aux extractions, classifications, traductions et contenus
statiques dont le client accepte explicitement la réutilisation. Il ne doit pas
couvrir par défaut :

- les appels avec outils, recherche web, MCP, fichiers, images ou audio ;
- les conversations et requêtes qui dépendent d'un état externe ;
- les sorties non déterministes ou sensibles au temps ;
- les réponses avec raisonnement chiffré, identifiants d'événements ou appels
  d'outils à rejouer ;
- les erreurs, réponses partielles ou flux interrompus ;
- les requêtes sans application/API key attribuée.

### 3. Idempotence et request coalescing — priorité élevée

L'idempotence répond mieux que le cache transparent au cas des retries. Le
client fournit une `Idempotency-Key`; le proxy la namespace par application et
route, conserve le hash du payload, partage une exécution en cours et rejoue le
résultat terminé pendant un TTL court. La réutilisation de la même clé avec un
payload différent doit produire `409`.

La première version doit viser les appels non streamés. Les followers d'un SSE
nécessitent un buffer borné, une gestion indépendante des déconnexions et la
régénération de certains identifiants ; ce surcroît de complexité n'est pas
justifié avant mesure.

### 4. Cache sémantique — non recommandé au niveau du proxy

Les solutions modernes utilisent un embedding, une recherche KNN/range, des
filtres de métadonnées et un seuil pour réutiliser une réponse à une question
similaire. Redis documente ce modèle avec recherche vectorielle et LangCache.
Il est pertinent pour une FAQ ou un RAG dont les réponses sont bornées,
évaluables, versionnées et munies de règles de fraîcheur.

Il est dangereux dans un proxy générique : la similarité linguistique ne
garantit ni la même intention, ni les mêmes permissions, ni le même état des
outils. Le seuil est un compromis métier, pas une preuve d'équivalence. Un tel
cache exigerait au minimum un namespace par tenant/application/modèle/version
de connaissances, des filtres de langue et de politique, un TTL, une
invalidation sur mise à jour des sources, des évaluations de faux positifs et
un mécanisme de bypass. Ce n'est pas le profil du trafic observé.

### 5. KV cache d'un moteur d'inférence — hors périmètre

Paged attention, prefix trees, cache KV distribué et routage cache-aware sont
des techniques de serving pour les opérateurs qui hébergent les poids du
modèle. MultiVibe appelle des fournisseurs distants : il ne possède pas leurs
tenseurs KV. Le prompt caching fournisseur est l'interface pertinente.

## Architecture cible KISS

### Phase 0 — mesurer avant de stocker

Ajouter à chaque trace des champs sans contenu :

- `requestFingerprint`: HMAC-SHA-256 d'une représentation canonique ;
- `cacheEligibility` et une raison stable (`tools`, `stream`, `stateful`,
  `unattributed`, `oversize`, etc.) ;
- `cacheLayer`, `cacheStatus`, `cacheAgeMs`, `coalesced` et
  `upstreamRequestSaved` ;
- taille estimée de l'entrée et de la réponse en octets ;
- version de l'algorithme de canonicalisation.

L'empreinte doit être un HMAC avec un secret distinct et rotatable, jamais un
hash brut d'un prompt potentiellement devinable. Elle doit rester strictement
scopée à l'application avant toute comparaison. Aucun corps ne doit être ajouté
aux traces. Conserver sept jours de compteurs agrégés suffit pour calculer les
taux de répétition à 1, 5, 30 minutes et 24 heures.

### Phase 1 — gains sûrs

1. Ajouter `ETag` et `Cache-Control` aux GET publics de modèles ; utiliser
   `public, max-age` court et `stale-while-revalidate` pour le catalogue.
2. Servir les assets Vite hashés avec `immutable`; garder `index.html` en
   `no-cache`.
3. Remplacer le rescan de l'historique pour les stats par les buckets déjà
   agrégés/compactés ; le cache 30 s reste une protection secondaire.
4. Uniformiser les métriques des caches existants et exposer leur taille.
5. Ajouter `Idempotency-Key` avec single-flight et rétention courte sur les
   réponses JSON non streamées, avec isolation par application.

### Phase 2 — cache exact expérimental

Après sept jours de télémétrie, activer derrière un flag et un opt-in explicite
un LRU mémoire pondéré par octets :

- TTL initial : 60 à 300 secondes ;
- limite globale : choisie à partir du budget mémoire du conteneur, jamais un
  nombre d'entrées seul ;
- limite par entrée : 1 à 2 MiB ;
- uniquement les statuts 2xx terminés et validés ;
- namespace : application, route, modèle résolu, fournisseur et version du
  proxy ;
- `Cache-Control: private`, `Vary` adapté, `Age` et en-tête diagnostic ;
- bypass explicite et invalidation totale à chaque changement incompatible de
  routage, alias ou conversion ;
- interdiction des secrets, headers d'authentification et identifiants de
  compte dans la valeur persistée.

Une clé possible est :

```text
HMAC(secret,
  version || application || route || provider || resolved_model ||
  canonical_payload || response_contract_version)
```

La canonicalisation doit être déterministe et testée par golden files. Retirer
aveuglément des champs « supposés non sémantiques » est interdit : une whitelist
versionnée est plus sûre.

### Phase 3 — décision Redis ou cache sémantique

Ajouter Redis seulement si l'un de ces critères apparaît : plusieurs replicas,
besoin d'idempotence après redémarrage, volume dépassant le budget mémoire, ou
service FAQ/RAG sémantique validé. Avant cela, Redis ajoute une dépendance, une
politique d'éviction, une surface de panne et une frontière de confidentialité
sans bénéfice démontré.

## Expérience de décision

Pendant sept jours, produire pour chaque classe `(application, route, modèle,
stream, outils, multimodal)` :

- répétitions exactes dans les fenêtres 1/5/30 min et 24 h ;
- doublons concurrents et retries partageant une clé d'idempotence ;
- coût et latence évitables théoriques ;
- distribution de taille des réponses ;
- taux de cache fournisseur, écritures et économie nette ;
- cardinalité et mémoire projetée pour plusieurs TTL.

Go/no-go proposé pour le cache exact : au moins 5 % de hits sur une classe
sûre, économie mesurable, p95 amélioré, aucune fuite inter-application, aucune
divergence de contrat et mémoire sous le budget. Sinon, conserver uniquement
l'idempotence et les caches de métadonnées.

Pour un futur cache sémantique, les critères doivent être plus stricts : corpus
de questions représentatif, validation humaine des faux positifs, fraîcheur
testée après changement des sources, taux d'erreur métier sous le seuil défini
par le produit et kill switch immédiat.

## Tests indispensables

- deux payloads JSON équivalents produisent la même clé ; toute différence
  sémantique produit une autre clé ;
- même payload, applications ou fournisseurs différents : jamais de hit ;
- une `Idempotency-Key` réutilisée avec un autre payload retourne `409` ;
- aucun résultat partiel, erreur, tool call ou flux abandonné n'est mis en
  cache ;
- expiration, éviction pondérée et invalidation d'alias sont déterministes ;
- un cache indisponible échoue ouvert vers l'upstream, sauf conflit
  d'idempotence ;
- les traces ne contiennent ni prompt, ni réponse, ni secret de HMAC ;
- le pic mémoire reste borné avec grosses réponses et clients lents ;
- les réponses hit/miss restent compatibles OpenAI, y compris usage et
  headers documentés.

## Références

- [OpenAI API deployment checklist — prompt caching](https://developers.openai.com/api/docs/guides/deployment-checklist)
- [Redis for AI and search — vector search and semantic caching](https://redis.io/docs/latest/develop/ai/)
- Audit local précédent : `docs/prompt-cache-breakpoint-audit.md`
- Audit local précédent : `docs/reliability-performance-audit-2026-08-23.md`
