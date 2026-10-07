-- =============================================================================
-- Les Petits Camarguais — Schéma de base de données (structure uniquement)
-- =============================================================================
-- Crise du 7 octobre 2026 : dégâts causés par la pluie et le vent dans la nuit
-- du 6 au 7. Même dispositif que pour les campings sinistrés de l'été.
--
-- Ce script crée les tables entièrement VIDES. Les données réelles sont
-- importées ensuite : fichier maître des séjours, puis réponses aux formulaires
-- via l'écran d'import de l'application.
--
-- Utilisation :
--   1. Créer le projet Supabase des Petits Camarguais.
--   2. Exécuter ce script dans l'éditeur SQL (SQL Editor > New query).
--   3. Renseigner SUPABASE_URL / SUPABASE_KEY dans le .env (voir .env.example).
--
-- Note sécurité : Row Level Security est désactivé sur ces tables.
-- L'application accède à la base côté serveur uniquement, jamais depuis le
-- navigateur. Si ces tables devaient un jour être exposées au client Supabase
-- côté navigateur, activer RLS et définir des policies.
--
-- La structure de master_sejours suit le référentiel commun multi-camping
-- (format template_fichier_la_rive.xlsx), partagé avec Les Grands Pins et
-- Le Brasilia. Trois écarts assumés par rapport à eux, documentés plus bas :
-- le nom de la colonne de présence, l'absence des colonnes héritées de la v1
-- du Brasilia, et la présence dès l'origine du relogement et du statut
-- d'emplacement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table 1 : master_sejours
-- Référentiel des séjours réels (importé depuis le fichier Excel maître).
-- -----------------------------------------------------------------------------
create table public.master_sejours (
  id bigserial primary key,
  nom_entreprise text,
  numero_client_groupe bigint,
  nom text,
  prenom text,
  email text,
  telephone_fixe text,
  telephone_portable text,
  type_to_ce text,
  nom_to text,
  prenom_to text,
  email_to text,
  telephone_fixe_to text,
  telephone_portable_to text,
  date_debut_sejour date,
  date_depart_sejour date,
  nombre_personnes integer,
  categorie_pms text,
  numero_emplacement text,
  numero_reservation text,
  montant_sejour_ttc numeric,
  montant_regle numeric,
  assurance_annulation numeric,
  situation integer,
  situation_desc text,
  fidelity_use integer,
  fidelity_map text,
  modes_paiement text,
  transactions_lyra text,
  canal_saisie text,
  sales_channel_brut integer,
  canal_reservation_online text,
  type_origine_code integer,
  statut_client text,
  mailing_1 text,
  date_envoi_m1 date,
  mailing_2 text,
  date_envoi_m2 date,
  mailing_3 text,
  date_envoi_m3 date,
  los integer,
  montant_ht_nuit numeric,
  nuits_non_consommees integer,
  calcul_rbs_nuits_non_consommees numeric,
  remboursement text,
  methode_remboursement text,
  decision_client text,
  date_entree_relogement date,
  date_sortie_relogement date,
  camping_relogement text,
  relogements_detail text,
  statut_emplacement text,
  nom_prenom text,
  quartier text,
  commentaire_remboursement text,
  action_camping text,
  commentaire_camping text,
  -- Suivi du dossier d'un client relogé. Les deux étapes avancent
  -- indépendamment : on reloge d'abord, la remise se traite souvent bien plus
  -- tard. D'où deux statuts distincts et non un seul statut d'avancement.
  relogement_statut text,
  relogement_hebergement text,
  remise_statut text,
  remise_taux numeric,
  id_choix_client bigint unique
);

comment on table public.master_sejours is 'Référentiel des séjours réels du camping Les Petits Camarguais. Structure conforme au référentiel commun multi-camping.';

-- --- Identité, contacts, tour-opérateur --------------------------------------
comment on column public.master_sejours.nom_entreprise is 'Camping / entité propriétaire du séjour (colonne "nom_entreprise" du fichier source) — clé du futur fonctionnement multi-camping.';
comment on column public.master_sejours.type_to_ce is 'Type de réservation via tour-opérateur ou CSE (colonne "typeToCe" : "TO" ou NULL).';
comment on column public.master_sejours.nom_to is 'Nom du tour-opérateur / CSE (colonne "nom_to").';
comment on column public.master_sejours.prenom_to is 'Prénom du contact tour-opérateur / CSE (colonne "prenom_to").';
comment on column public.master_sejours.email_to is 'Email du tour-opérateur / CSE (colonne "email_to").';
comment on column public.master_sejours.telephone_fixe_to is 'Téléphone fixe du tour-opérateur / CSE (colonne "telephone_fixe_to").';
comment on column public.master_sejours.telephone_portable_to is 'Téléphone portable du tour-opérateur / CSE (colonne "telephone_portable_to").';
comment on column public.master_sejours.nom_prenom is 'Nom et prénom concaténés, fournis par le fichier source (colonne "NomPrénom").';

-- --- Séjour et facturation ----------------------------------------------------
comment on column public.master_sejours.assurance_annulation is 'Montant de l''assurance annulation (colonne "assurance_annulation").';
comment on column public.master_sejours.fidelity_use is 'Nombre de nuits de fidélité utilisées (colonne "fidelity_use").';
comment on column public.master_sejours.fidelity_map is 'Cartographie des nuits de fidélité, une position par nuit du séjour (colonne "fidelity_map").';
comment on column public.master_sejours.los is 'Length of stay : nombre de nuits du séjour (colonne "LOS").';
comment on column public.master_sejours.montant_ht_nuit is 'Montant hors taxes par nuit (colonne "Montant HT / Nuit"). Calculé par le siège, non modifiable dans l''outil.';
comment on column public.master_sejours.nuits_non_consommees is 'Nombre de nuits non consommées suite à l''évacuation (colonne "Nuits non consommées").';
comment on column public.master_sejours.calcul_rbs_nuits_non_consommees is 'Montant de remboursement calculé par le siège pour les nuits non consommées. Non modifiable dans l''outil. ATTENTION : sur les campings précédents cette colonne s''est révélée peu fiable, le calcul supposant qu''aucun client ne revient. Ne pas s''en servir pour un calcul financier sans contrôle.';
comment on column public.master_sejours.modes_paiement is 'Modes de paiement enregistrés au PMS, au format "Libellé : montant €" séparés par des barres verticales. Sert au calcul de methode_remboursement. Les libellés varient d''un camping à l''autre, y compris en casse : la comparaison doit être insensible à la casse.';

-- --- Situation du client pendant la crise -------------------------------------
comment on column public.master_sejours.statut_client is 'Statut/situation du client vis-à-vis de la crise (colonne "Statut" du fichier source). Renseigné par le siège.';
comment on column public.master_sejours.situation is 'Code de situation du client sur le camping (colonne "situation" du fichier source).';
comment on column public.master_sejours.situation_desc is 'Libellé de la situation : Présent, Réservation, Parti... (colonne "situation_desc").';
comment on column public.master_sejours.quartier is 'Quartier du camping où se situe l''emplacement : Village, Aquabulle, Port, Perso. Recoupe les préfixes de numéro d''emplacement. Donnée d''origine camping, non modifiable dans l''outil. Déterminante pour la crise d''octobre 2026, dont le périmètre est le quartier Aquabulle.';

-- Pas de colonne de présence à la date pivot : le fichier maître porte bien une
-- colonne « Présents28 », mais c''est un reliquat du modèle des Grands Pins,
-- entièrement vide. Même chose pour « NoShow ». Si le siège fournit un jour un
-- indicateur de présence au jour de l''incident, il suffira d''ajouter la colonne.
comment on column public.master_sejours.statut_emplacement is 'État de l''emplacement du séjour après la crise : OK, KO, ou ? quand le camping n''a pas tranché. Constat terrain fourni par le camping dans un fichier à part, en lecture seule dans l''outil.';

-- --- Mailings -----------------------------------------------------------------
comment on column public.master_sejours.mailing_1 is 'Type du mailing 1 envoyé au client (colonne "Mailing 1").';
comment on column public.master_sejours.date_envoi_m1 is 'Date d''envoi du mailing 1 (colonne "Date envoi M1").';
comment on column public.master_sejours.mailing_2 is 'Type du mailing 2 envoyé au client (colonne "Mailing 2").';
comment on column public.master_sejours.date_envoi_m2 is 'Date d''envoi du mailing 2 (colonne "Date envoi M2").';
comment on column public.master_sejours.mailing_3 is 'Type du mailing 3 envoyé au client (colonne "Mailing 3").';
comment on column public.master_sejours.date_envoi_m3 is 'Date d''envoi du mailing 3 (colonne "Date envoi M3").';

-- --- Relogement ---------------------------------------------------------------
-- Prévu dès l'origine : au Brasilia il a fallu l'ajouter dans l'urgence, après
-- coup, en reprenant une table de relogements de l'ancienne application.
comment on column public.master_sejours.date_entree_relogement is 'Date d''entrée sur le camping de relogement. Première arrivée si le client a été relogé plusieurs fois.';
comment on column public.master_sejours.date_sortie_relogement is 'Date de sortie du camping de relogement. Dernière sortie si le client a été relogé plusieurs fois.';
comment on column public.master_sejours.camping_relogement is 'Camping d''accueil en cas de relogement. Plusieurs campings sont séparés par " puis ".';
comment on column public.master_sejours.relogements_detail is 'Liste complète des relogements du séjour, un par ligne au format "date d''arrivée → date de sortie · camping". Les trois colonnes ci-dessus n''en donnent que le résumé ; aucun relogement ne doit être perdu.';

-- --- Suivi du dossier par l'outil ---------------------------------------------
comment on column public.master_sejours.remboursement is 'Statut du remboursement : Oui, Non ou Partiel. Saisi par le camping.';
comment on column public.master_sejours.methode_remboursement is 'Méthode de remboursement à appliquer : Carte, Virement ou À vérifier. Pas de bon à valoir dans cette crise, le formulaire ne le propose pas. Calculée au rapprochement avec une réponse au formulaire, et seulement là : sans réponse il n''y a rien à croiser avec le PMS. La déclaration du client et les modes de paiement du PMS doivent concorder, tout désaccord donnant À vérifier. Figée au rapprochement, modifiable à la main sans recalcul.';
comment on column public.master_sejours.decision_client is 'Décision du client sur son séjour. Pour la crise d''octobre 2026 aux Petits Camarguais : Annulé ou "Relogement + remise" — il n''y a pas de décalage de séjour ici, contrairement au Brasilia. Déduite de sa réponse au formulaire au moment du rapprochement. Reste vide si la réponse ne permet pas de trancher — mieux vaut une case vide qu''une information inventée. Figée au rapprochement, modifiable à la main sans recalcul.';
comment on column public.master_sejours.commentaire_remboursement is 'Mémo libre saisi par les équipes pour justifier un remboursement, notamment partiel. Absent du fichier source.';
comment on column public.master_sejours.action_camping is 'Action que le camping se réserve sur ce séjour, indépendante du traitement du dossier. Valeur prévue : "A rappeler". À ne pas confondre avec statut_client (siège) ni avec choix_client.statut (call center).';
comment on column public.master_sejours.commentaire_camping is 'Motif du rappel saisi par le camping. N''a de sens que lorsque action_camping vaut "A rappeler".';
comment on column public.master_sejours.relogement_statut is 'Où en est le relogement du client : "À reloger", "Relogé" ou "Refusé par le client". N''a de sens que si decision_client vaut "Relogement + remise". Vide = pas encore traité, ce qui est la valeur de départ et sert de filtre de travail au camping.';
comment on column public.master_sejours.relogement_hebergement is 'Hébergement d''accueil du client relogé, en texte libre : le camping y note son repère (numéro d''emplacement et quartier). Les quartiers Village du Port et Côté Village servent au relogement, le quartier Secret de Camargue étant fermé.';
comment on column public.master_sejours.remise_statut is 'Où en est la remise commerciale : "À appliquer" ou "Appliquée". Volontairement indépendant de relogement_statut, la remise étant traitée bien après le relogement. Vide = pas encore traitée.';
comment on column public.master_sejours.remise_taux is 'Taux de remise en pourcentage, 20 par défaut. Modifiable au cas par cas pour les dossiers compliqués, d''où une colonne numérique et non une valeur figée. Contrôlé entre 0 et 100 à l''écriture.';
comment on column public.master_sejours.id_choix_client is 'Pointe vers choix_client.id : lien entre la réponse au formulaire et le séjour. Unique : une réponse ne peut être rattachée qu''à un seul séjour.';

-- -----------------------------------------------------------------------------
-- Table 2 : choix_client
-- Réponses des clients aux formulaires.
-- -----------------------------------------------------------------------------
-- Trois emplacements d'identifiant sont prévus d'emblée, même si le dispositif
-- des Petits Camarguais n'est pas encore arrêté. Les campings précédents en ont
-- utilisé deux ou trois ; garder le même schéma partout est ce qui permet de
-- maintenir une seule base de code. Les colonnes de questions inutilisées
-- restent simplement vides.
create table public.choix_client (
  id bigserial primary key,
  id_f1 bigint,
  id_f2 bigint,
  id_f3 bigint,
  langue text,
  nom text,
  prenom text,
  email text,
  num_resa text,
  choix text,
  method_remb text,
  iban text,
  bic text,
  info_banque text,
  situation text,
  je_choisis text,
  je_decide text,
  nous_proposons text,
  statut text
);

comment on table public.choix_client is 'Réponses des clients aux formulaires de la crise. Une ligne = une réponse. Un seul des trois identifiants id_f1 / id_f2 / id_f3 est renseigné, et c''est lui qui dit de quel formulaire vient la réponse.';
comment on column public.choix_client.id_f1 is 'Identifiant de la réponse dans le formulaire 1. Sert au calcul du delta à l''import : seules les lignes dont l''identifiant dépasse le maximum déjà en base sont insérées, ce qui rend les réimports sans effet.';
comment on column public.choix_client.id_f2 is 'Identifiant de la réponse dans le formulaire 2. Même usage que id_f1.';
comment on column public.choix_client.id_f3 is 'Identifiant de la réponse dans le formulaire 3. Même usage que id_f1.';
comment on column public.choix_client.langue is 'Langue de saisie du formulaire.';
comment on column public.choix_client.num_resa is 'Numéro de réservation saisi par le client. Clé principale du rapprochement avec master_sejours ; l''email sert de recours quand il ne désigne qu''un seul séjour.';
comment on column public.choix_client.choix is 'Réponse à la question principale du formulaire : ce que le client souhaite faire de son séjour.';
comment on column public.choix_client.method_remb is 'Mode de règlement déclaré par le client. Croisé avec modes_paiement du PMS pour déduire la méthode de remboursement. ATTENTION : sur les campings précédents, plusieurs formulations coexistaient pour la même réponse — la détection doit raisonner sur le sens, pas sur le début de la phrase.';
comment on column public.choix_client.iban is 'IBAN communiqué par le client pour un remboursement par virement.';
comment on column public.choix_client.bic is 'BIC / SWIFT communiqué par le client.';
comment on column public.choix_client.info_banque is 'Nom et adresse de la banque bénéficiaire.';
comment on column public.choix_client.situation is 'Réponse à une question de situation, si le formulaire en pose une.';
comment on column public.choix_client.je_choisis is 'Réponse à une question de type « Je choisis », si le formulaire en pose une.';
comment on column public.choix_client.je_decide is 'Réponse à une question de type « Je décide », si le formulaire en pose une.';
comment on column public.choix_client.nous_proposons is 'Réponse à une question de type « Nous vous proposons de », si le formulaire en pose une.';
comment on column public.choix_client.statut is 'Résultat du rapprochement : "A répondu" si la réponse a trouvé son séjour, "Match incorrect" sinon. L''onglet Match incorrect a vocation à rester vide.';

-- -----------------------------------------------------------------------------
-- Index : les colonnes servant au rapprochement et aux filtres les plus courants
-- -----------------------------------------------------------------------------
-- Sur 3000 à 5000 lignes Postgres s'en sort sans index, mais le rapprochement
-- interroge num_resa et email une fois par réponse importée : autant éviter un
-- parcours complet de la table à chaque ligne.
create index idx_master_numero_reservation on public.master_sejours (upper(numero_reservation));
create index idx_master_email on public.master_sejours (lower(email));
create index idx_master_id_choix_client on public.master_sejours (id_choix_client);
create index idx_choix_num_resa on public.choix_client (upper(num_resa));
create index idx_choix_email on public.choix_client (lower(email));

-- -----------------------------------------------------------------------------
-- Row Level Security : désactivé sur les 2 tables (voir note en tête de fichier).
-- -----------------------------------------------------------------------------
alter table public.master_sejours disable row level security;
alter table public.choix_client disable row level security;
