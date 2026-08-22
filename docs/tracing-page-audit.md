# Audit UX de la page Tracing

## Synthèse

La page expose beaucoup de données utiles, mais les présente comme une succession de métriques, graphiques et colonnes de table. Elle répond correctement à la question « que s'est-il passé globalement ? », mais moins bien aux questions opérationnelles :

- qu'est-ce qui vient d'échouer ?
- quel projet consomme ou coûte le plus ?
- quel modèle ralentit sur une période donnée ?
- quelles requêtes expliquent un pic observé ?

La refonte devrait séparer deux modes complémentaires :

1. **Activité** — vue par défaut, chronologique et groupée par date, dédiée à l'investigation des requêtes.
2. **Analyse** — vues agrégées par projet ou par modèle, dédiées aux comparaisons.

Les filtres restent communs aux deux modes : période, projet, modèle et statut. Dans l'interface, « projet » peut être le libellé produit de la propriété technique `application`, déjà enregistrée dans les traces.

## Ce qui fonctionne déjà

- La donnée de base est riche : date, application, modèle demandé/résolu, compte, statut, latence, tokens, coût, erreur et détail JSON.
- Le stockage distingue la liste légère du détail d'une trace, ce qui convient bien à un panneau latéral chargé à la demande.
- Les statistiques historiques disposent déjà de séries horaires et d'agrégats par modèle.
- Les plages 24 h, 7 j, 30 j et historique complet constituent une bonne première base.
- Le thème clair/sombre et les fondations responsive existent déjà.

## Problèmes observés

### 1. Hiérarchie de l'information

La table des requêtes arrive après sept métriques et sept graphiques. L'utilisateur doit parcourir une page très longue avant d'atteindre l'outil principal d'investigation. Les panneaux ont tous un poids visuel proche, sans priorité claire.

**Impact : élevé.** La détection d'une erreur et l'ouverture de son détail demandent trop de navigation.

### 2. Filtres trop limités et incohérents entre API

L'interface ne filtre que la période. Pourtant `application` est déjà présente dans les traces et l'API d'usage sait déjà filtrer par application. La liste et les statistiques de traces ne filtrent pas encore par projet/application, modèle ou statut.

Le changement de période déclenche en outre un chargement explicite avec la valeur de période capturée avant le `setState`, puis un second via l'effet React. Cela crée des requêtes en double et un risque de réponse obsolète affichée après la réponse correcte.

**Impact : élevé.** Impossible d'isoler un projet ou un modèle, et la période peut momentanément produire un état incohérent.

### 3. Représentation temporelle

Les libellés de série utilisent uniquement l'heure locale (`HH:mm`). Sur 7 ou 30 jours, plusieurs jours ont donc des libellés identiques. Les agrégats restent horaires quelle que soit la plage, ce qui densifie excessivement les vues longues.

La liste n'est pas segmentée par jour : la date complète se répète sur chaque ligne et les ruptures temporelles ne sont pas perceptibles.

**Impact : élevé.** La lecture par date, explicitement recherchée, n'est pas naturelle.

### 4. Tableau de traces

Le tableau comporte dix colonnes et dépend du défilement horizontal sur les petits écrans. Route, compte et erreur occupent beaucoup de largeur alors que les signaux décisifs sont heure, projet, modèle, statut, latence, tokens et coût.

Les lignes sont cliquables à la souris mais ne sont pas des contrôles accessibles au clavier. Le statut est un nombre brut, l'erreur est toujours visible même lorsqu'elle est absente, et aucun en-tête n'est figé pendant le défilement.

**Impact : élevé sur mobile, moyen sur desktop.** Le scan visuel et l'accessibilité sont dégradés.

### 5. Détail d'une requête

Le détail s'insère dans la table et peut contenir de longs blocs JSON. Son ouverture modifie brutalement la hauteur de la liste, fait perdre le contexte et ne permet ni copie ciblée ni navigation rapide entre résumé, requête et diagnostic.

**Impact : moyen à élevé.** L'investigation d'une trace est possible, mais peu fluide.

### 6. Graphiques redondants

- « total tokens » répète visuellement la somme input + output ;
- requêtes et erreurs partagent une échelle malgré des ordres de grandeur différents ;
- usage modèle, coût modèle et volume de tokens modèle occupent trois panneaux distincts ;
- le camembert devient difficile à lire dès que les noms de modèles sont longs ;
- plusieurs couleurs de graphiques sont codées en dur et s'adaptent imparfaitement au thème sombre.

**Impact : moyen.** Beaucoup d'espace est consommé sans accélérer la décision.

### 7. Portée réelle de l'historique

Les métriques historiques sont alimentées par un historique durable, tandis que la liste et l'export détaillé utilisent la fenêtre récente conservée en mémoire/fichier, limitée par la rétention. « All time » peut donc afficher des totaux historiques sans permettre d'ouvrir les requêtes anciennes correspondantes. « Export all » signifie en pratique « exporter toute la fenêtre détaillée disponible dans la période ».

**Impact : élevé sur la confiance.** Il faut rendre la frontière de rétention explicite ou adopter un stockage interrogeable pour les détails anciens.

## Architecture d'interface proposée

### Barre de contexte persistante

Une seule barre, visible en haut de la page, pilote toutes les vues :

- période : 24 h, 7 j, 30 j, personnalisée ;
- projet : tous ou une valeur de `application`, avec « Non attribué » ;
- modèle : modèle demandé ou résolu, à préciser dans le libellé ;
- statut : tous, succès, erreurs, en cours/interrompus ;
- export de la sélection courante.

Les filtres actifs doivent être sérialisés dans l'URL afin de partager et restaurer une investigation.

### Vue Activité — par date

Vue par défaut. Elle place la liste immédiatement après quatre indicateurs compacts et un petit aperçu temporel.

- Sections « Aujourd'hui », « Hier », puis date complète.
- En-tête de jour : nombre de requêtes, erreurs, coût et tokens.
- Ligne compacte : heure, projet, modèle, statut, latence, tokens, coût.
- Route et compte deviennent des métadonnées secondaires visibles dans le détail.
- Clic ou touche Entrée : panneau latéral fixe avec Résumé, Requête, Réponse/erreur et JSON brut.
- Sur mobile : chaque trace devient une ligne à deux niveaux, sans tableau horizontal.

### Vue Projets

Tableau agrégé, triable, où chaque projet montre requêtes, erreurs, tokens, coût, p50/p95 et modèles principaux. Un clic applique le filtre projet et revient à Activité. Le projet « Non attribué » est toujours explicite.

### Vue Modèles

Même logique, centrée sur le modèle : requêtes, taux d'erreur, débit, p50/p95, tokens et coût. Le détail peut ventiler les projets qui l'utilisent. Il faut distinguer « modèle demandé » et « modèle résolu » lorsqu'un alias ou un fallback intervient.

### Groupement combiné

Pour couvrir les besoins « date et/ou projet et/ou modèle » sans créer une interface complexe, proposer un **groupement principal** dans chaque vue et un **sous-groupement optionnel** :

- Activité : Date > Projet ou Date > Modèle ;
- Projets : Projet > Modèle ;
- Modèles : Modèle > Projet.

Limiter l'imbrication à deux niveaux garde les totaux lisibles. Les filtres répondent à « quoi inclure » ; le groupement répond à « comment l'organiser ».

## Composition visuelle recommandée

1. En-tête de page compact avec titre, nombre de résultats et actualisation.
2. Barre de filtres sur une ligne desktop, repliable sur mobile.
3. Quatre métriques : requêtes, taux d'erreur, coût, latence p95. Tokens et débit restent disponibles dans les vues analytiques.
4. Un seul graphique principal, dont la métrique peut être changée entre requêtes, erreurs, coût, tokens et latence.
5. Sélecteur de vue Activité / Projets / Modèles.
6. Liste ou tableau de la vue choisie.
7. Panneau latéral de détail sans déplacement de la liste.

## Contrat API cible

Les mêmes filtres doivent être acceptés par la liste, les statistiques et l'export :

```text
GET /admin/traces
  ?cursor=
  &pageSize=50
  &sinceMs=
  &untilMs=
  &application=
  &requestedModel=
  &resolvedModel=
  &status=success|error|active|interrupted

GET /admin/stats/traces
  ?sinceMs=
  &untilMs=
  &application=
  &requestedModel=
  &resolvedModel=
  &status=
  &groupBy=hour|day,application|model

GET /admin/traces/export.zip
  # mêmes filtres que la liste
```

Une réponse `facets` peut fournir les projets, modèles et statuts disponibles dans la période avec leurs compteurs. Pour une liste qui évolue en temps réel, une pagination par curseur (`at`, `id`) est plus stable que des numéros de page dont le contenu se décale à chaque nouvelle requête.

Avant d'annoncer une navigation détaillée sur « tout l'historique », il faut choisir entre :

- exposer clairement `detailRetentionStart` et désactiver l'ouverture hors rétention ;
- ou stocker les traces détaillées dans un index requêtable, par exemple SQLite, avec index sur `(at, id)`, `application`, `requestedModel`, `resolvedModel` et `status`.

## Plan d'implémentation

### Phase 1 — gain UX sans migration de stockage

- Remonter la liste et instaurer les vues Activité / Projets / Modèles.
- Regrouper la liste récente par jour.
- Réduire les métriques à quatre et fusionner les graphiques redondants.
- Remplacer le détail inline par un panneau latéral accessible.
- Corriger les libellés temporels selon la plage.
- Corriger le double chargement lors du changement de période.
- Conserver période et vue dans l'URL.

### Phase 2 — filtres cohérents de bout en bout

- Ajouter application, modèle et statut aux endpoints liste, stats et export.
- Ajouter les facettes et les agrégats par projet.
- Faire porter chaque export exactement sur la sélection affichée.
- Ajouter des tests de contrat vérifiant que liste, totaux et export correspondent aux mêmes filtres.

### Phase 3 — historique détaillé et temps réel

- Décider et afficher la politique de rétention.
- Si nécessaire, introduire un index durable des traces détaillées.
- Passer à une pagination par curseur.
- Ajouter une actualisation automatique désactivable, sans déplacer les lignes pendant une investigation.

## Critères d'acceptation

- Une erreur récente est ouvrable en trois secondes sans défilement vertical préalable.
- Date, projet, modèle et statut produisent les mêmes résultats dans métriques, graphique, liste et export.
- Une URL copiée restaure période, filtres et vue.
- Les périodes de 7 et 30 jours montrent des libellés de date non ambigus et une granularité adaptée.
- Toutes les lignes sont accessibles au clavier et annoncent leur état ouvert/fermé.
- À 360 px, aucune navigation horizontale n'est nécessaire pour lire une trace.
- La limite de rétention du détail est visible et ne contredit jamais les totaux historiques.
