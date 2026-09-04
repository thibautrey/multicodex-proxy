# Architecture actuelle de l'API et refactorisation Rust

Date : 4 septembre 2026

## Conclusion

Dans le profil natif (`MULTIVIBE_CONTROL_PLANE=true`), les chemins publics
`/v1` ne passent plus par Express. Le binaire Rust/Axum écoute sur `1455` et
termine directement l'authentification, la lecture du store, la découverte des
modèles, le routage de compte/provider, les conversions de protocole, le JSON,
le SSE, le WebSocket, les jobs, la capacité et le realtime.

Node/Express reste lancé sur `127.0.0.1:1456` comme plan de contrôle pour le
dashboard, l'administration, OAuth, la persistance métier et les tâches
existantes. L'edge Rust lui relaie uniquement les requêtes hors `/v1` qui ne
sont pas possédées par l'edge. Le profil local historique
(`MULTIVIBE_CONTROL_PLANE=false`) conserve Express pour permettre le
développement en processus unique.

Cette séparation réduit un hop HTTP local, un parsing/re-encodage JavaScript et
la présence d'objets V8 sur le chemin chaud. Elle ne prouve pas à elle seule un
gain de bout en bout : la latence du provider, les quotas, le TLS et la durée
de génération dominent souvent. La mémoire et la stabilité doivent donc être
mesurées sur une charge représentative après déploiement.

## Structure actuelle

| Couche | Emplacement | Rôle dans le profil natif |
| --- | --- | --- |
| Edge HTTP public | `rust/v1-edge/src/lib.rs` | Surface `/v1`, auth, body limit, zstd, routage, conversions et transports |
| Bootstrap edge | `rust/v1-edge/src/main.rs` | Lecture de la configuration, bind `V1_EDGE_HOST:V1_EDGE_PORT`, shutdown |
| Plan de contrôle | `src/server.ts` | Dashboard, `/admin/*`, OAuth, stores, agent, tâches et fallback hors `/v1` |
| Store partagé | `data/accounts.json` via `AccountStore` Rust/Node | Comptes, aliases, clés et politiques applicatives |
| Runtime local | `provider-agent/`, `host-application/` | Agent Go et intégration des runtimes locaux |
| Compatibilité historique | `src/routes/proxy/`, `src/realtime-proxy.ts`, `src/websocket-responses.ts` | Montée seulement dans le profil Express non natif |

Le code TypeScript peut donc rester chargé en mémoire dans le plan de contrôle,
mais il ne reçoit pas les requêtes `/v1` du port public natif. Les routeurs
Express historiques ne sont pas montés sous `/v1` lorsque le profil natif est
actif.

## Surface `/v1` possédée par Rust

| Méthode | Route | Traitement |
| --- | --- | --- |
| `GET` | `/v1/models`, `/v1/models/:id` | Catalogue statique + découverte upstream mise en cache |
| `GET` | `/v1/props` | Propriétés de compatibilité |
| `POST` | `/v1/responses`, `/v1/responses/compact` | Responses JSON/SSE et compaction |
| `POST` | `/v1/chat/completions` | Chat Completions JSON/SSE |
| `POST` | `/v1/messages` | Compatibilité Anthropic JSON/SSE |
| `GET` upgrade | `/v1/responses` | Frames WebSocket Responses |
| `POST` | `/v1/realtime/calls` | Négociation WebRTC/SDP multipart |
| `GET` | `/v1/realtime/voices`, `/v1/settings/voices` | Catalogue vocal |
| `GET` | `/v1/capacity`, `/v1/capacity/events` | Capacité et événements SSE |
| `GET`/`DELETE` | `/v1/jobs/*` | Jobs différés, événements, résultats et annulation |

Un chemin `/v1` inconnu est authentifié puis renvoie `404` depuis Rust ; il
n'est pas relégué à Express. Les compatibilités sans préfixe (`/responses`,
`/chat/completions`, `/messages`, `/models`, `/api/tags`, `/version`, `/props`)
restent disponibles via le fallback vers le plan de contrôle afin de ne pas
modifier le contrat existant hors du périmètre demandé.

## Chemin d'une requête native

```text
client :1455
  -> Rust/Axum
  -> limite de body + décompression zstd + JSON
  -> authentification et application
  -> catalogue/alias/provider/model
  -> quotas, compte bloqué, policy et session affinity facultative
  -> conversion Responses/Chat/Anthropic
  -> requête provider et rotation de compte
  -> relais JSON ou flux SSE/WebSocket
  -> trace légère et état des jobs Rust

requête hors /v1
  -> Rust/Axum
  -> Node/Express :1456 (loopback)
```

Le store est relu avec cache invalidé par la date de modification du fichier.
Le catalogue de modèles est rafraîchi sous un verrou de déduplication et sa
signature ignore les seules valeurs volatiles de quota. Les comptes découverts
sont associés au modèle via `metadata.provider_candidates` et
`metadata.account_ids`, ce qui évite de choisir un provider ou un compte qui ne
figure pas dans la découverte disponible.

La session affinity Rust est désactivée par défaut. Lorsqu'elle est activée,
la clé est `(application, session, provider)`, le TTL et la taille sont bornés,
et le compte sticky n'est consulté qu'après les filtres de quota, blocage et
policy. Un compte devenu inéligible est oublié et le failover remplace le
mapping ; une application ne peut donc pas récupérer l'affinité d'une autre.

## Parité couverte et limites explicites

Les tests Rust couvrent notamment :

- l'authentification constant-time et l'isolation par application ;
- la découverte/routage `/v1` sans requête au plan de contrôle Node ;
- la sélection quota-aware, la session affinity, son TTL, son LRU et son
  isolation application/provider ;
- les conversions outils, images, Chat Completions, Responses et Anthropic ;
- le relais SSE direct, le WebSocket authentifié et les réponses JSON ;
- la décompression zstd bornée, les jobs persistés et leurs résultats isolés.

La migration n'est pas une promesse de parité fonctionnelle absolue avec le
profil Express. Les écarts à traiter ou à accepter explicitement sont :

- les hooks JavaScript d'inférence et les politiques de modules ;
- l'admission/smart-routing avancé et les observations de capacité détaillées ;
- le refresh automatique des tokens OAuth ;
- les retries, fairness, webhooks et certains détails de reprise des jobs ;
- le stale-while-revalidate complet du catalogue et des usages ;
- la télémétrie détaillée du routeur et l'intégration de certains hooks host.

Ces fonctions restent dans Express pour le profil historique ou doivent être
portées avec un contrat propre avant d'être annoncées comme natives. Le
provider-agent Go reste également un sous-système séparé : le fait que l'edge
soit écrit en Rust ne transforme pas son runtime local.

## Performance et mémoire

Un binaire Rust peut être plus léger qu'un serveur Node sur le chemin de
traitement : pas de V8 pour le transport `/v1`, moins de conversions d'objets,
et un flux de bytes qui peut rester dans Rust. Mais la consommation totale du
conteneur inclut encore Node/Express, le dashboard, l'agent Go, les caches et
les providers. Le profil natif n'est donc pas « Rust seul ».

Les micro-benchmarks existants dans `docs/` mesurent des fonctions isolées ; ils
ne valident ni la latence provider ni la stabilité en production. La validation
à retenir pour une activation est : p50/p95/p99, débit, RSS, heap V8, mémoire
native, pauses GC, erreurs, reconnexions SSE/WebSocket et consommation CPU sur
les mêmes payloads et la même configuration.

## Configuration native

Les variables principales sont :

| Variable | Défaut | Usage |
| --- | --- | --- |
| `MULTIVIBE_CONTROL_PLANE` | `false` | Active le split Node loopback + edge Rust |
| `CONTROL_PLANE_PORT` | `1456` | Port Node interne |
| `V1_EDGE_HOST` | `0.0.0.0` | Adresse d'écoute Rust |
| `V1_EDGE_PORT` | `1455` | Port public Rust |
| `NODE_CONTROL_PLANE_URL` | `http://127.0.0.1:1456` | Fallback hors `/v1` |
| `V1_EDGE_BASE_URL` | `http://127.0.0.1:1455` | URL utilisée par les jobs du plan de contrôle |
| `V1_EDGE_INTERNAL_JOB_TOKEN` | généré par le launcher | Capability partagée pour les jobs internes |
| `MODELS_CACHE_MS` | `600000` | TTL du catalogue Rust |
| `CODEX_SESSION_AFFINITY` | `false` | Active l'affinité de session |
| `CODEX_SESSION_AFFINITY_TTL_MS` | `3600000` | TTL d'un mapping en mémoire |
| `CODEX_SESSION_AFFINITY_MAX_ENTRIES` | `10000` | Limite LRU |
| `V1_EDGE_JOBS_PATH` | `/data/v1-edge-jobs.json` en Compose | État des jobs natifs |

Compose publie uniquement `1455`. Le launcher démarre ensuite Node sur
`127.0.0.1:1456` et le binaire `/opt/multivibe/bin/multivibe-v1-edge` sur
`1455`. Le token interne est généré une seule fois par le launcher puis injecté
dans les deux processus.

## Validation locale

Depuis la racine du dépôt :

```bash
cargo fmt --all -- --check
cargo check -p multivibe-v1-edge
cargo test -p multivibe-v1-edge
npm run build:api
npm test
docker compose config
```

Pour une recette native locale, démarrer le plan de contrôle Node sur `1456`
avec `MULTIVIBE_CONTROL_PLANE=true`, puis le binaire Rust sur `1455`. La
preuve utile est une requête authentifiée `GET /v1/models` ou
`POST /v1/responses` qui atteint le provider attendu, tandis qu'un endpoint
hors `/v1` atteint le plan de contrôle loopback. Les tests d'intégration Rust
reproduisent cette séparation avec des serveurs upstream et control-plane
distincts.

## Barrière de non-régression

Avant chaque élargissement de la surface native, conserver des tests qui
vérifient :

- routes, méthodes, statuts, erreurs et limites de body ;
- choix modèle/provider/compte pour un snapshot identique ;
- outils, images, transformations et headers provider ;
- ordre et fin des événements SSE, EOF, erreur et annulation ;
- frames WebSocket et authentification de l'application ;
- isolation des credentials, prompts, réponses, jobs et affinités ;
- absence de hop Node pour les routes `/v1` du profil natif.

La mise en production doit séparer la preuve du code compilé, le démarrage des
deux processus, le comportement HTTP vivant et les mesures de charge. Un test
Rust local seul ne prouve pas la stabilité ou le gain mémoire du déploiement.
