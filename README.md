# Les Petits Camarguais — Gestion des dossiers clients

Interface web de suivi des dossiers clients pour la cellule de crise du camping
Les Petits Camarguais. Node.js / Express devant une base Supabase (PostgreSQL).

La documentation fonctionnelle complète — modèle de données, règles métier,
procédures — est dans **[DOCUMENTATION.md](DOCUMENTATION.md)**.

> ### À paramétrer avant la mise en service
>
> L'application est dérivée de celle du Brasilia, mais les règles propres à la
> crise des Petits Camarguais ne sont pas encore écrites. Trois endroits sont
> explicitement marqués **« À PARAMÉTRER »** dans `server.js` :
>
> - `FICHIERS_ATTENDUS` et `FORM_COLUMN_MAPS` — noms des fichiers Excel attendus
>   et en-têtes exacts de leurs colonnes ;
> - `calculerDecisionClient` — correspondance entre les réponses du formulaire et
>   Annulé / Décalé. **Volontairement neutre aujourd'hui** : elle renvoie une
>   valeur vide plutôt que d'appliquer les libellés d'un autre camping, ce qui
>   produirait des décisions fausses en silence ;
> - `MODES_PAIEMENT_CARTE` — libellés du PMS valant un règlement par carte, à
>   confirmer sur les données réelles une fois le fichier maître importé.
>
> Côté interface, `FORMULAIRES` dans `public/sejours.js` décrit les questions
> posées par chaque formulaire, pour n'afficher dans la pop-in que les champs
> pertinents.

## Démarrage en local

```bash
npm install
cp .env.example .env      # puis renseigner les valeurs
npm start                 # http://localhost:3000
```

L'application refuse de démarrer si une variable d'environnement manque, et
indique laquelle.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_KEY` | clé d'API du projet (utilisée côté serveur uniquement) |
| `BASIC_AUTH_USER` | identifiant d'accès à l'application |
| `BASIC_AUTH_PASSWORD` | mot de passe d'accès à l'application |
| `PORT` | port d'écoute (défaut 3000 ; l'hébergeur le fournit en général) |

Toutes sont **obligatoires**. Aucun identifiant n'est écrit en dur dans le code :
sans ces variables, l'application s'arrête au démarrage plutôt que de tourner
avec des valeurs par défaut qui seraient publiques.

## Déploiement

Service web Node sur l'hébergeur, avec :

- **Root directory** : laisser vide — `server.js` et `package.json` sont à la
  racine du dépôt, comme pour Les Grands Pins
- **Build command** : `npm ci`
- **Start command** : `npm start`
- les cinq variables ci-dessus renseignées dans les *Environment Variables*

## Sécurité

Le navigateur ne parle jamais directement à Supabase : toutes les lectures et
écritures passent par le serveur, protégé par authentification HTTP Basic. La
clé Supabase n'est donc jamais exposée au client.

Le fichier `.env` est ignoré par Git et ne doit **jamais** être commité.

## Base de données

Le dossier `database/` contient :

- `schema.sql` — création des deux tables `master_sejours` et `choix_client` ;
- `migration_depuis_v1.sql` — reprise depuis l'ancienne application ;
- `export_relogements_02_au_05_juillet.sql` — requête d'export ponctuelle.
