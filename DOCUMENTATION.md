# Outil de traitement des dossiers — Yelloh! Village Les Petits Camarguais

Application de gestion de crise du camping Les Petits Camarguais, suite aux
dégâts causés par la pluie et le vent dans la nuit du 6 au 7 octobre 2026.

> **Application en cours de mise en place.** La base est créée et vide, le code
> est dérivé de celui du Brasilia, mais **les règles propres à cette crise ne
> sont pas encore écrites**. Les points concernés sont marqués « À PARAMÉTRER »
> dans le code et listés au §6. Tant qu'ils ne sont pas traités, l'outil refuse
> les imports et laisse la décision client vide — c'est volontaire.

---

## 1. À quoi sert l'outil

Des formulaires sont envoyés aux clients concernés par la crise. Leurs réponses
arrivent sous forme de fichiers Excel, qu'il faut rapprocher des séjours du
fichier maître du siège pour savoir qui rembourser, comment, et combien.

L'outil répond à trois besoins :

- **importer** les réponses aux formulaires et les rattacher automatiquement au
  bon séjour ;
- **déduire** ce qui peut l'être — méthode de remboursement, décision du client —
  sans jamais trancher à la place du camping quand l'information est douteuse ;
- **suivre** l'avancement dossier par dossier, avec filtres et export.

---

## 2. Architecture

| | |
|---|---|
| Serveur | Node.js + Express (`server.js`, fichier unique) |
| Base | PostgreSQL hébergé sur Supabase, via `@supabase/supabase-js` |
| Front | HTML / CSS / JavaScript sans framework, dans `public/` |
| Lecture Excel | SheetJS (`xlsx`), fichiers reçus en mémoire via `multer` |
| Hébergement | Render, déploiement par push sur la branche principale |
| Accès | Basic Auth sur toutes les routes, identifiants dans `.env` |

Le navigateur ne parle **jamais** directement à Supabase : toutes les requêtes
passent par le serveur, qui seul détient la clé. C'est la raison pour laquelle
RLS est désactivé sur les tables.

Aucune URL ni aucun identifiant n'est écrit en dur dans le code. Sans les
variables d'environnement, l'application s'arrête au démarrage en indiquant
laquelle manque, plutôt que de tourner sur des valeurs par défaut.

### Deux bases, et des garde-fous qui les séparent

| | Production | Recette |
|---|---|---|
| Projet Supabase | `cjuchlfenmbskdhgvaet` | `ukmbeelgcimrhxcvoiya` |
| Qui l'utilise | le camping, en continu | les suites de tests |
| Ce qui y écrit | l'application déployée sur Render | les suites, et elles seules |

Tant que le camping n'avait rien saisi, les suites de recette tournaient contre
la production : elles photographiaient avant, restauraient après, et la base
revenait à son état. Dès lors que des dossiers réels sont traités, ce n'est plus
tenable — une suite interrompue en plein vol laisserait des valeurs de test
visibles à l'écran.

`scripts/cibles.js` porte les deux adresses et les deux garde-fous :

- `exigerRecette()` — appelé par les six suites de tests. Si la cible est la
  production, le script s'arrête avant d'avoir ouvert la moindre connexion. Il
  refuse également une base inconnue, pour qu'une faute de frappe ne passe pas.
- `exigerProd()` — appelé par `import_master.js`, `diff_master.js` et
  `update_master.js`, qui alimentent légitimement la production. Ces trois-là ne
  lisent plus le `.env` : ils nomment leur cible, pour qu'un import ne puisse pas
  tomber silencieusement dans la recette.

**Le garde-fou est la première instruction de chaque suite**, placée avant le
moindre `require`. Une dépendance manquante ferait sinon échouer le script
*avant* la vérification de la cible : on croirait à un simple plantage, alors
qu'on visait peut-être la production.

### Rafraîchir la base de recette

`node scripts/copier_prod_vers_recette.js` — simulation par défaut, `--ecrire`
pour appliquer. La production n'est que lue, la recette est vidée puis
recopiée : c'est un rafraîchissement, pas une fusion. Les identifiants sont
conservés, sans quoi le lien `id_choix_client` entre un séjour et sa réponse ne
voudrait plus rien dire. Le script compare ensuite les deux bases ligne à ligne.

Après copie, **recaler les séquences**, sans quoi la première insertion
repartirait de 1 et violerait la clé primaire :

```sql
select setval(pg_get_serial_sequence('public.master_sejours','id'), (select max(id) from public.master_sejours)),
       setval(pg_get_serial_sequence('public.choix_client','id'),   (select max(id) from public.choix_client));
```

`scripts/empreinte_recette.js` donne une empreinte MD5 des deux tables : la
relever avant et après un passage de recette prouve que les suites ont bien
tout restauré.

## 3. Les deux tables

### `master_sejours` — le référentiel des séjours

Une ligne = une réservation, importée depuis le fichier maître du siège. La
structure suit le **référentiel commun multi-camping**, partagé avec Les Grands
Pins et Le Brasilia : c'est ce qui permet de maintenir une seule base de code.

**Colonnes alimentées par l'outil, pas par le fichier source :**

| Colonne | Contenu | Alimentée par |
|---|---|---|
| `id_choix_client` | lien vers la réponse au formulaire | rapprochement automatique |
| `methode_remboursement` | Carte / Virement / BAV / À vérifier | calcul au rapprochement (§5) |
| `decision_client` | Annulé / Décalé | calcul au rapprochement (§5) |
| `remboursement` | Oui / Non / Partiel | saisie du camping |
| `commentaire_remboursement` | mémo justifiant un remboursement | saisie du camping |
| `action_camping` | A rappeler | saisie du camping |
| `commentaire_camping` | motif du rappel | saisie du camping |

**Colonnes en lecture seule**, calculées par le siège : `montant_ht_nuit` et
`calcul_rbs_nuits_non_consommees`. Ni modifiables dans la fiche, ni acceptées par
l'API.

> ⚠️ `calcul_rbs_nuits_non_consommees` s'est révélée **peu fiable** sur les
> campings précédents : le siège la calcule comme si aucun client ne revenait,
> et elle donne parfois plus de nuits que n'en compte le séjour. Ne pas s'en
> servir pour un calcul financier sans contrôle.

#### `quartier`

Village, Aquabulle, Port, Perso. Le quartier recoupe les préfixes de numéro
d'emplacement, et c'est **la colonne décisive de cette crise** : le sinistre
touche le quartier Aquabulle, pas le camping entier. 304 séjours y sont
rattachés. Donnée d'origine camping, **en lecture seule** dans la fiche.

| Quartier | Séjours |
|---|---|
| Village | 412 |
| Aquabulle | 304 |
| Port | 300 |
| Perso | 2 |

#### Pas de colonne de présence

Le fichier maître porte bien une colonne « Présents28 », mais c'est un reliquat
du modèle des Grands Pins : elle est entièrement vide, comme « NoShow ». Aucune
colonne n'a donc été créée. Si le siège fournit un jour un indicateur de
présence au jour de l'incident, il suffira de l'ajouter.

#### `statut_emplacement` et le relogement

Prévus dès l'origine, vides pour l'instant. Au Brasilia il a fallu les ajouter
après coup, dans l'urgence, en reprenant une table de leur ancienne application.
Quatre colonnes nullables créées d'avance ne coûtent rien.

- `statut_emplacement` : OK / KO / ?, constat terrain fourni par le camping dans
  un fichier à part. **En lecture seule** dans la fiche.
- `date_entree_relogement`, `date_sortie_relogement`, `camping_relogement` : le
  résumé du relogement.
- `relogements_detail` : la liste complète, un relogement par ligne, pour qu'aucun
  ne soit perdu quand un client en a eu plusieurs.

#### Le suivi du dossier : quatre colonnes

Propres à cette crise, et le cœur du travail quotidien du camping.

- `relogement_statut` : À reloger / Relogé / Refusé par le client.
- `relogement_hebergement` : où le client a été réinstallé, en texte libre.
- `remise_statut` : À appliquer / Appliquée.
- `remise_taux` : 20 par défaut, modifiable au cas par cas.

**Les deux étapes sont volontairement indépendantes.** Le camping reloge d'abord,
souvent le jour même ; la remise se traite bien plus tard, parfois à la
facturation. Un statut unique d'avancement aurait forcé à choisir laquelle des
deux il décrit, et aurait rendu invisible le dossier relogé dont la remise traîne
— exactement celui qu'il faut retrouver. Vide signifie « pas encore traité », et
c'est la valeur de départ : les deux filtres correspondants sont donc les deux
listes de travail du camping.

#### `situation` et `situation_desc`

Situation du client au moment de l'incident, telle que la voit le PMS :
**Réservation ferme** (904), **Check-in** (104, sur place) et **Check-out** (10,
reparti). À ne pas confondre avec `statut_client`, qui est le segment de mailing
du siège. Les deux se recoupent très largement, et leurs rares désaccords sont
des anomalies de saisie à faire trancher par le camping, pas des cas métier.

### `choix_client` — les réponses au formulaire

**Un seul formulaire pour cette crise**, déposé sous le nom `relogement.xlsx`
(ou `.xls`). Il alimente `id_f1` ; `id_f2` et `id_f3` existent en base mais
restent vides, le schéma étant commun à tous les campings.

Deux réponses possibles à « Que souhaitez-vous faire ? » :

| Réponse du client | `decision_client` |
|---|---|
| « Je souhaite annuler et je demande le remboursement des sommes versées » | **Annulé** |
| « Je souhaite maintenir mon séjour avec une remise de 20% et être relogé dans un hébergement de la même gamme, sans frais supplémentaires. » | **Relogement + remise** |

Il n'y a **pas de valeur « Décalé »** ici, contrairement aux Grands Pins et au
Brasilia : aucune date ne bouge, le client qui reste garde son séjour et change
seulement d'hébergement.

Les questions sur le mode de règlement et les coordonnées bancaires ne
s'affichent que pour qui annule, et seulement si le règlement n'a pas été fait
intégralement par carte. Elles restent donc vides pour les autres, ce qui est
normal.

> Deux pièges relevés sur le fichier réel, tous deux absorbés par le code :
> l'intitulé de l'email est devenu « Email ayant servi à faire la réservation »,
> et la question sur le mode de règlement porte **un espace en fin
> d'intitulé**. La résolution des en-têtes normalise les espaces avant de
> comparer, et tolère un libellé tronqué.


Une ligne = une réponse. Trois colonnes d'identifiant — `id_f1`, `id_f2`,
`id_f3` — dont **une seule est renseignée** : c'est elle qui dit de quel
formulaire vient la réponse, et elle sert au calcul du delta à l'import.

Les colonnes de questions que le dispositif n'utilisera pas resteront vides.
Elles existent quand même, pour garder un schéma identique d'un camping à
l'autre.

---

## 4. Attention : trois notions de « statut » différentes

C'est le principal piège de l'outil. Trois colonnes portent un nom voisin et ne
veulent pas dire la même chose.

| Colonne | Qui la remplit | Ce qu'elle dit |
|---|---|---|
| `master_sejours.statut_client` | le siège, via le fichier maître | situation du client dans la crise |
| `choix_client.statut` | l'outil, à l'import | **A répondu** si la réponse a trouvé son séjour, **Match incorrect** sinon |
| `master_sejours.action_camping` | le camping, à la main | **A rappeler** : client à ne pas oublier |

« Match incorrect » est un problème technique de rapprochement pour le call
center ; « A rappeler » est un pense-bête métier du camping. L'onglet Match
incorrect a vocation à rester vide.

---

## 5. Les règles métier

### Rapprochement d'une réponse avec un séjour

À l'import, et à chaque modification manuelle d'une réponse :

1. recherche par **numéro de réservation** (insensible à la casse) ;
2. à défaut, recherche par **email**, retenue seulement si elle désigne **une
   seule** ligne de `master_sejours` ;
3. si rien n'est trouvé, la réponse passe en **Match incorrect**.

Si un client répond deux fois, **la dernière réponse traitée l'emporte** : un
client qui répond à nouveau change généralement d'avis. Les réponses précédentes
restent en base, consultables, mais ne sont plus rattachées au séjour.

### Méthode de remboursement

Calculée **uniquement pour les séjours rattachés à une réponse** : sans réponse,
il n'y a rien à croiser avec le PMS, et la colonne reste vide.

1. le client veut un **bon à valoir** → `BAV`, quel que soit le mode de paiement ;
2. aucun paiement enregistré au PMS → `À vérifier` ;
3. le client n'a pas indiqué son mode de règlement → `À vérifier` ;
4. les deux sources se **contredisent** → `À vérifier` ;
5. les deux sources sont d'accord → `Carte` si tout a été réglé par carte,
   `Virement` sinon.

On ne rembourse sur la carte que si le séjour a été réglé **uniquement** par
carte. Un seul paiement d'un autre type suffit à basculer en virement.

##### Comment la carte est reconnue ici

Par **motif**, pas par liste exacte : le PMS de ce camping suffixe ses libellés
du lieu d'encaissement — « CB SANS CONTACT VILLAGE PORT », « CB accueil LPX »,
« CB accueil SDC ». Une liste figée laisserait passer la prochaine caisse
ouverte, et le dossier basculerait en virement sans que personne ne le voie.

| Vaut carte | Ne vaut pas carte |
|---|---|
| `VENTE A DISTANCE…` (1554 lignes) | VIREMENT BANCAIRE (89) |
| `CB …` (15 lignes) | Chèques Vacances Connect (66) |
| `CARTE BANCAIRE…` | ANCV-CHEQUE VACANCES (31) |
| `VAD MANUELLE…` | CHEQUE BANCAIRE (14), ESPECES (5) |

Les **chèques vacances**, Connect compris, sont remboursés par virement — même
règle qu'au Brasilia.

Deux libellés sont écartés parce qu'ils ne désignent aucun paiement :
**« NULL »**, l'absence de paiement exportée en texte, sur 18 séjours tous à
zéro encaissé ; et **« REGULARISATION »**, une écriture comptable, sur un
séjour. Ces dossiers partent en « À vérifier », ce qui est le bon résultat.

Sur les 1018 séjours : **853 tout carte, 147 d'un autre moyen, 18 sans paiement
exploitable**.

> Cette prudence n'est pas théorique : sur les campings précédents, **un dossier
> sur cinq** présentait une contradiction entre la déclaration du client et le
> PMS. `À vérifier` signifie « contrôler le dossier avant de rembourser ».

**Pas de bon à valoir dans cette crise.** Les trois méthodes sont Carte, Virement
et À vérifier. La valeur `BAV` existait au Brasilia et aux Grands Pins et avait
été reprise par copie ; le formulaire ne la propose pas ici et le camping n'en a
pas fait un geste commercial. La laisser affichée n'aurait offert au camping
qu'un choix sans suite opérationnelle. Un contrôle de `qa_formulaire` vérifie
désormais qu'aucune mention n'est revenue, code et écrans compris.

La méthode est **figée au rapprochement**. Si le camping la corrige à la main, sa
saisie fait foi et rien n'est recalculé.

**Un relogement n'a pas de méthode de remboursement**, et la case reste vide. Ce
n'est pas un oubli : le client relogé n'est pas remboursé, il obtient une remise.
Le formulaire ne lui pose d'ailleurs pas la question du mode de règlement, son
champ revient donc toujours vide. Sans cette règle, le calcul concluait
« À vérifier » pour tous les relogés et noyait les vrais dossiers à contrôler —
ceux d'une annulation dont la déclaration du client contredit les paiements du
PMS.

### Deux dispositifs, volontairement cloisonnés

| | Quartier Aquabulle (304) | Reste du camping (714) |
|---|---|---|
| Le client reçoit le formulaire | oui | non |
| Qui décide | le client, via sa réponse | le camping |
| Colonnes pilotées | `decision_client`, `methode_remboursement`, suivi du relogement et de la remise | `action_camping`, `remise_taux`, `remboursement`, `methode_remboursement` |
| Calcul automatique | oui, au rapprochement | **aucun** |

Hors Aquabulle, le camping traite les dossiers lui-même et consigne ce qu'il a
fait dans **Action camping** : *A rappeler*, *Remise* (un taux apparaît alors,
20 % par défaut, modifiable au cas par cas) ou *Annulé* (il renseigne ensuite le
remboursement puis la méthode employée). Aucun contrôle ne vient confronter sa
saisie aux paiements du PMS : il décrit ce qu'il a fait, l'outil l'enregistre.

> **Le cloisonnement est une règle de code, pas une convention.** Une réponse au
> formulaire qui tombe sur un séjour hors Aquabulle — un client qui n'était pas
> destinataire mais qui répond quand même — est bien rattachée, pour rester
> consultable, mais **ne déduit ni décision ni méthode**. Sans cette règle, elle
> effacerait d'un coup ce que le camping a consigné. Même chose au déliement :
> supprimer une réponse ne vide la décision et la méthode que sur les séjours où
> elles venaient du formulaire. Treize contrôles de `qa_hors_aquabulle` vérifient
> ce cloisonnement dans les deux sens.

Le **taux de remise** est la même colonne dans les deux dispositifs : un séjour
n'a qu'un taux, quelle qu'en soit l'origine. Ce qui diffère, c'est ce qui
l'accompagne — un suivi en deux étapes pour un relogement, rien pour une remise
accordée par le camping.

### Le périmètre de la crise

Le camping compte quatre quartiers. **Secret de Camargue est fermé.** Le sinistre
de la nuit du 6 au 7 octobre 2026 touche **Aquabulle** ; **Village du Port** et
**Côté Village** servent au relogement.

Seuls les clients d'Aquabulle reçoivent le formulaire : **304 séjours**, soit les
13 présents sur place dans le quartier et les 291 arrivées à venir. Le périmètre
est défini par `quartier = 'Aquabulle'`.

> **Pourquoi le quartier et pas le segment du siège.** L'onglet reposait d'abord
> sur `statut_client` = « Client en arrivée à partir du 08/10 - Quartier
> Aquabulle », 291 dossiers. À la mise à jour suivante du fichier maître, le
> siège a scindé ce segment en trois libellés par vague d'arrivée (08–15/10 : 25,
> 16–23/10 : 158, 24/10–01/11 : 108) pour échelonner ses envois. L'ancien libellé
> a disparu : l'onglet se serait vidé d'un coup, sans erreur ni alerte. Le
> quartier vient du PMS et ne se renomme pas au rythme des campagnes d'emailing.
> **Règle générale : ne jamais faire reposer un périmètre de travail sur un
> libellé de segment marketing.** Les vagues restent filtrables par « Statut
> client » dans la liste générale.

Les autres clients reçoivent une remise de 20 % appliquée d'office par le
camping, hors de l'outil. Ils restent visibles dans la liste générale, rien n'est
masqué ni supprimé.

### Décision du client

Annulé ou **Relogement + remise**, déduit de la réponse au formulaire. Pas de
« Décalé » dans cette crise, contrairement au Brasilia : on ne décale pas un
séjour, on reloge dans un autre quartier. Vide quand la réponse ne permet pas de
trancher : mieux vaut une case vide qu'une information inventée.

Le reste du dossier découle de cette décision :

| Décision | Ce que le camping saisit ensuite |
|---|---|
| Annulé | méthode de remboursement, puis remboursement effectué |
| Relogement + remise | relogement (statut + hébergement), puis remise (statut + taux) |

C'est aussi ce qui s'affiche ou non dans la pop-in de suivi : on ne demande pas
une méthode de remboursement à quelqu'un qu'on reloge. Changer la décision vide
les champs devenus hors-sujet — sans quoi un dossier passé de l'annulation au
relogement resterait dans le filtre « remboursements à faire ».

### Coordonnées bancaires

Elles vivent dans `choix_client`, avec la réponse au formulaire. La fiche séjour
les **affiche en lecture seule** ; pour les corriger, passer par le bouton
« Réponse forms » qui ouvre la réponse elle-même.

> Limite connue, héritée du modèle : un client qui n'a pas répondu au formulaire
> n'a nulle part où stocker un IBAN communiqué par téléphone. Le sujet est ouvert
> sur les autres campings, la piste étant de déplacer ces colonnes sur le séjour.

---

## 6. Les quatre réglages dépendants du camping

Plus rien n'est « à paramétrer » : les quatre réglages sont calés sur le
formulaire et le fichier maître réels. Ils restent listés ici parce que ce sont
eux qu'il faudra reprendre au prochain camping — ou si le formulaire change en
cours de crise.

| Où | Réglage actuel |
|---|---|
| `server.js` — `FICHIERS_ATTENDUS` | un seul fichier accepté : `relogement.xlsx` (ou `.xls`) |
| `server.js` — `FORM_COLUMN_MAPS` | en-têtes du formulaire de relogement, dont « Nom2 » et « Que souhaitez-vous faire ? » |
| `server.js` — `calculerDecisionClient` | réponse → `Annulé` ou `Relogement + remise` |
| `server.js` — `MOTIFS_CARTE` | libellés PMS valant un règlement par carte, reconnus **par motif** |

Le dernier mérite un mot : le PMS de ce camping suffixe ses libellés par le lieu
d'encaissement (« VENTE A DISTANCE LYRA », « CB accueil »). Une liste de libellés
exacts n'y survivait pas, d'où une reconnaissance par début de libellé.
`REGULARISATION` et les lignes `NULL` ne sont pas des paiements et sont écartées ;
les chèques vacances se remboursent par virement.

Côté interface, `FORMULAIRES` dans `public/sejours.js` décrit les questions posées
par le formulaire, pour n'afficher dans la pop-in que les champs pertinents.

### Trois pièges qui nous ont coûté du temps ailleurs

**La casse des libellés PMS.** Le PMS du Brasilia écrit « Vente A Distance »,
celui des Grands Pins « VENTE A DISTANCE ». Une comparaison littérale ne
reconnaissait aucune carte et envoyait 850 dossiers vers un virement à tort. La
comparaison est désormais insensible à la casse — mais il faudra quand même
**vérifier les libellés réels** une fois le fichier maître importé.

**Les formulations multiples.** Une même question peut avoir plusieurs
rédactions selon la version du formulaire, coquilles comprises. Au Brasilia,
286 clients déclarant la carte étaient lus comme « autre moyen » parce que la
règle testait le début de la phrase. Raisonner sur le sens, jamais sur l'amorce.

**Les lignes de remboursement dans les modes de paiement.** Le PMS journalise
les remboursements dans la même colonne que les paiements (« Rembours. CB »).
Elles décrivent ce que le camping a rendu, pas la façon dont le client a payé :
elles sont écartées du calcul.

---

## 7. Les écrans

**Import** — dépôt d'un fichier Excel. Le nom du fichier détermine le
formulaire ; tout autre nom est refusé et rien n'est importé. Un même fichier
peut être réimporté sans risque : seules les réponses absentes de la base sont
reprises.

**Liste séjours** — le référentiel complet, avec recherche, filtres, tri par
colonne, masquage de colonnes et export Excel. La fiche s'ouvre en pop-in.

En tête d'écran, **sept compteurs portant sur les séjours hors Aquabulle** (714).
Ils sont cliquables et appliquent exactement les filtres qui produisent les
lignes qu'ils comptent. Le périmètre est volontairement celui du *reste* du
camping : les dossiers du quartier sinistré ont leur propre tableau de bord, et
mélanger les deux populations donnerait des chiffres que personne ne saurait
lire. « Hors Aquabulle » s'exprime en cochant les trois autres quartiers, le
filtre travaillant par inclusion.

**Dossiers Aquabulle** — la vue de travail des 304 dossiers du quartier sinistré,
et seuls eux. En tête, neuf compteurs d'avancement cliquables : chacun applique exactement
les filtres qui produisent les lignes qu'il compte, donc le chiffre affiché et la
liste obtenue ne peuvent pas se contredire. En dessous, vingt-trois colonnes et onze
familles de filtres réparties en trois groupes : *Où en est le dossier* (réponse,
décision, méthode, remboursement, relogement, remise, action du camping, avec
partout une case « pas encore traité »), *Qui est le client* (vague d'arrivée,
situation au moment de l'incident, type d'hébergement, nombre de personnes) et
*Dates et montants* (arrivée, départ, montant réglé). Les listes longues sont
repliées par défaut et annoncent ce qu'elles contiennent.

Les colonnes vont au-delà du seul avancement : téléphone et email pour joindre le
client, type d'hébergement et nombre de personnes pour lui retrouver un
équivalent, montants TTC et réglé pour instruire un remboursement. Le but est
qu'un dossier se traite sans changer d'écran.

Les options de filtre sont demandées sur le seul périmètre du quartier
(`/api/sejours/filter-options?perimetre=aquabulle`) : Aquabulle compte 4 types
d'hébergement quand le camping en compte 20, et proposer les 16 autres n'aurait
fait qu'allonger la liste sans jamais rien ramener.

Le tableau se manipule exactement comme celui de la liste séjours : repère
**« i »** à gauche de chaque ligne, bouton **« Modifier »** à droite — les deux
ouvrent la même pop-in, resserrée sur les seules étapes du dossier —,
glisser-déposer horizontal, et une barre de défilement dupliquée au-dessus du
tableau. Cette barre n'est pas un ornement : celle du navigateur se trouve sous
cinquante lignes, donc hors de l'écran au moment précis où l'on en a besoin. La
fiche complète reste dans **Liste séjours**, qui demeure la vue exhaustive.

> Un défaut du glisser-déposer a été corrigé à cette occasion, **dans les deux
> onglets** : un glissé relâché hors du tableau ne produit aucun clic, donc rien
> ne venait consommer le drapeau « on vient de glisser » — et le clic suivant,
> sur un bouton par exemple, était avalé sans explication. Le drapeau se remet
> désormais à zéro dès l'appui suivant. Un contrôle de `qa_aquabulle` le vérifie,
> et il échoue bien si on retire le correctif.

Cet onglet n'ajoute aucun droit : il réutilise les mêmes filtres, le même export
et la même route d'écriture que la liste générale, avec la contrainte de
périmètre en plus. Il ne retire rien non plus — tout y est consultable ailleurs.

**A répondu** — les réponses du call center, avec un filtre **Rattachement au
séjour** qui mérite une explication.

Un client qui répond deux fois produit deux réponses. Un séjour ne peut en
porter qu'une, la plus récente : la précédente est dite **supplantée**. Elle
reste en base et consultable — on veut pouvoir la retrouver — mais elle ne
décrit plus aucun dossier. La laisser dans les résultats fausse le suivi :
filtrer sur « Je souhaite annuler » renvoyait 2 réponses pour 1 seul séjour
réellement annulé.

La case **« Rattachée à un séjour » est donc cochée à l'ouverture**, et le badge
de filtres l'annonce. Le call center obtient un décompte juste sans rien faire,
voit qu'un filtre est actif, et peut le retirer. « Réinitialiser » la remet :
l'état de référence de cet écran est le suivi juste, pas l'absence de filtre.

Cocher **« Supplantée (doublon) »** isole les réponses écartées. Quand elles
s'affichent, leur ligne est grisée et le nom porte un repère « doublon » qui
explique au survol pourquoi. L'API renvoie pour cela un champ `rattachee` sur
chaque réponse.

L'écran **Match incorrect** n'est pas concerné : aucune de ses réponses n'est
rattachée, par définition.

**Match incorrect** — les réponses qui n'ont trouvé aucun séjour. A vocation à
rester vide.

### L'export

Reproduit exactement la sélection affichée, filtres compris. Depuis l'onglet
Aquabulle il se restreint au périmètre (`?perimetre=aquabulle`) et se cumule aux
filtres actifs. Quand le filtre
**Méthode de remboursement = Virement** est actif, l'export gagne quatre
colonnes lues dans la réponse : mode de règlement déclaré, IBAN, BIC, banque.
De quoi préparer les virements à la chaîne sans ouvrir chaque fiche.

Elles sont absentes de tous les autres exports, volontairement : un fichier
contenant des IBAN en clair ne doit pas circuler sans raison.

---

## 8. Points de vigilance

**Ne jamais toucher aux bases des autres campings.** Les Grands Pins et Le
Brasilia sont en service et leurs données sont vivantes.

**Le fichier maître est remis à jour en cours de crise.** `scripts/diff_master.js`
compare fichier et base sans rien écrire — colonnes, séjours, puis valeurs
colonne par colonne ; `scripts/update_master.js` applique, en simulation par
défaut. Les deux partagent `scripts/map_master.js` avec l'import initial, pour
qu'« aligné » veuille dire la même chose partout. La mise à jour **ne touche
jamais** les colonnes de traitement de crise (décision, méthode, suivi du
relogement et de la remise, commentaires), absentes de la correspondance, ni les
quatre colonnes que le fichier porte vides mais que le camping renseigne
(`remboursement`, les deux dates de relogement, `camping_relogement`) : sans cette
protection, chaque mise à jour effacerait le travail du camping.

**Les suites de recette raisonnent en écarts, jamais en absolu.** La base est en
service : le nombre de réponses et de dossiers traités change d'heure en heure.
Chaque suite relève son point de départ, agit, puis vérifie l'écart et restaure.
Elles ne travaillent que sur des **séjours vierges** — ni réponse, ni décision,
ni action — pour ne jamais marcher sur un dossier en cours de traitement.

**La recette tourne en six suites, 500 contrôles.** `qa_master` (la table
maître), `qa_formulaire` (les règles de calcul, sans serveur), `qa_aquabulle`
(l'onglet dédié), `qa_hors_aquabulle` (le suivi par le camping et le
cloisonnement), `qa_chaine` (la chaîne complète : import d'un vrai fichier
Excel fabriqué pour l'occasion, delta entre deux imports, rapprochement,
calculs, étapes du dossier, garde-fous) et `qa_front` (les cinq écrans pilotés
dans un vrai DOM : affichage, pagination, tri, filtres, pop-ins, masquage de
colonnes). Les suites qui écrivent prennent une photo avant et restaurent après,
y compris en cas d'échec.

**Les attentes chiffrées des tests se recomptent, elles ne s'écrivent pas en
dur.** La répartition des segments de statut est relue dans le fichier maître à
chaque exécution de `qa_master.js`. La version précédente les figeait : le
redécoupage du siège a produit sept faux échecs qui laissaient croire à un import
raté.

**Les migrations de schéma sont le vrai danger**, pas le code. Ajouter une
colonne nullable est sans effet sur l'existant. Renommer, supprimer ou
contraindre une colonne pendant que le camping travaille, c'est autre chose :
l'ancienne version du serveur tourne encore quelques secondes après la
migration. Procéder en deux temps — ajouter, faire cohabiter, supprimer plus
tard.

**Le déploiement redémarre le service.** Une requête en vol échoue. L'application
affiche une erreur plutôt que de perdre la saisie, mais mieux vaut déployer en
creux d'activité.

**Prendre une empreinte avant toute écriture de masse**, et la recalculer après
en excluant les colonnes censées changer :

```sql
select md5(string_agg((to_jsonb(m) - 'colonne_modifiee')::text, '|' order by m.id))
from master_sejours m;
```

Identique avant et après, elle prouve que rien d'autre n'a bougé.
