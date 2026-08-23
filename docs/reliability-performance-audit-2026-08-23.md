# Audit de fiabilite et de performance — 2026-08-23

## Verdict

Le chemin nominal est rapide et bien teste, mais le service n'est pas encore
« impossible a mettre a terre ». Les risques dominants ne viennent pas du cout
CPU normal du routage. Ils viennent de limites trop larges ou absentes, de
dependances vulnerables au deni de service, d'un historique sans retention et
d'une procedure d'arret qui peut perdre l'etat persistant.

La correction doit rester simple : borner, expirer, compacter, verifier. Il n'y
a pas besoin d'ajouter Redis, Kubernetes, une base distribuee ou un nouveau
framework.

## Ce qui a ete verifie

- compilation API et interface : reussie ;
- 126 tests TypeScript : 126 reussis ;
- benchmark local du surcout proxy, 300 requetes courtes : mediane ajoutee
  0,21 ms, p95 ajoute 0,27 ms ;
- benchmark avec 1 000 elements d'entree : mediane ajoutee 0,63 ms, p95 ajoute
  1,22 ms ;
- audit des dependances de production API : 22 alertes, dont 3 hautes ;
- audit des dependances de production web : 1 alerte haute ;
- endpoint live `/health` : repond, mais retourne une version, un commit et un
  build tous a `unknown` ;
- inspection des chemins HTTP, SSE, WebSocket, OAuth, rotation, traces,
  persistance, demarrage et arret.

CCE a ete lance avant les lectures larges, conformement aux consignes du depot.
Le serveur CCE repondait mais est reste bloque pendant la synchronisation du
snapshot ; l'analyse a donc continue avec Git, les lectures ciblees, les tests
et les benchmarks du depot.

## Risques prioritaires

| Priorite | Risque | Effet possible | Correction KISS |
|---|---|---|---|
| P0 | Corps HTTP autorises jusqu'a 500 MB dans Compose | OOM et crash avec une seule grosse requete ou quelques requetes concurrentes | Ramener la limite au besoin reel, typiquement 16–64 MB, et refuser une valeur invalide au demarrage |
| P0 | `ws` 8.20.0 est vulnerable a une exhaustion memoire ; aucun `maxPayload` applicatif n'est fixe | Crash distant du processus WebSocket | Mettre a jour `ws`, fixer `maxPayload`, fermer une connexion dont le tampon de sortie depasse un seuil |
| P0 | Compose livre `ADMIN_TOKEN=change-me` et une API proxy sans cle par defaut | Un client du reseau peut administrer/supprimer les comptes ou saturer le proxy | Refuser de demarrer en production avec un secret vide/connu ; retirer toute valeur par defaut |
| P1 | Les appels amont principaux n'ont pas de timeout dur | Requetes pendues indefiniment, accumulation de sockets et degradation jusqu'a l'indisponibilite | Un seul `UPSTREAM_TIMEOUT_MS`, un signal d'annulation sur deconnexion client et un timeout d'inactivite pour les streams |
| P1 | Le budget de retry n'est pas un vrai budget global | Un 503 persistant coute au moins 62 s par compte ; 10 comptes peuvent depasser 10 minutes | Essayer la rotation avant les longues relances et verifier une deadline absolue avant chaque tentative/sommeil |
| P1 | Les ecritures de traces et l'historique grossissent sans borne | Disque plein, demarrage de plus en plus lent, endpoint de stats lent, perte ulterieure de persistance des comptes | Garder une retention finie et des agregats horaires/journaliers compacts ; ne plus rescanner toutes les lignes pour chaque requete de stats |
| P1 | L'arret attend `server.close()` avant de vider les files d'ecriture, sans deadline | Un SSE/requete pendu peut empecher le flush avant le SIGKILL Docker | Stopper les nouvelles requetes, fermer/annuler les connexions, lancer le flush immediatement et forcer la sortie apres une deadline courte |
| P1 | La contre-pression des clients lents est ignoree sur HTTP et WebSocket | Tampons memoire croissants, event loop ralentie puis OOM | Attendre `drain` pour HTTP ; plafonner `bufferedAmount` pour WebSocket |
| P1 | Le healthcheck dit toujours `ok` apres l'initialisation | Un service sans persistance, disque plein ou amonts bloques parait sain et n'est pas redemarre | Ajouter `/ready` avec etat de persistance et un `healthcheck` Compose ; publier commit/version reels |
| P1 | Un fichier auxiliaire `codex-projects.json` corrompu bloque tout le demarrage | Proxy complet indisponible pour une fonction d'attribution non critique | Isoler ce chargement : sauvegarde `.bak`, quarantaine du fichier invalide et demarrage degrade |

## Details et preuves

### 1. Saturation memoire par les entrees

`docker-compose.yml:13` configure `REQUEST_BODY_LIMIT` a 500 MB. Le parseur JSON
conserve le tampon brut (`src/middleware/decompression.ts:43-47`), puis cree la
chaine JSON et l'objet parse. Le chemin zstd conserve aussi le corps compresse,
le corps decompresse et le resultat parse (`src/middleware/decompression.ts:80-123`).
La memoire instantanee peut donc representer plusieurs fois la taille annoncee.

Le serveur WebSocket est cree sans `maxPayload` (`src/websocket-responses.ts:421`)
et transforme chaque frame complete en chaine (`src/websocket-responses.ts:454`).
L'audit npm confirme deux avis `ws` applicables, dont une exhaustion memoire par
petits fragments.

### 2. Attentes amont sans fin et retries trop longs

Le chemin central appelle `fetchUpstreamWithRetry` sans `AbortSignal`
(`src/routes/proxy/index.ts:2235-2242`). La fonction de retry attend `fetch`
sans timeout (`src/upstream-retry.ts:57-60`). Le passthrough par defaut fait de
meme (`src/routes/proxy/index.ts:3688-3692`). Les appels OAuth n'ont pas non plus
de timeout (`src/oauth.ts:115-132`, `src/oauth.ts:179-186`).

La preparation fait un `Promise.all` de tous les comptes a preparer
(`src/routes/proxy/index.ts:1910-1926`) : un refresh OAuth bloque peut donc
retarder toutes les requetes qui tombent sur cette phase. Les refresh OpenAI ne
sont pas dedupliques, contrairement aux refresh xAI
(`src/account-utils.ts:11`, `src/account-utils.ts:46-67`). Des requetes
concurrentes peuvent ainsi utiliser plusieurs fois le meme refresh token.

Avec les valeurs par defaut, les cinq attentes exponentielles sont
2 + 4 + 8 + 16 + 32 = 62 secondes avant d'abandonner un seul compte
(`src/config.ts:111-118`, `src/upstream-retry.ts:57-85`). La limite de hang de
120 secondes n'est testee qu'apres la boucle de comptes
(`src/routes/proxy/index.ts:3551-3555`) ; elle ne borne donc ni un `fetch` bloque
ni le temps cumule des comptes.

### 3. Flux sans contre-pression ni annulation complete

Les boucles SSE ecrivent sans verifier le retour de `res.write`
(`src/routes/proxy/index.ts:2275-2284` et autres chemins de stream). Le
passthrough a le meme comportement (`src/routes/proxy/index.ts:3697-3704`). Un
client lent fait grossir le tampon de sortie en memoire.

Le pont WebSocket appelle `ws.send` sans surveiller `bufferedAmount`
(`src/websocket-responses.ts:92-97`). La fermeture du WebSocket ne supprime pas
explicitement la requete HTTP loopback en cours ni son lecteur SSE
(`src/websocket-responses.ts:381-409`, `src/websocket-responses.ts:442-485`).
La map des appels d'outils vit aussi pendant toute la connexion sans limite
(`src/websocket-responses.ts:444-445`).

### 4. Historique et cout disque sans borne

Chaque trace terminee est ajoutee a deux fichiers via des files Promise
serialisees (`src/traces.ts:1150-1163`, `src/traces.ts:1213-1227`). Le fichier
recent est compacte, mais l'historique de statistiques est append-only et n'a
pas de retention. Il est rescane integralement au demarrage
(`src/traces.ts:1055-1107`).

L'endpoint `/admin/stats/usage` rescane et collecte toutes les lignes de la
periode a chaque appel (`src/routes/admin/index.ts:638-667`). Sans borne de
periode, il charge tout l'historique. A seulement une requete par seconde, cela
represente 31,5 millions de lignes par an.

En memoire, les buckets horaires sont conserves pour toute la vie du service.
Les latences sont echantillonnees, mais `inferenceSpeeds` garde une valeur par
requete mesuree sans plafond (`src/traces.ts:843-906`). Une latence disque
prolongee peut aussi faire grossir les files Promise puisque `recordTrace` est
fire-and-forget (`src/traces.ts:1576-1591`).

### 5. Arret et durabilite

Le gestionnaire SIGTERM appelle d'abord `server.close`, puis ne vide les
ecritures que dans son callback (`src/server.ts:434-456`). Il n'existe ni
deadline, ni fermeture explicite des WebSockets, ni annulation globale des
upstreams. Un stream long ou bloque peut donc faire arriver le SIGKILL Docker
avant le flush.

Les fichiers JSON critiques sont remplaces par rename, mais sans `fsync` du
fichier et du repertoire (`src/store.ts:25-29`). Il n'existe pas de copie de
secours ni de recuperation de `accounts.json` invalide ; son `JSON.parse`
interrompt le demarrage (`src/store.ts:59-65`). Le registre Codex auxiliaire
interrompt lui aussi le demarrage sur toute erreur autre que `ENOENT`
(`src/codex-projects.ts:252-265`, appele par `src/server.ts:88-93`).

Le nettoyage des temporaires cherche les noms qui *finissent* par `.tmp-`
(`src/store.ts:32-39`), alors que les fichiers crees finissent par un UUID
(`src/store.ts:26`). Les temporaires orphelins ne sont donc jamais retires.

Le stockage est concu pour un seul processus : les etats OAuth font un cycle
read-modify-write sans verrou (`src/store.ts:273-300`) et les autres stores
n'ont pas de coordination inter-processus. Lancer deux replicas sur le meme
volume peut perdre des mises a jour. Il faut documenter et faire respecter le
mode single-writer tant que ce stockage reste fichier.

### 6. Detection et recuperation insuffisantes

`/health` renvoie toujours `{ok:true}` une fois le serveur lance
(`src/server.ts:352-359`). Il ne regarde ni `getPersistenceStatus`, ni l'espace
disque, ni les files d'ecriture. Compose n'a aucun `healthcheck`
(`docker-compose.yml:1-37`). Le service live audite repond, mais ses trois
identifiants de build sont `unknown`, ce qui complique diagnostic et rollback.

### 7. Configuration et chaine de livraison

Plusieurs nombres d'environnement acceptent `NaN` ou une valeur infinie
(`src/config.ts:3`, `src/config.ts:19-32`, `src/config.ts:107-150`). Par exemple,
un `TRACE_RETENTION_MAX` invalide desactive de fait les comparaisons de
compaction, et un `MAX_ACCOUNT_RETRY_ATTEMPTS` invalide empeche les tentatives.
La configuration doit echouer clairement au demarrage.

Le depot contient 126 tests utiles mais aucun script `test` dans `package.json`
et aucun workflow CI. Une regression peut donc etre livree sans que ces tests
soient executes. Le Dockerfile utilise `npm install` au lieu de `npm ci` et
copie tous les modules, y compris de developpement, dans l'image finale
(`Dockerfile:1-6`, `Dockerfile:25`).

L'audit npm de production remonte notamment :

- `ws` 8.20.0 : deux avis hauts, directement pertinent pour l'endpoint expose ;
- `path-to-regexp` : avis haut de ReDoS via Express ;
- `brace-expansion` : avis haut d'exhaustion CPU/memoire ;
- `body-parser` : une limite invalide peut desactiver la protection de taille ;
- OpenTelemetry/Sentry : allocation non bornee via le header Baggage ;
- interface : `lodash` avec un avis haut.

### 8. Points secondaires

- Le bundle web principal fait 648 kB minifie (181 kB gzip). Ce n'est pas un
  risque pour le proxy, seulement un premier chargement du dashboard plus lent.
- Le registre de sessions Codex n'a aucune retention et reecrit tout le JSON a
  chaque inscription (`src/codex-projects.ts:268-328`). Il finira par ralentir
  l'administration, sans etre aujourd'hui le premier risque.
- L'etat OAuth fait aussi des lectures/ecritures completes et concurrentes sans
  serialisation ; deux creations/mises a jour simultanees peuvent s'ecraser.

## Ordre de correction recommande

### Aujourd'hui

1. Mettre a jour `ws`, Express/body-parser et les lockfiles ; traiter Sentry et
   lodash dans le meme passage, sans `--force` aveugle.
2. Remplacer `ADMIN_TOKEN=change-me`, rendre la cle proxy obligatoire en
   production et limiter les corps HTTP/WebSocket au besoin reel.
3. Ajouter un timeout aux fetch amont et une deadline globale aux retries.

### Ensuite

4. Respecter la contre-pression et annuler l'amont a la deconnexion.
5. Rendre le shutdown borne et fermer les WebSockets.
6. Compacter/faire expirer l'historique, puis exposer l'etat de persistance dans
   `/ready` et le healthcheck Compose.
7. Ajouter sauvegarde/recuperation des petits JSON critiques, validation de
   configuration, `npm test`, CI et `npm ci` dans l'image.

## Criteres de sortie simples

Le proxy peut etre considere robuste quand ces tests passent :

- un upstream qui ne repond jamais produit une erreur bornee et ne laisse
  aucune ressource apres deconnexion ;
- un client HTTP/WebSocket lent ne fait pas croitre la memoire sans borne ;
- SIGTERM termine et persiste l'etat dans la deadline Docker ;
- disque plein et erreur de persistance rendent `/ready` non sain ;
- un historique volumineux n'allonge plus lineairement le demarrage ni chaque
  lecture de stats ;
- un JSON auxiliaire corrompu ne bloque pas le proxy ;
- le conteneur refuse les secrets par defaut et publie son commit reel ;
- build, 126 tests et audit de dependances s'executent automatiquement.

