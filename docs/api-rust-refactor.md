# API actuelle et trajectoire de migration Rust

Date : 4 septembre 2026

## Conclusion

L'API reste un serveur Node.js/Express monolithique, avec un agent de runtime
séparé en Go. Deux frontières Rust sont maintenant stables : l'inspection
déterministe du payload et la classification conservatrice des frames SSE
peuvent être exécutées in-process via N-API, sans subprocess ni aller-retour
HTTP local. Le transport, le routage et les transformations restent
volontairement en TypeScript.

Le serveur est fonctionnel et bien couvert : la baseline locale sur `main`
était de 373 tests Node passants et le build TypeScript de l'API passait. La
première étape Rust ne doit donc pas remplacer tout le serveur d'un coup. Elle
doit isoler les fonctions déterministes et CPU-bound, prouver leur équivalence,
puis déplacer le transport seulement lorsque le coût de l'interopérabilité est
mesuré.

## Structure observée

| Couche | Emplacement | Responsabilité principale |
| --- | --- | --- |
| Bootstrap HTTP | `src/server.ts` | Configuration, initialisation des stores, middleware, montage des routeurs, jobs et shutdown |
| Proxy d'inférence | `src/routes/proxy/index.ts` | Sélection de compte/provider, quotas, conversions, retries, JSON/SSE, compatibilité modèles |
| Compatibilité Anthropic | `src/anthropic-compat.ts` | Messages, outils, images, usage et SSE Anthropic ↔ Responses |
| Routage différé | `src/smart-routing.ts`, `src/smart-routing-routes.ts` | Admission, capacité, alias, files de jobs, SSE de capacité |
| WebSocket | `src/websocket-responses.ts` | Upgrade `/v1/responses` et relais SSE → WebSocket |
| Realtime | `src/realtime-proxy.ts` | Négociation SDP multipart et voix |
| Persistance | `src/store.ts`, `src/jobs.ts`, `src/traces.ts` | JSON d'état, SQLite des jobs, traces JSONL et agrégats |
| Runtime local | `provider-agent/` et `host-application/` | Agent Go embarqué, détection de runtimes et exécution locale |

Les ordres de grandeur du code confirment le couplage actuel :

- `src/routes/proxy/index.ts` : environ 5 000 lignes ;
- `src/traces.ts` : environ 2 250 lignes ;
- `src/routes/admin/index.ts` : environ 2 300 lignes ;
- `src/server.ts` : environ 700 lignes ;
- 118 fichiers TypeScript sous `src`, dont 62 tests au moment de l'audit.

## Surface HTTP

| Famille | Routes principales | Transport |
| --- | --- | --- |
| Santé | `GET /health`, `HEAD /api/hello` | JSON / vide, public |
| Inference | `POST /v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/v1/messages` | JSON ou SSE |
| Compatibilité modèles | `GET /v1/models`, `/v1/models/:id`, `/api/v1/models`, `/api/tags`, `/version`, `/props` | JSON |
| Realtime | `POST /v1/realtime/calls`, `GET /v1/realtime/voices`, `/v1/settings/voices` | multipart SDP / JSON |
| WebSocket | upgrade `GET /v1/responses` | Frames Responses |
| Capacité et jobs | `GET /v1/capacity`, `/v1/capacity/events`, `/v1/jobs/*`, `DELETE /v1/jobs/*` | JSON / SSE |
| Administration | `/admin/*` | JSON, session ou token admin |
| Interface | assets statiques et fallback SPA | fichiers / HTML |

Les routes d'inférence sont aussi exposées sans préfixe `/v1` pour certaines
compatibilités. L'authentification proxy est montée avant les routeurs `/v1`
et la liste des clés applicatives détermine aussi l'attribution des traces et
l'isolation des jobs.

## Chemin d'une requête d'inférence

```text
HTTP
  -> body-parser / décompression zstd / limite de taille
  -> auth proxy + drain de mise à jour
  -> idempotence et admission smart-routing
  -> inspection du payload et découverte du catalogue
  -> préparation usage/token des comptes
  -> candidats modèle/provider + quotas + affinité de session
  -> conversion de protocole + sérialisation upstream
  -> fetch, retry et rotation de compte
  -> réponse JSON, SSE ou relais WebSocket
  -> traces, capacité observée et persistance
```

La plus grosse difficulté de la migration n'est pas le calcul local : chaque
étape dépend de snapshots mutables, de credentials, de l'état des quotas, de la
persistance et de l'annulation client. Les conversions et les flux doivent
également conserver une compatibilité octet/par événement avec les clients.

## Hotspots et preuves disponibles

Les benchmarks du dépôt sont des mesures locales synthétiques ; ils ne prouvent
pas une amélioration de la latence fournisseur ou de la latence de production.
Ils indiquent néanmoins les premiers candidats mesurables :

| Travail | Mesure existante | Lecture pour Rust |
| --- | ---: | --- |
| Overhead proxy court | médiane ajoutée 0,18 ms | garder Node tant que l'I/O domine |
| Payload Responses de 10 000 éléments | médiane ajoutée 3,30 ms | candidat si Rust reçoit les octets une seule fois |
| Détection d'image text-only | 95,76 % sur la phase isolée | bon candidat déterministe |
| Sérialisations lors d'une rotation de 3 comptes | 66,48 % d'amélioration | ne pas repayer une conversion/IPC |
| Diagnostics SSE Responses | 32,93 % d'amélioration | candidat après stabilisation du parseur SSE |
| Relais SSE → WebSocket | 28,48 % d'amélioration | conserver la granularité d'un message par événement |

Le code TypeScript contient déjà des optimisations importantes : cache de
catalogue stale-while-revalidate, déduplication des refresh d'usage, cache de
validation des modèles, sérialisation mémoïsée par requête et inspection SSE
sélective. Une réécriture Rust qui supprime ces invariants serait une
régression même si le benchmark CPU était meilleur.

## Frontières Rust posées par cette itération

`src/responses/payload-inspection.ts` contient maintenant l'inspection pure
utilisée avant le routage :

- détection des types contenant `image` dans `messages` et `input` ;
- comptage des items `compaction` ;
- conservation de l'index de la dernière compaction ;
- aucune mutation, I/O, dépendance Express ou conservation du contenu.

Le crate `rust/proxy-core` porte le même contrat sur `serde_json::Value` et
expose `inspectPayloadContextJson(Buffer)` via N-API. Le body parser appelle
cette fonction sur les octets JSON reçus et le routeur réutilise les trois
scalaires retournés. L'addon reste optionnel : une image ou une installation
qui ne l'embarque pas retombe sur TypeScript ; un hook qui remplace le payload
force également cette implémentation de référence afin de conserver le
comportement existant.

Le chemin natif est construit par `npm run build:proxy-core-native` et embarqué
par le `Dockerfile`. `npm run test:proxy-core-native` vérifie directement le
chargement N-API et toutes les fixtures communes. Cette intégration prouve le
chemin d'exécution, mais pas encore un gain de performance : le parse JSON
reste effectué par Express pour construire `req.body` et devra être déplacé ou
fusionné dans une tranche ultérieure si les mesures le justifient.

La classification des frames SSE possède maintenant une deuxième frontière
optionnelle dans `src/responses/stream-diagnostics.ts` :

- Rust reconnaît uniquement les frames mono-`data` dont le type est
  `response.output_text.delta`, `response.output_text.done`, ou une famille
  `response.reasoning*` / `response.refusal*` ;
- le seuil de 512 octets réserve l'appel N-API aux frames assez longues pour
  amortir le marshalling ; les petites frames utilisent le fast-path TypeScript
  existant ;
- les frames ambiguës, invalides, terminales, multi-`data` ou non supportées
  retombent sur le parseur JSON complet ;
- les fixtures SSE sont partagées entre les tests Rust, N-API et TypeScript.

Un micro-benchmark local de 20 000 appels par frame a donné, à titre indicatif,
un temps de 15,4 ms contre 37,3 ms pour une frame synthétique de 4,1 KiB, et
43,8 ms contre 137,2 ms pour 16,5 KiB, Rust contre TypeScript. Sur le corpus
standard de 1 283 frames, le seuil évite l'overhead mesurable du passage N-API
(environ 0,53 ms de candidate dans les deux profils). Ces mesures isolent la
classification : elles n'incluent ni décodage, ni écriture HTTP, ni réseau, ni
latence provider/modèle et ne constituent pas une promesse de performance
end-to-end.

## Trajectoire recommandée

### Phase 0 — caractérisation (réalisée)

1. Conserver la baseline Node et le build API.
2. Extraire les fonctions déterministes sans changer le contrat HTTP.
3. Maintenir des tests TypeScript et Rust sur les mêmes cas limites.
4. Ajouter des golden fixtures lorsque le contrat devient plus riche.

### Phase 1 — core Rust in-process (réalisée)

L'inspection de payload et la classification conservatrice des frames SSE sont
portées. Une première projection de protocole `chat.completion` → `response` a
été caractérisée avec des fixtures JSON partagées et une liaison N-API. Le
résultat est fonctionnel, mais le chemin objet appelé après `JSON.parse` est
plus lent que TypeScript (sur 57 491 octets : médiane 0,286 ms contre 0,157 ms,
p95 0,379 ms contre 0,260 ms). Il reste donc expérimental et désactivé par
défaut via `MULTIVIBE_PROXY_CORE_PROTOCOL_CONVERSION=on` ; la prochaine
itération doit déplacer la frontière avant le parse JSON pour supprimer le
double marshalling. Les détails sont dans
[`protocol-conversion-benchmark.json`](protocol-conversion-benchmark.json).

Cette frontière est maintenant évaluée comme une vraie tranche d'octets : Rust
reçoit le `Buffer` upstream et renvoie le `Buffer` HTTP final, JSON ou SSE,
avec uniquement les métadonnées scalaires nécessaires aux retries et aux
traces. Le routeur n'exécute plus `JSON.parse` et n'expose plus l'objet réponse
dans JavaScript lorsque cette tranche est utilisée. Le crate emploie encore un
arbre `serde_json::Value` temporaire en mémoire Rust ; cette étape supprime donc
le doublon d'objet V8 et le round-trip chaîne JSON/N-API, mais ne constitue pas
encore une preuve de parsing zero-copy.

Le repli TypeScript reste automatique pour les textes sensibles au sanitizer,
les arguments d'outils objets, les identifiants d'outils absents, les corps
non-Chat et les addons incompatibles. Le chemin direct est maintenant activé
par défaut lorsque l'addon est disponible ;
`MULTIVIBE_PROXY_CORE_PROTOCOL_CONVERSION=off` fournit le rollback explicite.
Le pont objet historique reste opt-in séparément. Le benchmark mémoire est disponible via
`npm run benchmark:raw-protocol-memory` ; il compare RSS, heap V8, mémoire
externe, buffers et mémoire retenue après GC. Les timings synthétiques restent
dans
[`raw-protocol-conversion-benchmark.json`](raw-protocol-conversion-benchmark.json)
et les résultats mémoire doivent être interprétés avec le débit, le p95, les
pauses GC et le taux d'erreur.

### Phase 2 — edge Rust

Si les mesures le justifient, faire terminer à Rust le body HTTP et le flux SSE
des routes d'inférence, avec Node conservé pour l'administration, OAuth, la
persistance et l'orchestration des providers au début. Le body doit être parsé
une seule fois ; une API Rust appelée après `express.json()` ne serait pas la
cible de performance recherchée.

### Phase 3 — état et orchestration

Évaluer séparément quota/affinité, jobs SQLite, traces et WebSocket. Ces
composants ne doivent migrer qu'avec des contrats d'annulation, de reprise,
d'isolation applicative et de shutdown documentés. Le provider-agent Go reste
un sous-système distinct tant qu'une migration de runtime n'est pas demandée.

## Barrière de non-régression

Avant chaque tranche Rust, les tests doivent au minimum vérifier :

- mêmes routes, méthodes et codes d'erreur ;
- même sélection de modèle/provider/compte pour un état identique ;
- mêmes transformations OpenAI, Anthropic et images ;
- mêmes événements SSE, ordre, usage et comportement EOF/annulation ;
- mêmes frames WebSocket et mêmes limites de buffering ;
- aucune propagation de credentials, prompt, réponse ou état entre applications ;
- aucun changement de tokens ou d'identifiants exposés sans décision explicite.

Le critère de performance final doit comparer une instance de référence et la
candidate sur des payloads représentatifs, avec p50/p95, CPU, mémoire, débit,
taux d'erreur et coût d'exploitation. Les benchmarks synthétiques présents
dans le dépôt servent de garde-fous locaux, pas de preuve de déploiement.
