require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Sans configuration, l'application planterait sur une erreur interne de la
// bibliothèque Supabase, illisible dans les logs d'un hébergeur. On préfère
// s'arrêter tout de suite en disant précisément ce qui manque.
const VARIABLES_REQUISES = ['SUPABASE_URL', 'SUPABASE_KEY', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD'];
const manquantes = VARIABLES_REQUISES.filter((v) => !process.env[v]);
if (manquantes.length) {
  console.error('Démarrage impossible : variable(s) d\'environnement manquante(s) — ' + manquantes.join(', ') + '.');
  console.error('Renseignez-les dans le fichier .env en local, ou dans les Environment Variables de l\'hébergeur.');
  console.error('Le fichier .env.example liste les valeurs attendues.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Authentification HTTP Basic : protège l'ensemble de l'application (pages et
// API) derrière un identifiant/mot de passe, tant que l'outil n'a pas
// d'authentification utilisateur dédiée.
//
// Aucune valeur par défaut : le code étant public sur GitHub, un mot de passe
// de secours écrit en dur y serait lisible par n'importe qui. Les identifiants
// viennent donc exclusivement des variables d'environnement, dont l'absence est
// vérifiée au démarrage.
// Placé AVANT express.static pour couvrir aussi les fichiers du dossier public.
// ---------------------------------------------------------------------------
function basicAuthMiddleware(req, res, next) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD;

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    if (user === expectedUser && password === expectedPassword) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Les Petits Camarguais", charset="UTF-8"');
  return res.status(401).send('Authentification requise.');
}

app.use(basicAuthMiddleware);

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));
app.use(express.json());

// ---------------------------------------------------------------------------
// Mapping colonnes xlsx -> colonnes table choix_client
// ---------------------------------------------------------------------------
// Colonnes communes aux deux formulaires. Les colonnes propres à Forms
// ("Heure de début", "Heure de fin", "Adresse de messagerie", "Nom",
// "Heure de la dernière modification") sont volontairement ignorées : elles
// n'ont pas d'usage métier. "Langue" est conservée.
// Les formulaires des Petits Camarguais ne comportent pas de colonne « Langue » : la
// déclarer ici ferait échouer l'import. La colonne existe en base et reste
// vide, pour garder le même schéma que les autres campings.
// Intitulés repris à l'identique du formulaire. Deux écarts par rapport aux
// autres campings, relevés sur le fichier réel :
//   - l'email s'intitule ici « Email ayant servi à faire la réservation » ;
//   - la question sur le mode de règlement porte un espace en fin d'intitulé.
// Ce dernier est absorbé par normHeader, qui réduit les espaces avant de
// comparer : inutile de le recopier ici, et dangereux de compter dessus.
const COMMON_FORM_COLUMNS = {
  id: 'ID',
  langue: 'Langue',
  nom: 'Nom2',
  prenom: 'Prénom',
  email: 'Email ayant servi à faire la réservation',
  num_resa: 'Numéro de réservation (ex: O20260103...)',
};

// Bloc « remboursement » : présent dans les formulaires 1 et 2, absent du
// formulaire 3, qui n'offre que des bons à valoir et n'a donc pas à demander de
// coordonnées bancaires. Toute colonne déclarée ici est obligatoire dans le
// fichier : la déclarer pour le formulaire 3 ferait échouer son import.
const COLONNES_REMBOURSEMENT = {
  method_remb: 'Selon votre mode de règlement, quelle est votre méthode de remboursement ?',
  iban: 'Indiquez votre IBAN (RIB)',
  bic: 'Indiquez votre BIC/SWIFT',
  info_banque: 'Nom et adresse de la banque bénéficiaire',
};

// Chaque formulaire a ses propres questions métier. Le rapprochement se fait
// toujours sur le LIBELLÉ de la colonne (après normalisation des espaces),
// jamais sur sa position : les deux fichiers n'ont pas le même ordre.
// Correspondance entre les colonnes du fichier Excel et celles de la base.
// Les intitulés sont ceux du formulaire réel, relevés sur l'export Forms.
// L'import échoue explicitement si une colonne attendue manque, ce qui vaut
// mieux qu'un rangement silencieux à côté.
// Un seul formulaire pour cette crise. Les colonnes bancaires n'apparaissent
// que pour les clients qui annulent et déclarent un autre moyen que la carte ;
// elles restent vides pour les autres, ce qui est normal.
const FORM_COLUMN_MAPS = {
  relogement: {
    ...COMMON_FORM_COLUMNS,
    ...COLONNES_REMBOURSEMENT,
    choix: 'Que souhaitez-vous faire ?',
  },
};

// Champs de choix_client alimentés depuis les fichiers (hors id_f1/id_f2/id_f3).
const FORM_IMPORT_FIELDS = [
  'langue', 'nom', 'prenom', 'email', 'num_resa',
  'choix', 'situation', 'je_choisis', 'je_decide', 'nous_proposons',
  'method_remb', 'iban', 'bic', 'info_banque',
];

// ---------------------------------------------------------------------------
// Méthode de remboursement.
//
// Calculée au moment où une réponse au formulaire est rattachée à un séjour,
// puis figée : si le camping la corrige à la main, sa saisie fait foi et rien
// n'est recalculé.
//
// Deux sources d'information, et elles doivent être d'accord :
//   - le PMS, via les modes de paiement réellement enregistrés (master_sejours) ;
//   - la déclaration du client dans le formulaire (choix_client.method_remb).
//
// Le PMS est la référence, mais un désaccord n'est jamais tranché
// automatiquement : le dossier part en "À vérifier" et le camping contrôle.
// Cette prudence n'est pas théorique — sur les premiers imports, un dossier sur
// cinq présentait une contradiction entre les deux sources.
// ---------------------------------------------------------------------------
const METHODE_CARTE = 'Carte';
const METHODE_VIREMENT = 'Virement';
const METHODE_A_VERIFIER = 'À vérifier';
// Pas de bon à valoir dans cette crise : le formulaire ne le propose pas, et le
// camping ne l'a pas retenu comme geste commercial. La valeur existait au
// Brasilia et aux Grands Pins ; la laisser ici n'aurait fait qu'offrir au
// camping un choix qui n'a pas de suite opérationnelle.
const METHODES_REMBOURSEMENT = [METHODE_CARTE, METHODE_VIREMENT, METHODE_A_VERIFIER];

// Reconnaissance d'un règlement par carte. Un remboursement sur la carte n'est
// possible que si le séjour a été réglé UNIQUEMENT par carte : tout le reste —
// virement, espèces, chèque, chèques vacances y compris Connect — impose un
// remboursement par virement.
//
// Ici la reconnaissance se fait par MOTIF et non par liste exacte, parce que le
// PMS de ce camping suffixe ses libellés du lieu d'encaissement :
//   « CB SANS CONTACT VILLAGE PORT », « CB accueil LPX », « CB accueil SDC »…
// Une liste figée laisserait passer la prochaine caisse ouverte, et le dossier
// basculerait en virement sans que personne ne s'en aperçoive.
//
// Les motifs couvrent les 1569 lignes de paiement par carte du fichier maître :
// 1554 en vente à distance Lyra, 15 en CB sur place.
const MOTIFS_CARTE = [
  /^vente a distance\b/i,   // « VENTE A DISTANCE LYRA », et la variante sans suffixe
  /^cb\b/i,                 // « CB SANS CONTACT … », « CB accueil … »
  /^carte bancaire\b/i,     // libellé des autres campings, gardé pour un schéma commun
  /^vad manuelle\b/i,
];
const estCarte = (libelle) => MOTIFS_CARTE.some((m) => m.test(libelle.trim()));

// Le PMS journalise les remboursements dans la même colonne que les paiements
// (« Rembours. CB »). Ils décrivent ce que le camping a rendu, pas la façon dont
// le client a payé : on les écarte.
const estLigneDeRemboursement = (libelle) => /^rembours/i.test(libelle.trim());

// Deux libellés ne désignent aucun moyen de paiement et sont écartés :
//   « NULL »          — absence de paiement exportée en texte. Les 18 séjours
//                       concernés ont bien 0 € encaissé.
//   « REGULARISATION » — écriture comptable, pas un encaissement.
// Un séjour qui n'aurait que ces lignes se retrouve donc sans paiement connu,
// et part en « À vérifier » — ce qui est le bon résultat.
const estNonPaiement = (libelle) => /^(null|regularisation)$/i.test(libelle.trim());

const libellesDePaiement = (modesPaiement) => String(modesPaiement || '')
  .split('|')
  .map((part) => part.split(':')[0].trim())
  .filter((part) => part !== '' && !estLigneDeRemboursement(part) && !estNonPaiement(part));

// true = tout a été réglé par carte, false = au moins un paiement d'un autre
// type, null = aucun paiement enregistré (on ne peut rien conclure).
function reglementIntegralementParCarte(modesPaiement) {
  if (!modesPaiement) return null;
  const libelles = libellesDePaiement(modesPaiement);
  if (libelles.length === 0) return null;
  return libelles.every(estCarte);
}

// true = le client déclare avoir tout réglé par carte, false = il déclare un
// autre moyen, null = la question ne lui a pas été posée ou il n'y a pas répondu.
// Les formulaires ont été diffusés en plusieurs versions et la question sur le
// mode de règlement n'a pas toujours été formulée pareil. Quatre libellés
// coexistent en base :
//
//   « J'ai réglé uniquement par carte bancaire : … »                 -> carte
//   « J'ai réglé par carte bancaire : … »                            -> carte
//   « J'ai réglé en totalité ou partiellement avec un autre moyen… » -> autre
//   « J'ai réglé avec un autre moyen de paiement : … »               -> autre
//
// Tester le début de la phrase ne reconnaissait que la première : 286 clients
// déclarant la carte étaient lus comme « autre moyen ». On raisonne donc sur le
// sens, en écartant d'abord les formulations « autre moyen », et une phrase
// inattendue renvoie null plutôt qu'une réponse inventée.
function clientDeclareCarte(methodRemb) {
  const valeur = String(methodRemb ?? '').trim();
  if (valeur === '') return null;
  if (/autre moyen de paiement/i.test(valeur)) return false;
  if (/par carte bancaire/i.test(valeur)) return true;
  return null;
}

function calculerMethodeRemboursement(reponse, modesPaiement) {
  if (!reponse) return null;

  // 0. Un client relogé n'est pas remboursé : il obtient une remise sur place.
  // La question du mode de règlement ne lui est d'ailleurs pas posée dans le
  // formulaire, son champ revient donc toujours vide. Sans cette règle, le
  // calcul conclurait « À vérifier » pour tous les relogés et noierait les vrais
  // dossiers à contrôler — ceux d'une annulation dont la déclaration du client
  // contredit les paiements du PMS. Une case vide dit ici la vérité : il n'y a
  // rien à rembourser.
  if (calculerDecisionClient(reponse) === DECISION_RELOGEMENT) return null;

  // 1. Aucun paiement enregistré au PMS : rien à comparer.
  const toutCarte = reglementIntegralementParCarte(modesPaiement);
  if (toutCarte === null) return METHODE_A_VERIFIER;

  // 2. Le client n'a pas indiqué son mode de règlement : rien à comparer non plus.
  const declareCarte = clientDeclareCarte(reponse.method_remb);
  if (declareCarte === null) return METHODE_A_VERIFIER;

  // 3. Les deux sources se contredisent : on n'acte rien.
  if (declareCarte !== toutCarte) return METHODE_A_VERIFIER;

  // 4. Les deux sources sont d'accord.
  return toutCarte ? METHODE_CARTE : METHODE_VIREMENT;
}

// ---------------------------------------------------------------------------
// Décision du client : a-t-il annulé ou décalé son séjour ?
//
// L'information n'est pas posée telle quelle dans les formulaires, elle se
// déduit de la question de fond, qui diffère selon le formulaire :
//   - les deux formulaires des Petits Camarguais posent la même question :
//     « Que souhaitez-vous faire ? », dont les réponses possibles sont le
//     remboursement ou le relogement.
//
// Un cas n'entre dans aucune des deux valeurs et doit rester vide : les évacués
// dont le séjour se terminait avant la réouverture. Le formulaire ne leur a pas
// posé la question, parce qu'il n'y avait ni à annuler ni à décaler — seules
// leurs nuits évacuées sont compensées. Les ranger de force dans « Annulé »
// donnerait au camping une information fausse.
// ---------------------------------------------------------------------------
// Deux décisions possibles dans cette crise, et deux seulement. Pas de
// « Décalé » : aucune date ne bouge, le client qui reste garde son séjour et
// change seulement d'hébergement, avec une remise de 20 %.
const DECISION_ANNULE = 'Annulé';
const DECISION_RELOGEMENT = 'Relogement + remise';
const DECISIONS_CLIENT = [DECISION_ANNULE, DECISION_RELOGEMENT];

// Étapes du dossier d'un client relogé. Les deux avancent indépendamment : on
// reloge d'abord, la remise se traite souvent bien plus tard.
const RELOGEMENT_STATUTS = ['À reloger', 'Relogé', 'Refusé par le client'];
const REMISE_STATUTS = ['À appliquer', 'Appliquée'];
// Taux proposé par défaut dans la fiche. Le camping peut le modifier dossier
// par dossier : certains cas se négocient au-delà.
const REMISE_TAUX_DEFAUT = 20;

// ---------------------------------------------------------------------------
// Périmètre de l'onglet « Dossiers Aquabulle »
// ---------------------------------------------------------------------------
// Le camping ne traite avec nous que les clients du quartier Aquabulle à venir :
// ceux des autres quartiers reçoivent une remise de 20 % appliquée d'office, le
// camping s'en occupe seul.
//
// Le périmètre est le QUARTIER, pas le segment de mailing du siège. 304
// dossiers : les 13 clients présents sur place dans le quartier et les 291
// arrivées à venir.
//
// L'onglet reposait d'abord sur le segment « Client en arrivée à partir du 08/10
// - Quartier Aquabulle ». Le siège l'a scindé en quatre libellés par vague
// d'arrivée dès la mise à jour suivante du fichier maître, et l'onglet se serait
// vidé d'un coup. Le quartier, lui, est une donnée du PMS : il ne se renomme pas
// au rythme des campagnes d'emailing. Les vagues restent filtrables par
// « Statut client » dans la liste générale.
const QUARTIER_AQUABULLE = 'Aquabulle';

function calculerDecisionClient(reponse) {
  if (!reponse) return null;
  const choix = (reponse.choix || '').trim();

  // Les deux seules réponses possibles à « Que souhaitez-vous faire ? ».
  // On reconnaît sur le sens plutôt que sur la phrase entière : une virgule
  // déplacée ou un pourcentage réécrit ne doit pas faire basculer un dossier
  // en « indéterminé ». Les campings précédents ont montré que les intitulés
  // bougent entre deux versions d'un formulaire, coquilles comprises.
  //
  //   « Je souhaite annuler et je demande le remboursement des sommes versées »
  //   « Je souhaite maintenir mon séjour avec une remise de 20% et être relogé
  //     dans un hébergement de la même gamme, sans frais supplémentaires. »
  if (/^je souhaite annuler/i.test(choix)) return DECISION_ANNULE;
  if (/^je souhaite maintenir/i.test(choix)) return DECISION_RELOGEMENT;

  // Filet de sécurité si la formulation change : on cherche l'intention.
  if (/\bannuler\b/i.test(choix) && /rembours/i.test(choix)) return DECISION_ANNULE;
  if (/\brelog/i.test(choix) || /\bmaintenir\b/i.test(choix)) return DECISION_RELOGEMENT;

  // Réponse inattendue : une case vide vaut mieux qu'une décision inventée.
  return null;
}

function normHeader(h) {
  return String(h)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHeaderResolver(actualHeaders, columnMap) {
  const normalizedActual = actualHeaders.map((h) => ({ raw: h, norm: normHeader(h) }));
  const resolved = {};
  const missing = [];

  for (const [key, expectedHeader] of Object.entries(columnMap)) {
    const expectedNorm = normHeader(expectedHeader);
    let match = normalizedActual.find((h) => h.norm === expectedNorm);
    if (!match) {
      const prefix = expectedNorm.slice(0, 25);
      match = normalizedActual.find((h) => h.norm.startsWith(prefix));
    }
    if (match) {
      resolved[key] = match.raw;
    } else {
      missing.push(expectedHeader);
    }
  }
  return { resolved, missing };
}

// Seuls ces deux noms de fichiers sont acceptés : tout autre nom est rejeté
// avant la moindre écriture, pour ne pas polluer la base.
//   relogement.xlsx -> colonne id_f1
// Le camping dépose un seul fichier, qui doit s'appeler « relogement.xlsx »
// (ou .xls). Tout autre nom est refusé sans rien importer : mieux vaut un refus
// explicite qu'un fichier rangé sous le mauvais formulaire.
const FICHIERS_ATTENDUS = {
  relogement: { type: 'relogement', idColumn: 'id_f1', libelle: 'Formulaire relogement' },
};

function detectFileType(filename) {
  const base = String(filename).trim().toLowerCase();
  const sansExt = base.replace(/\.(xlsx|xls)$/, '');
  if (sansExt === base) return null;          // extension absente ou non gérée
  return FICHIERS_ATTENDUS[sansExt] || null;
}

// ---------------------------------------------------------------------------
// Suivi de progression en mémoire (une seule importation à la fois)
// ---------------------------------------------------------------------------
let currentJob = null; // { processed, total, done, error, result }

app.get('/api/import-progress', (req, res) => {
  if (!currentJob) {
    return res.json({ active: false });
  }
  res.json({
    active: true,
    processed: currentJob.processed,
    total: currentJob.total,
    percent: currentJob.total > 0 ? Math.round((currentJob.processed / currentJob.total) * 100) : 100,
    done: currentJob.done,
    error: currentJob.error,
    result: currentJob.done ? currentJob.result : null,
  });
});

app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu." });
    }

    const fileInfo = detectFileType(req.file.originalname);
    if (!fileInfo) {
      return res.status(400).json({
        error: `Nom de fichier non reconnu : "${req.file.originalname}". Le fichier doit s'appeler exactement "relogement.xlsx" (ou "relogement.xls"). Aucune donnée n'a été importée.`,
      });
    }

    // 1. Lecture du fichier xlsx
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Le fichier est vide.' });
    }

    // Le mapping dépend du formulaire : les deux fichiers n'ont ni les mêmes
    // questions, ni le même ordre de colonnes. La correspondance se fait sur
    // le libellé normalisé.
    const columnMap = FORM_COLUMN_MAPS[fileInfo.type];
    const actualHeaders = Object.keys(rows[0]);
    const { resolved, missing } = buildHeaderResolver(actualHeaders, columnMap);
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Colonnes introuvables dans le fichier "${req.file.originalname}" (${fileInfo.libelle}) : ${missing.join(', ')}. Aucune donnée n'a été importée.`,
      });
    }

    // 2. Valeur max de l'id de delta déjà en base pour ce type de fichier
    const idColumn = fileInfo.idColumn;
    const { data: maxRows, error: maxError } = await supabase
      .from('choix_client')
      .select(idColumn)
      .not(idColumn, 'is', null)
      .order(idColumn, { ascending: false })
      .limit(1);

    if (maxError) throw maxError;
    const maxId = maxRows && maxRows.length > 0 ? Number(maxRows[0][idColumn]) : 0;

    // 3. Filtrage du delta : uniquement les lignes avec Id strictement > maxId
    const newRows = rows.filter((r) => {
      const rawId = r[resolved.id];
      const idNum = Number(rawId);
      return rawId !== null && !Number.isNaN(idNum) && idNum > maxId;
    });

    const summary = {
      fichier: req.file.originalname,
      type_detecte: fileInfo.libelle,
      total_lignes_fichier: rows.length,
      dernier_id_connu: maxId,
      lignes_delta_a_importer: newRows.length,
      inserees: 0,
      statut_a_repondu: 0,
      statut_a_rappeler: 0,
      corrections_email: 0,
      // Répartition des méthodes de remboursement déterminées pendant l'import,
      // restituée dans le récapitulatif de fin.
      methodes: {},
      erreurs: [],
    };

    // On répond immédiatement pour ne pas laisser la requête HTTP ouverte pendant
    // tout le traitement : le client va suivre la progression via /api/import-progress.
    currentJob = { processed: 0, total: newRows.length, done: false, error: null, result: null };
    res.json({ started: true, total: newRows.length });

    // 4. Traitement ligne par ligne, en tâche de fond (après la réponse HTTP)
    try {
      for (const row of newRows) {
        const get = (key) => {
          const v = row[resolved[key]];
          if (v === null || v === undefined) return null;
          const s = String(v).trim();
          return s === '' ? null : s;
        };

        const email = get('email');
        const numResa = get('num_resa');

        // 4a. Vérification principale : correspondance sur le numéro de réservation
        let matchedMasterId = null;
        // Les modes de paiement du séjour sont récupérés dès le rapprochement :
        // ils servent ensuite à déterminer la méthode de remboursement.
        let matchedModesPaiement = null;
        if (numResa) {
          const { data: masterMatch, error: masterErr } = await supabase
            .from('master_sejours')
            .select('id, modes_paiement')
            .ilike('numero_reservation', numResa)
            .limit(1);
          if (masterErr) throw masterErr;
          if (masterMatch && masterMatch.length > 0) {
            matchedMasterId = masterMatch[0].id;
            matchedModesPaiement = masterMatch[0].modes_paiement;
          }
        }

        // 4b. Vérification secondaire : si pas de correspondance sur le numéro de réservation
        // (probable faute de frappe côté client), on recherche par email. On ne considère
        // la correspondance comme fiable que si l'email pointe vers une unique ligne dans
        // master_sejours ; en cas de correspondances multiples (ou absence), on ne change rien.
        let matchedViaEmail = false;
        if (!matchedMasterId && email) {
          const { data: emailMatches, error: emailErr } = await supabase
            .from('master_sejours')
            .select('id, modes_paiement')
            .ilike('email', email);
          if (emailErr) throw emailErr;
          if (emailMatches && emailMatches.length === 1) {
            matchedMasterId = emailMatches[0].id;
            matchedModesPaiement = emailMatches[0].modes_paiement;
            matchedViaEmail = true;
          }
        }

        const statut = matchedMasterId ? 'A répondu' : 'Match incorrect';

        // On alimente tous les champs métier connus : ceux qui n'existent pas
        // dans ce formulaire (ex. "situation" pour le formulaire 1) restent à
        // null, la colonne existant malgré tout en base.
        const insertPayload = { statut };
        for (const field of FORM_IMPORT_FIELDS) {
          insertPayload[field] = field in resolved ? get(field) : null;
        }
        insertPayload.email = email;
        insertPayload.num_resa = numResa;
        const rawId = Number(row[resolved.id]);
        if (idColumn === 'id_f1') insertPayload.id_f1 = rawId;
        if (idColumn === 'id_f2') insertPayload.id_f2 = rawId;
        if (idColumn === 'id_f3') insertPayload.id_f3 = rawId;

        const { data: inserted, error: insertError } = await supabase
          .from('choix_client')
          .insert(insertPayload)
          .select('id')
          .single();

        if (insertError) {
          summary.erreurs.push(`Id ${rawId} (${email || 'sans email'}) : ${insertError.message}`);
          currentJob.processed += 1;
          continue;
        }

        summary.inserees += 1;
        if (matchedMasterId) {
          summary.statut_a_repondu += 1;
          if (matchedViaEmail) summary.corrections_email += 1;

          // La méthode de remboursement est déterminée ici, une fois pour
          // toutes : le choix du client confronté aux paiements du PMS.
          const decision = calculerDecisionClient(insertPayload);
          const methode = calculerMethodeRemboursement(insertPayload, matchedModesPaiement);
          // Un relogement n'a pas de méthode : on le dit explicitement dans le
          // récapitulatif plutôt que d'afficher une ligne « null ».
          const libelleMethode = methode === null ? 'Sans objet (relogement)' : methode;
          summary.methodes[libelleMethode] = (summary.methodes[libelleMethode] || 0) + 1;

          const { error: updateError } = await supabase
            .from('master_sejours')
            .update({
              id_choix_client: inserted.id,
              methode_remboursement: methode,
              decision_client: decision,
            })
            .eq('id', matchedMasterId);
          if (updateError) {
            summary.erreurs.push(`Id ${rawId} : échec update master_sejours (${updateError.message})`);
          }
        } else {
          summary.statut_a_rappeler += 1;
        }

        currentJob.processed += 1;
      }

      currentJob.done = true;
      currentJob.result = summary;
    } catch (bgErr) {
      console.error(bgErr);
      currentJob.done = true;
      currentJob.error = bgErr.message || 'Erreur serveur inattendue.';
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: messageErreurLisible(err) });
    }
  }
});

// ---------------------------------------------------------------------------
// Dashboards : liste paginée/filtrée des lignes choix_client + changement
// manuel de statut. Ajouté en plus de l'import, sans rien modifier ci-dessus.
// ---------------------------------------------------------------------------
const CLIENT_COLUMNS =
  'id, id_f1, id_f2, id_f3, langue, nom, prenom, email, num_resa, choix, situation, je_choisis, je_decide, nous_proposons, method_remb, iban, bic, info_banque, statut';
// Statuts d'une réponse au formulaire, du point de vue du call center :
// soit la réponse a trouvé son séjour, soit le rapprochement a échoué et la
// ligne doit être reprise à la main. Sans rapport avec master_sejours.action_camping,
// qui est le drapeau de rappel posé par le camping sur un séjour.
const VALID_STATUTS = ['A répondu', 'Match incorrect'];

// PostgREST renvoie une erreur quand la tranche demandée dépasse le nombre de
// lignes disponibles (page 40 alors qu'il n'en reste que 3, par exemple après
// application d'un filtre). Ce n'est pas une anomalie : on répond une liste
// vide accompagnée du total réel, ce qui permet à l'interface de recalculer
// sa pagination au lieu d'afficher une erreur technique.
const ERREUR_TRANCHE_DEPASSEE = 'PGRST103';
// Lecture d'une ligne unique qui n'existe pas : à traduire en 404, pas en 500.
const ERREUR_AUCUNE_LIGNE = 'PGRST116';

// ---------------------------------------------------------------------------
// Tri des tableaux au clic sur l'entête de colonne.
//
// Le tri est fait par la base et non dans le navigateur : les listes étant
// paginées, trier seulement les 50 lignes affichées donnerait un résultat faux.
// La colonne demandée est systématiquement confrontée à une liste blanche,
// pour qu'aucun nom de colonne arbitraire ne puisse être injecté.
//
// Une entrée peut viser plusieurs colonnes réelles : c'est le cas des colonnes
// d'écran qui en agrègent deux (« Choix du client » = choix + je_choisis).
// ---------------------------------------------------------------------------
function parseTri(query, colonnesAutorisees, triParDefaut) {
  const demande = String(query.tri || '').trim();
  const sens = String(query.sens || '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
  const cible = colonnesAutorisees[demande];
  if (!cible) return triParDefaut;
  return { colonnes: cible, ascending: sens === 'asc' };
}

// Applique le tri demandé, puis départage les ex aequo. Deux niveaux de
// départage : d'abord le nom et le prénom (trier par langue laisse ainsi
// chaque langue classée alphabétiquement, ce qui est plus lisible), puis
// l'identifiant qui garantit un ordre stable — sans lui, deux lignes de même
// valeur pourraient changer de place d'une page à l'autre.
function appliquerTri(query, tri) {
  tri.colonnes.forEach((colonne) => {
    // Les valeurs vides sont toujours renvoyées en fin de liste, dans les deux
    // sens de tri : une cellule non renseignée n'est pas une petite valeur.
    query = query.order(colonne, { ascending: tri.ascending, nullsFirst: false });
  });
  ['nom', 'prenom'].forEach((colonne) => {
    if (!tri.colonnes.includes(colonne)) {
      query = query.order(colonne, { ascending: true, nullsFirst: false });
    }
  });
  return query.order('id', { ascending: true });
}

function estHorsTranche(error) {
  return error && (error.code === ERREUR_TRANCHE_DEPASSEE || /range not satisfiable/i.test(error.message || ''));
}

// Certaines requêtes (une recherche contenant un motif ressemblant à une
// injection SQL, par exemple) sont bloquées en amont par le pare-feu de
// l'hébergeur, qui répond une page HTML entière. Sans ce filtre, cette page
// serait affichée telle quelle dans l'interface.
function messageErreurLisible(err) {
  const brut = (err && err.message) || '';
  if (/^\s*<(!doctype|html)/i.test(brut) || brut.length > 300) {
    return "La recherche n'a pas pu être exécutée. Merci de reformuler avec des lettres et des chiffres.";
  }
  return brut || 'Erreur serveur inattendue.';
}
const EDITABLE_FIELDS = ['langue', 'nom', 'prenom', 'email', 'num_resa', 'choix', 'situation', 'je_choisis', 'je_decide', 'nous_proposons', 'method_remb', 'iban', 'bic', 'info_banque'];

function escapeForOrFilter(value) {
  // PostgREST exige que les valeurs contenant une virgule ou une parenthèse
  // soient entourées de guillemets doubles dans un filtre .or(...).
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function cleanValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ---------------------------------------------------------------------------
// Filtres des vues "A répondu" / "Match incorrect". Même principe que les séjours :
// une seule source de vérité partagée par la liste et par l'export.
// ---------------------------------------------------------------------------
function parseClientsFilters(query) {
  return {
    statut: query.statut,
    search: (query.search || '').toString().trim(),
    source: parseList(query.source),                 // relogement (unique formulaire)
    langue: parseList(query.langue),
    situation: parseList(query.situation),
    choix: parseList(query.choix),                   // fusion choix + je_choisis
    jeDecide: parseList(query.je_decide),
    methodRemb: parseList(query.method_remb),
    tri: parseTri(query, CLIENTS_TRI_AUTORISE, CLIENTS_TRI_DEFAUT),
  };
}

function applyClientsFilters(query, f) {
  if (f.search) {
    const like = escapeForOrFilter(`%${f.search}%`);
    query = query.or(
      `nom.ilike.${like},prenom.ilike.${like},email.ilike.${like},num_resa.ilike.${like}`
    );
  }

  // Source : déterminée par la colonne d'identifiant renseignée. Cocher toutes
  // les sources revient à n'en filtrer aucune, d'où la comparaison au nombre
  // total de formulaires.
  const demandees = SOURCES_FORMULAIRE.filter((src) => f.source.includes(src.cle));
  if (demandees.length === 1) {
    query = query.not(demandees[0].colonne, 'is', null);
  } else if (demandees.length > 1 && demandees.length < SOURCES_FORMULAIRE.length) {
    query = query.or(demandees.map((src) => `${src.colonne}.not.is.null`).join(','));
  }

  if (f.langue.length) query = query.in('langue', f.langue);
  if (f.situation.length) query = query.in('situation', f.situation);
  if (f.jeDecide.length) query = query.in('je_decide', f.jeDecide);
  if (f.methodRemb.length) query = query.in('method_remb', f.methodRemb);

  // "Choix du client" regroupe deux colonnes selon le formulaire d'origine :
  // une valeur cochée peut donc venir de l'une ou de l'autre.
  if (f.choix.length) {
    const clauses = f.choix
      .map((v) => `choix.eq.${escapeForOrFilter(v)},je_choisis.eq.${escapeForOrFilter(v)},nous_proposons.eq.${escapeForOrFilter(v)}`)
      .join(',');
    query = query.or(clauses);
  }

  return query;
}

// Colonnes triables des vues "A répondu" / "Match incorrect".
// Deux colonnes d'écran n'existent pas telles quelles en base :
//   - « Source » est déduite de l'identifiant renseigné : trier successivement
//     sur les trois regroupe les réponses par formulaire d'origine ;
//   - « Choix du client » fusionne trois colonnes selon le formulaire d'origine,
//     on trie donc successivement sur l'une puis sur les autres.
const CLIENTS_TRI_AUTORISE = {
  id: ['id'],
  nom: ['nom', 'prenom'],
  prenom: ['prenom', 'nom'],
  email: ['email'],
  num_resa: ['num_resa'],
  source: ['id_f1', 'id_f2', 'id_f3'],
  langue: ['langue'],
  situation: ['situation'],
  choix: ['choix', 'je_choisis', 'nous_proposons'],
  je_decide: ['je_decide'],
  method_remb: ['method_remb'],
  iban: ['iban'],
  bic: ['bic'],
  info_banque: ['info_banque'],
};

const CLIENTS_TRI_DEFAUT = { colonnes: ['nom', 'prenom'], ascending: true };

function buildClientsQuery(filters, { count = false } = {}) {
  let query = supabase
    .from('choix_client')
    .select(CLIENT_COLUMNS, count ? { count: 'exact' } : undefined)
    .eq('statut', filters.statut);
  query = appliquerTri(query, filters.tri);
  return applyClientsFilters(query, filters);
}

// Valeurs réellement présentes, pour alimenter les listes de choix.
app.get('/api/clients/filter-options', async (req, res) => {
  try {
    const statut = req.query.statut;
    if (!VALID_STATUTS.includes(statut)) {
      return res.status(400).json({ error: 'Paramètre statut invalide.' });
    }

    const CHUNK = 1000;
    const langues = new Set();
    const situations = new Set();
    const choix = new Set();
    const jeDecide = new Set();
    const methodes = new Set();
    let aFormulaire1 = false;
    let aFormulaire2 = false;
    let aFormulaire3 = false;

    for (let from = 0; ; from += CHUNK) {
      const { data, error } = await supabase
        .from('choix_client')
        .select('id_f1, id_f2, id_f3, langue, situation, choix, je_choisis, je_decide, nous_proposons, method_remb')
        .eq('statut', statut)
        .range(from, from + CHUNK - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const r of data) {
        if (r.id_f1 !== null && r.id_f1 !== undefined) aFormulaire1 = true;
        if (r.id_f2 !== null && r.id_f2 !== undefined) aFormulaire2 = true;
        if (r.id_f3 !== null && r.id_f3 !== undefined) aFormulaire3 = true;
        if (r.langue) langues.add(r.langue);
        if (r.situation) situations.add(r.situation);
        if (r.choix) choix.add(r.choix);
        if (r.je_choisis) choix.add(r.je_choisis);
        if (r.nous_proposons) choix.add(r.nous_proposons);
        if (r.je_decide) jeDecide.add(r.je_decide);
        if (r.method_remb) methodes.add(r.method_remb);
      }
      if (data.length < CHUNK) break;
    }

    const sources = [];
    if (aFormulaire1) sources.push({ value: 'relogement', label: 'Relogement' });

    res.json({
      source: sources,
      langue: [...langues].sort(),
      situation: [...situations].sort(),
      choix: [...choix].sort(),
      je_decide: [...jeDecide].sort(),
      method_remb: [...methodes].sort(),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const statut = req.query.statut;
    if (!VALID_STATUTS.includes(statut)) {
      return res.status(400).json({ error: 'Paramètre statut invalide.' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const filters = parseClientsFilters(req.query);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await buildClientsQuery(filters, { count: true }).range(from, to);
    if (error) {
      if (estHorsTranche(error)) {
        const { count: total } = await buildClientsQuery(filters, { count: true }).range(0, 0);
        return res.json({ rows: [], total: total || 0, page, pageSize });
      }
      throw error;
    }

    res.json({ rows: data, total: count, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/clients/export : export Excel de la sélection courante, au format
// des fichiers de réponses Forms (mêmes intitulés de colonnes).
// ---------------------------------------------------------------------------
const CLIENTS_EXPORT_COLUMNS = [
  ['id_source', 'ID'],
  ['langue', 'Langue'],
  ['nom', 'Nom2'],
  ['prenom', 'Prénom'],
  ['email', 'Email'],
  ['num_resa', 'Numéro de réservation (ex: O20260103...)'],
  ['choix', 'Que souhaitez-vous faire ?'],
  ['situation', 'Quelle est votre situation ?'],
  ['je_choisis', 'Je choisis'],
  ['method_remb', 'Selon votre mode de règlement, quelle est votre méthode de remboursement ?'],
  ['iban', 'Indiquez votre IBAN (RIB)'],
  ['bic', 'Indiquez votre BIC/SWIFT'],
  ['info_banque', 'Nom et adresse de la banque bénéficiaire'],
  ['je_decide', 'Je décide'],
  ['nous_proposons', 'Afin de vous permettre de vous organiser au mieux, nous vous proposons de :'],
  ['source', 'Formulaire'],
  ['statut', 'Statut'],
];

// Une réponse appartient à un seul formulaire : l'identifiant renseigné dit
// lequel. Sert à reconstituer les colonnes « ID » et « Formulaire » de l'export
// et l'étiquette de source affichée dans les tableaux.
//
// La clé est celle échangée avec le navigateur, et c'est aussi le nom du
// fichier attendu à l'import : un même vocabulaire d'un bout à l'autre.
// Un seul formulaire : id_f2 et id_f3 existent en base mais restent vides, le
// schéma étant commun à tous les campings.
const SOURCES_FORMULAIRE = [
  { cle: 'relogement', colonne: 'id_f1', libelle: 'Relogement' },
];

function sourceDeLaReponse(row) {
  return SOURCES_FORMULAIRE.find((s) => row[s.colonne] !== null && row[s.colonne] !== undefined) || null;
}

// La Liste séjours affiche le formulaire d'origine de la réponse rattachée, une
// information nettement plus parlante que l'identifiant interne qui y figurait.
// Elle vit dans choix_client : on l'ajoute aux lignes après coup, en une seule
// lecture pour toute la page affichée (200 lignes au maximum).
// Libellé affiché à l'écran comme à l'export : le formulaire rempli par le
// client, suivi du nom du fichier à redéposer dans l'onglet Import. Un séjour
// sans réponse rattachée reste vide ; une réponse dont le formulaire serait
// indéterminable retombe sur son identifiant plutôt que sur une cellule muette.
const LIBELLES_SOURCE_FORMS = {
  relogement: 'Relogement (relogement.xlsx)',
};

function libelleSourceForms(row) {
  if (row.id_choix_client === null || row.id_choix_client === undefined) return '';
  return LIBELLES_SOURCE_FORMS[row.source_forms] || String(row.id_choix_client);
}

// PostgREST passe les filtres dans l'URL, et Supabase refuse les requêtes dont
// les entêtes HTTP dépassent 16 Ko. Un `.in('id', [...])` de quelques milliers
// d'identifiants dépasse ce plafond : l'écran, paginé à 200 lignes, ne le voyait
// jamais, mais l'export porte sur toute la sélection et échouait en erreur 500
// dès que plus d'un millier de séjours étaient rattachés à une réponse.
// On interroge donc par tranches.
const TRANCHE_IDS_SOURCE = 300;

async function ajouterSourceForms(rows) {
  const ids = [...new Set(rows.map((r) => r.id_choix_client).filter((v) => v !== null && v !== undefined))];
  if (ids.length === 0) {
    rows.forEach((r) => { r.source_forms = null; });
    return rows;
  }
  const reponses = [];
  for (let i = 0; i < ids.length; i += TRANCHE_IDS_SOURCE) {
    const { data, error } = await supabase
      .from('choix_client')
      .select('id, id_f1, id_f2, id_f3')
      .in('id', ids.slice(i, i + TRANCHE_IDS_SOURCE));
    if (error) throw error;
    if (data) reponses.push(...data);
  }
  const data = reponses;
  const parId = new Map((data || []).map((r) => [r.id, sourceDeLaReponse(r)]));
  rows.forEach((r) => {
    const source = parId.get(r.id_choix_client);
    r.source_forms = source ? source.cle : null;
  });
  return rows;
}

const CLIENTS_EXPORT_TEXT_COLUMNS = new Set(['num_resa', 'iban', 'bic']);

app.get('/api/clients/export', async (req, res) => {
  try {
    const filters = parseClientsFilters(req.query);
    if (!VALID_STATUTS.includes(filters.statut)) {
      return res.status(400).json({ error: 'Paramètre statut invalide.' });
    }

    const CHUNK = 1000;
    const rows = [];
    for (let from = 0; ; from += CHUNK) {
      const { data, error } = await buildClientsQuery(filters).range(from, from + CHUNK - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < CHUNK) break;
    }

    const header = CLIENTS_EXPORT_COLUMNS.map(([, label]) => label);
    const sheet = XLSX.utils.aoa_to_sheet([header]);

    const body = rows.map((row) =>
      CLIENTS_EXPORT_COLUMNS.map(([key]) => {
        // Deux colonnes reconstituées : l'identifiant d'origine dans le
        // formulaire, et le formulaire dont provient la réponse.
        const source = sourceDeLaReponse(row);
        if (key === 'id_source') return source ? row[source.colonne] : '';
        if (key === 'source') return source ? source.libelle : '';
        const v = row[key];
        if (v === null || v === undefined) return '';
        return CLIENTS_EXPORT_TEXT_COLUMNS.has(key) ? String(v) : v;
      })
    );
    XLSX.utils.sheet_add_aoa(sheet, body, { origin: 'A2' });

    // Format texte forcé : sans cela Excel réinterprète les IBAN et les
    // numéros de réservation, avec perte de zéros ou passage en notation
    // scientifique.
    CLIENTS_EXPORT_COLUMNS.forEach(([key], colIndex) => {
      if (!CLIENTS_EXPORT_TEXT_COLUMNS.has(key)) return;
      for (let i = 0; i < body.length; i += 1) {
        const ref = XLSX.utils.encode_cell({ c: colIndex, r: i + 1 });
        const cell = sheet[ref];
        if (cell && cell.v !== '') { cell.t = 's'; cell.z = '@'; }
      }
    });

    sheet['!cols'] = CLIENTS_EXPORT_COLUMNS.map(([, label]) => ({ wch: Math.min(45, Math.max(12, label.length + 2)) }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Réponses');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const stamp = new Date().toISOString().slice(0, 10);
    const suffixe = filters.statut === 'A répondu' ? 'a_repondu' : 'a_rappeler';
    const filename = `reponses_${suffixe}_${stamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Rows', String(rows.length));
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// GET /api/clients/:id : lecture d'une seule réponse au formulaire. Utilisé par
// la fiche séjour pour afficher/éditer la réponse liée sans quitter la page.
app.get('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });

    const { data, error } = await supabase
      .from('choix_client')
      .select(CLIENT_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Réponse formulaire introuvable.' });

    res.json({ row: data });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

app.patch('/api/clients/:id/statut', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const statut = req.body ? req.body.statut : null;

    if (!id || !VALID_STATUTS.includes(statut)) {
      return res.status(400).json({ error: 'Requête invalide.' });
    }

    const { error } = await supabase.from('choix_client').update({ statut }).eq('id', id);
    if (error) throw error;

    res.json({ ok: true, id, statut });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// PUT /api/clients/:id : édition complète d'une ligne (pop-in du dashboard).
// Après la mise à jour, on relie/délie automatiquement master_sejours en
// relançant exactement le même matching que lors de l'import (numéro de
// réservation en priorité, puis email si correspondance unique), afin que
// master_sejours.id_choix_client reste la source de vérité de l'avancement.
app.put('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const body = req.body || {};
    const requestedStatut = body.statut;
    if (!VALID_STATUTS.includes(requestedStatut)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }

    // Même principe que pour les séjours : une colonne absente du corps de la
    // requête n'est pas écrasée. Le rapprochement qui suit a besoin de la
    // réponse complète, on part donc de la ligne existante et on n'y applique
    // que les champs réellement transmis.
    const { data: existant, error: lectureError } = await supabase
      .from('choix_client')
      .select(CLIENT_COLUMNS)
      .eq('id', id)
      .single();
    if (lectureError) {
      if (lectureError.code === ERREUR_AUCUNE_LIGNE) {
        return res.status(404).json({ error: 'Réponse introuvable : aucune modification enregistrée.' });
      }
      throw lectureError;
    }

    const fields = {};
    for (const field of EDITABLE_FIELDS) {
      fields[field] = field in body ? cleanValue(body[field]) : cleanValue(existant[field]);
    }

    // 1. On délie toute ligne master_sejours qui pointait vers cette ligne :
    //    le numéro de réservation / email a pu changer, le lien doit être recalculé.
    //    La méthode de remboursement part avec le lien : elle découle de la
    //    réponse du client, un séjour qui n'en a plus ne doit pas garder la
    //    valeur héritée du rapprochement précédent.
    const { error: unlinkError } = await supabase
      .from('master_sejours')
      .update({ id_choix_client: null, methode_remboursement: null, decision_client: null })
      .eq('id_choix_client', id);
    if (unlinkError) throw unlinkError;

    // 2. Nouveau matching : numéro de réservation en priorité, puis email
    //    si une seule ligne de master_sejours correspond.
    const email = fields.email;
    const numResa = fields.num_resa;
    let matchedMasterId = null;
    let matchedVia = null;

    // Les modes de paiement du séjour sont récupérés dès la recherche : ils
    // servent ensuite à déterminer la méthode de remboursement.
    let matchedModesPaiement = null;

    if (numResa) {
      const { data: masterMatch, error: masterErr } = await supabase
        .from('master_sejours')
        .select('id, modes_paiement')
        .ilike('numero_reservation', numResa)
        .limit(1);
      if (masterErr) throw masterErr;
      if (masterMatch && masterMatch.length > 0) {
        matchedMasterId = masterMatch[0].id;
        matchedModesPaiement = masterMatch[0].modes_paiement;
        matchedVia = 'numero_reservation';
      }
    }

    if (!matchedMasterId && email) {
      const { data: emailMatches, error: emailErr } = await supabase
        .from('master_sejours')
        .select('id, modes_paiement')
        .ilike('email', email);
      if (emailErr) throw emailErr;
      if (emailMatches && emailMatches.length === 1) {
        matchedMasterId = emailMatches[0].id;
        matchedModesPaiement = emailMatches[0].modes_paiement;
        matchedVia = 'email';
      }
    }

    // Même règle que l'import : une correspondance trouvée force "A répondu",
    // quel que soit le statut choisi dans le formulaire. Sans correspondance,
    // on respecte le statut choisi manuellement par le collaborateur.
    const finalStatut = matchedMasterId ? 'A répondu' : requestedStatut;
    const statutForced = !!matchedMasterId && requestedStatut !== 'A répondu';

    // 3. Mise à jour de la ligne choix_client avec les champs + le statut final
    const { data: updatedRow, error: updateError } = await supabase
      .from('choix_client')
      .update({ ...fields, statut: finalStatut })
      .eq('id', id)
      .select(CLIENT_COLUMNS)
      .single();
    if (updateError) {
      // Aucune ligne mise à jour : la réponse n'existe pas (ou plus).
      if (updateError.code === ERREUR_AUCUNE_LIGNE) {
        return res.status(404).json({ error: 'Réponse introuvable : aucune modification enregistrée.' });
      }
      throw updateError;
    }

    let overwroteOtherLink = false;
    let methodeCalculee = null;
    let decisionCalculee = null;
    if (matchedMasterId) {
      const { data: existingLink, error: existingErr } = await supabase
        .from('master_sejours')
        .select('id_choix_client')
        .eq('id', matchedMasterId)
        .single();
      if (existingErr) throw existingErr;
      if (existingLink && existingLink.id_choix_client && existingLink.id_choix_client !== id) {
        overwroteOtherLink = true;
      }

      // La méthode est recalculée ici et non seulement à l'import : c'est le
      // rapprochement qui la déclenche, d'où qu'il vienne. On part de la ligne
      // telle qu'elle vient d'être enregistrée, pas du formulaire soumis.
      methodeCalculee = calculerMethodeRemboursement(updatedRow, matchedModesPaiement);
      decisionCalculee = calculerDecisionClient(updatedRow);

      const { error: linkError } = await supabase
        .from('master_sejours')
        .update({
          id_choix_client: id,
          methode_remboursement: methodeCalculee,
          decision_client: decisionCalculee,
        })
        .eq('id', matchedMasterId);
      if (linkError) throw linkError;
    }

    res.json({
      ok: true,
      row: updatedRow,
      match: {
        matched: !!matchedMasterId,
        via: matchedVia,
        masterId: matchedMasterId,
        overwroteOtherLink,
        statutForced,
        // Restituée pour que l'utilisateur sache immédiatement comment le
        // dossier devra être remboursé, sans aller rouvrir la Liste séjours.
        methode: methodeCalculee,
        decision: decisionCalculee,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// DELETE /api/clients/:id : suppression définitive d'une ligne choix_client
// (utilisé depuis le dashboard "Match incorrect" pour nettoyer les doublons).
// On délie d'abord toute ligne master_sejours qui pointait vers cette ligne,
// pour ne jamais laisser une référence orpheline vers un choix_client supprimé.
app.delete('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    // La méthode de remboursement et la décision découlent de la réponse : elles
    // partent avec elle. Sans ça, un séjour dont on supprime la réponse garderait
    // « Virement » ou « Annulé » sans qu'aucun client ne l'ait jamais demandé.
    const { error: unlinkError } = await supabase
      .from('master_sejours')
      .update({ id_choix_client: null, methode_remboursement: null, decision_client: null })
      .eq('id_choix_client', id);
    if (unlinkError) throw unlinkError;

    const { error: deleteError } = await supabase
      .from('choix_client')
      .delete()
      .eq('id', id);
    if (deleteError) throw deleteError;

    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// ---------------------------------------------------------------------------
// Onglet "Liste séjours" : lecture de la table master_sejours, avec édition
// d'une ligne via pop-in. Structure alignée sur le référentiel commun
// multi-camping (template La Rive).
// ---------------------------------------------------------------------------

// Toutes les colonnes sont renvoyées : le tableau n'en affiche qu'une partie,
// mais la pop-in d'édition les utilise toutes sans requête supplémentaire
// (même principe que le cache rowsById des dashboards choix_client).
const SEJOURS_FULL_COLUMNS =
  'id, nom_entreprise, numero_client_groupe, nom, prenom, email, telephone_fixe, telephone_portable, type_to_ce, nom_to, prenom_to, email_to, telephone_fixe_to, telephone_portable_to, date_debut_sejour, date_depart_sejour, nombre_personnes, categorie_pms, quartier, numero_emplacement, numero_reservation, montant_sejour_ttc, montant_regle, assurance_annulation, fidelity_use, fidelity_map, modes_paiement, transactions_lyra, canal_saisie, sales_channel_brut, canal_reservation_online, type_origine_code, situation, situation_desc, statut_emplacement, nom_prenom, statut_client, mailing_1, date_envoi_m1, mailing_2, date_envoi_m2, mailing_3, date_envoi_m3, los, montant_ht_nuit, nuits_non_consommees, calcul_rbs_nuits_non_consommees, date_entree_relogement, date_sortie_relogement, camping_relogement, relogements_detail, remboursement, methode_remboursement, decision_client, commentaire_remboursement, action_camping, commentaire_camping, id_choix_client, relogement_statut, relogement_hebergement, remise_statut, remise_taux';

// Champs modifiables depuis la pop-in. Sont volontairement exclus :
//   - les identifiants (id, id_choix_client), gérés par le rapprochement ;
//   - les montants (montant_sejour_ttc, montant_regle), données financières
//     issues du PMS qui ne doivent pas être retouchées à la main ;
//   - les deux montants calculés par le siège (montant_ht_nuit et
//     calcul_rbs_nuits_non_consommees). Ils se déduisent du montant TTC, du
//     nombre de nuits et des nuits non consommées ; la division tombe rarement
//     juste et la base porte une quinzaine de décimales. Les rendre modifiables
//     exposait à écraser cette précision par un arrondi de saisie, et
//     désalignait l'outil du fichier maître. Ils restent affichés dans la fiche,
//     en lecture seule.
// L'exclusion vaut pour toute la route PUT, pas seulement pour l'écran : une
// requête forgée qui les contiendrait les ignorerait tout autant.
const SEJOUR_TEXT_FIELDS = [
  'nom_entreprise', 'nom', 'prenom', 'email', 'telephone_fixe', 'telephone_portable',
  'type_to_ce', 'nom_to', 'prenom_to', 'email_to', 'telephone_fixe_to', 'telephone_portable_to',
  'categorie_pms', 'numero_emplacement', 'numero_reservation', 'fidelity_map',
  'modes_paiement', 'transactions_lyra', 'canal_saisie', 'canal_reservation_online',
  'remboursement', 'methode_remboursement', 'decision_client', 'commentaire_remboursement',
  'action_camping', 'commentaire_camping', 'statut_client',
  'relogement_statut', 'relogement_hebergement', 'remise_statut', 'mailing_1', 'mailing_2', 'mailing_3', 'camping_relogement',
  'situation_desc', 'nom_prenom',
];
const SEJOUR_INTEGER_FIELDS = [
  'numero_client_groupe', 'nombre_personnes', 'fidelity_use', 'sales_channel_brut',
  'type_origine_code', 'los', 'nuits_non_consommees', 'situation',
];
const SEJOUR_NUMERIC_FIELDS = ['assurance_annulation', 'remise_taux'];
const SEJOUR_DATE_FIELDS = [
  'date_debut_sejour', 'date_depart_sejour',
  'date_envoi_m1', 'date_envoi_m2', 'date_envoi_m3',
  'date_entree_relogement', 'date_sortie_relogement',
];

// Valeurs autorisées pour le suivi du remboursement (liste déroulante côté
// pop-in). Toute autre valeur est refusée pour garder la colonne exploitable.
const REMBOURSEMENT_VALUES = new Set(['Oui', 'Non', 'Partiel']);

// Action que le camping se réserve sur un séjour. Volontairement distincte du
// statut de la réponse au formulaire, qui appartient au call center : ici le
// camping signale un client qu'il ne veut pas oublier de rappeler.
const ACTIONS_CAMPING = ['A rappeler'];

// Valeur envoyée par le navigateur pour filtrer sur « pas encore renseigné ».
// Volontairement encadrée de doubles tirets bas pour ne jamais entrer en
// collision avec une valeur métier saisie par le camping.
const FILTRE_VALEUR_VIDE = '__vide__';

function cleanInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function cleanNumeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function cleanDate(v) {
  if (v === null || v === undefined || v === '') return null;
  return v; // attendu au format YYYY-MM-DD (input type="date")
}

// Filtres de la vue "Liste séjours", centralisés ici pour que la liste
// paginée et l'export Excel renvoient TOUJOURS le même périmètre de lignes.
// Tout nouveau filtre doit être ajouté uniquement dans cette fonction : il
// sera automatiquement pris en compte par l'export.
function parseList(value) {
  // Les filtres à choix multiples arrivent sous forme "a|b|c" (séparateur peu
  // susceptible d'apparaître dans les valeurs métier).
  if (value === undefined || value === null) return [];
  // Un paramètre répété dans l'URL (?f=a&f=b) arrive sous forme de tableau.
  // L'interface n'en produit pas, mais une URL construite à la main le ferait,
  // et sans ce cas la sélection était silencieusement vide.
  const brut = Array.isArray(value) ? value.join('|') : String(value);
  return brut
    .split('|')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function parseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function parseDate(value) {
  const s = (value || '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseSejoursFilters(query) {
  return {
    search: (query.search || '').toString().trim(),
    arriveeDu: parseDate(query.arrivee_du),
    arriveeAu: parseDate(query.arrivee_au),
    departDu: parseDate(query.depart_du),
    departAu: parseDate(query.depart_au),
    nombrePersonnes: parseList(query.nombre_personnes).map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n)),
    ttcMin: parseNumber(query.ttc_min),
    ttcMax: parseNumber(query.ttc_max),
    regleMin: parseNumber(query.regle_min),
    regleMax: parseNumber(query.regle_max),
    remboursement: parseList(query.remboursement),
    statutClient: parseList(query.statut_client),
    // "1" => ne garder que les lignes où le mailing est renseigné
    mailing1: query.mailing_1 === '1',
    mailing2: query.mailing_2 === '1',
    mailing3: query.mailing_3 === '1',
    categoriePms: parseList(query.categorie_pms),
    quartier: parseList(query.quartier),
    relogementStatut: parseList(query.relogement_statut),
    remiseStatut: parseList(query.remise_statut),
    modesPaiement: parseList(query.modes_paiement),
    // Liste cochée : 'avec' (nuits utilisées) et/ou 'sans' (aucune nuit).
    // Rien de coché => aucun filtre, comme pour les autres familles.
    fidelite: parseList(query.fidelite),
    // 'avec' => séjour rattaché à une réponse formulaire, 'sans' => sans réponse.
    reponseForms: parseList(query.reponse_forms),
    sourceForms: parseList(query.source_forms),   // relogement (unique formulaire)
    actionCamping: parseList(query.action_camping),
    // Situation du client au moment de l'incident (Présent / Réservation / Parti).
    methodeRemboursement: parseList(query.methode_remboursement),
    decisionClient: parseList(query.decision_client),
    situationDesc: parseList(query.situation_desc),
    statutEmplacement: parseList(query.statut_emplacement),
    // Présence au camping le 28 juillet : 'oui' (1) et/ou 'non' (0).
    // Rien de coché => aucun filtre, comme pour les autres familles.
    // 'et' => le séjour doit contenir TOUS les modes cochés ; 'ou' (défaut) =>
    // au moins l'un d'eux.
    modesPaiementOperateur: (query.modes_paiement_op || 'ou').toString().trim().toLowerCase() === 'et' ? 'et' : 'ou',
    campingRelogement: parseList(query.camping_relogement),
    tri: parseTri(query, SEJOURS_TRI_AUTORISE, SEJOURS_TRI_DEFAUT),
  };
}

// Tous les filtres se cumulent en ET (chaque appel ajoute une contrainte).
function applySejoursFilters(query, f) {
  if (f.search) {
    const like = escapeForOrFilter(`%${f.search}%`);
    query = query.or(
      `nom.ilike.${like},prenom.ilike.${like},email.ilike.${like},numero_reservation.ilike.${like}`
    );
  }

  if (f.arriveeDu) query = query.gte('date_debut_sejour', f.arriveeDu);
  if (f.arriveeAu) query = query.lte('date_debut_sejour', f.arriveeAu);
  if (f.departDu) query = query.gte('date_depart_sejour', f.departDu);
  if (f.departAu) query = query.lte('date_depart_sejour', f.departAu);

  if (f.nombrePersonnes.length) query = query.in('nombre_personnes', f.nombrePersonnes);

  if (f.ttcMin !== null) query = query.gte('montant_sejour_ttc', f.ttcMin);
  if (f.ttcMax !== null) query = query.lte('montant_sejour_ttc', f.ttcMax);
  if (f.regleMin !== null) query = query.gte('montant_regle', f.regleMin);
  if (f.regleMax !== null) query = query.lte('montant_regle', f.regleMax);

  // Remboursement : aux trois valeurs métier s'ajoute une option « Vide », qui
  // isole les dossiers pas encore traités. Elle est indispensable au camping :
  // la colonne n'a pas de valeur par défaut, un dossier non traité vaut null et
  // aucun des trois choix ne permettait de le retrouver.
  // Une saisie vide est toujours normalisée en null (cleanValue), il n'y a donc
  // pas de chaîne vide à couvrir en plus.
  if (f.remboursement.length) {
    const veutVide = f.remboursement.includes(FILTRE_VALEUR_VIDE);
    const valeurs = f.remboursement.filter((v) => v !== FILTRE_VALEUR_VIDE);
    if (veutVide && valeurs.length === 0) {
      query = query.is('remboursement', null);
    } else if (veutVide) {
      // « Vide » coché en même temps que des valeurs : union des deux.
      const liste = valeurs.map((v) => escapeForOrFilter(v)).join(',');
      query = query.or(`remboursement.is.null,remboursement.in.(${liste})`);
    } else {
      query = query.in('remboursement', valeurs);
    }
  }
  if (f.methodeRemboursement.length) query = query.in('methode_remboursement', f.methodeRemboursement);
  if (f.decisionClient.length) query = query.in('decision_client', f.decisionClient);
  if (f.statutClient.length) query = query.in('statut_client', f.statutClient);

  // Action camping : une seule valeur pour l'instant, mais le filtre propose
  // aussi « aucune », pour retrouver les séjours sur lesquels rien n'est signalé.
  if (f.actionCamping.length) {
    const valeurs = f.actionCamping.filter((v) => v !== FILTRE_VALEUR_VIDE);
    const veutVide = f.actionCamping.includes(FILTRE_VALEUR_VIDE);
    if (veutVide && valeurs.length) {
      query = query.or(`action_camping.is.null,action_camping.in.(${valeurs.map((v) => `"${v}"`).join(',')})`);
    } else if (veutVide) {
      query = query.is('action_camping', null);
    } else {
      query = query.in('action_camping', valeurs);
    }
  }
  if (f.situationDesc.length) query = query.in('situation_desc', f.situationDesc);
  // État de l'emplacement (OK / KO / ?), donnée d'origine camping. Le « vide »
  // n'a pas d'usage aujourd'hui — la colonne est renseignée partout — mais il
  // est géré comme ailleurs, au cas où un futur import laisserait des trous.
  if (f.statutEmplacement.length) {
    const valeurs = f.statutEmplacement.filter((v) => v !== FILTRE_VALEUR_VIDE);
    const veutVide = f.statutEmplacement.includes(FILTRE_VALEUR_VIDE);
    if (veutVide && valeurs.length) {
      query = query.or('statut_emplacement.is.null,statut_emplacement.in.(' + valeurs.map((v) => '"' + v + '"').join(',') + ')');
    } else if (veutVide) {
      query = query.is('statut_emplacement', null);
    } else {
      query = query.in('statut_emplacement', valeurs);
    }
  }
  if (f.categoriePms.length) query = query.in('categorie_pms', f.categoriePms);
  if (f.quartier.length) query = query.in('quartier', f.quartier);

  // Suivi du relogement et de la remise. Les deux proposent « vide » : c'est
  // ainsi que le camping retrouve les dossiers sur lesquels rien n'a encore été
  // engagé, et c'est le filtre le plus utile des deux.
  for (const [champ, valeurs] of [['relogement_statut', f.relogementStatut], ['remise_statut', f.remiseStatut]]) {
    if (!valeurs.length) continue;
    const reels = valeurs.filter((v) => v !== FILTRE_VALEUR_VIDE);
    const veutVide = valeurs.includes(FILTRE_VALEUR_VIDE);
    if (veutVide && reels.length) {
      query = query.or(champ + '.is.null,' + champ + '.in.(' + reels.map((v) => '"' + v + '"').join(',') + ')');
    } else if (veutVide) {
      query = query.is(champ, null);
    } else {
      query = query.in(champ, reels);
    }
  }

  if (f.modesPaiement.length) {
    // Chaque paiement est stocké sous la forme "LIBELLE : montant €", les
    // paiements étant séparés par des "|". On recherche donc le libellé SUIVI
    // du séparateur " : " : sans cela, cocher "CHEQUE" remonterait aussi les
    // "ANCV - CHEQUES VACANCES" (sous-chaîne).
    //
    // Deux logiques au choix quand plusieurs modes sont cochés :
    //   - "ou"  : le séjour possède AU MOINS UN des modes cochés ;
    //   - "et"  : le séjour possède TOUS les modes cochés (chaque mode devient
    //             une contrainte supplémentaire, cumulée par le .ilike).
    // Avec un seul mode coché, les deux logiques donnent le même résultat.
    if (f.modesPaiementOperateur === 'et') {
      f.modesPaiement.forEach((mode) => {
        query = query.ilike('modes_paiement', `%${mode} : %`);
      });
    } else {
      const clauses = f.modesPaiement
        .map((mode) => `modes_paiement.ilike.${escapeForOrFilter(`%${mode} : %`)}`)
        .join(',');
      query = query.or(clauses);
    }
  }
  if (f.campingRelogement.length) query = query.in('camping_relogement', f.campingRelogement);

  // Fidélité : la colonne vaut NULL quand aucune nuit de fidélité n'est utilisée.
  // Cocher les deux options revient à ne pas filtrer (on couvre tous les cas).
  const veutAvec = f.fidelite.includes('avec');
  const veutSans = f.fidelite.includes('sans');
  if (veutAvec && !veutSans) query = query.not('fidelity_use', 'is', null);
  if (veutSans && !veutAvec) query = query.is('fidelity_use', null);

  // Réponse au formulaire : même principe, cocher les deux revient à tout afficher.
  const repAvec = f.reponseForms.includes('avec');
  const repSans = f.reponseForms.includes('sans');
  if (repAvec && !repSans) query = query.not('id_choix_client', 'is', null);
  if (repSans && !repAvec) query = query.is('id_choix_client', null);

  // Formulaire d'origine de la réponse. L'information vit dans choix_client, pas
  // dans master_sejours : la liste des réponses concernées a été résolue en
  // amont (voir resoudreSourceForms) et sert ici de filtre sur le lien.
  if (Array.isArray(f.idsSourceForms)) {
    // Aucune réponse ne correspond : on renvoie une liste vide plutôt que de
    // laisser passer un filtre sans effet.
    query = f.idsSourceForms.length
      ? query.in('id_choix_client', f.idsSourceForms)
      : query.is('id', null);
  } else if (Array.isArray(f.idsSourceFormsExclus)) {
    // Voir resoudreSourceForms : filtre exprimé par le complément. Le séjour
    // doit porter une réponse, mais pas une de celles qui sont écartées.
    query = query.not('id_choix_client', 'is', null);
    if (f.idsSourceFormsExclus.length) {
      query = query.not('id_choix_client', 'in', `(${f.idsSourceFormsExclus.join(',')})`);
    }
  }

  // Présence à la date pivot (7 octobre 2026) : la colonne vaut 1 (présent) ou 0 (absent).
  // Cocher les deux cases revient à ne pas filtrer, comme pour la fidélité.

  // Mailings : uniquement les lignes renseignées (ni NULL ni chaîne vide).
  if (f.mailing1) query = query.not('mailing_1', 'is', null).neq('mailing_1', '');
  if (f.mailing2) query = query.not('mailing_2', 'is', null).neq('mailing_2', '');
  if (f.mailing3) query = query.not('mailing_3', 'is', null).neq('mailing_3', '');

  return query;
}

// ---------------------------------------------------------------------------
// GET /api/sejours/filter-options : valeurs réellement présentes en base pour
// alimenter les listes de choix des filtres (évite de proposer des valeurs
// inexistantes et s'adapte automatiquement aux données de chaque camping).
// ---------------------------------------------------------------------------
app.get('/api/sejours/filter-options', async (req, res) => {
  try {
    const CHUNK = 1000;
    const nbPersonnes = new Set();
    const statuts = new Set();
    const campings = new Set();
    const categories = new Set();
    const quartiers = new Set();
    const relogementStatuts = new Set();
    const remiseStatuts = new Set();
    const modesPaiement = new Set();
    const remboursements = new Set();
    const situations = new Set();
    const statutsEmplacement = new Set();
    const actionsCamping = new Set();
    const methodes = new Set();
    const decisions = new Set();
    let minTtc = null, maxTtc = null, minRegle = null, maxRegle = null;
    let minArrivee = null, maxArrivee = null, minDepart = null, maxDepart = null;

    // L'onglet Aquabulle demande les valeurs de son seul périmètre : proposer
    // au camping des catégories d'hébergement ou des vagues d'arrivée qui
    // n'existent pas dans le quartier ne ferait qu'allonger la liste de cases à
    // cocher sans jamais rien ramener.
    const limiterAuxAquabulle = req.query.perimetre === 'aquabulle';

    for (let from = 0; ; from += CHUNK) {
      let requete = supabase
        .from('master_sejours')
        .select('nombre_personnes, statut_client, categorie_pms, quartier, relogement_statut, remise_statut, camping_relogement, remboursement, methode_remboursement, decision_client, modes_paiement, montant_sejour_ttc, montant_regle, date_debut_sejour, date_depart_sejour, situation_desc, statut_emplacement, action_camping');
      if (limiterAuxAquabulle) requete = requete.eq('quartier', QUARTIER_AQUABULLE);
      const { data, error } = await requete.range(from, from + CHUNK - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const r of data) {
        if (r.nombre_personnes !== null) nbPersonnes.add(r.nombre_personnes);
        if (r.statut_client) statuts.add(r.statut_client);
        if (r.action_camping) actionsCamping.add(r.action_camping);
        if (r.categorie_pms) categories.add(r.categorie_pms);
        if (r.quartier) quartiers.add(r.quartier);
        if (r.relogement_statut) relogementStatuts.add(r.relogement_statut);
        if (r.remise_statut) remiseStatuts.add(r.remise_statut);
        // "MODE A : 10.00 € | MODE B : 5.00 €" -> libellés seuls, sans montant.
        if (r.modes_paiement) {
          String(r.modes_paiement)
            .split('|')
            .map((part) => part.split(':')[0].trim())
            .filter((part) => part !== '')
            .forEach((mode) => modesPaiement.add(mode));
        }
        if (r.camping_relogement) campings.add(r.camping_relogement);
        if (r.remboursement) remboursements.add(r.remboursement);
        if (r.situation_desc) situations.add(r.situation_desc);
        if (r.statut_emplacement) statutsEmplacement.add(r.statut_emplacement);
        if (r.methode_remboursement) methodes.add(r.methode_remboursement);
        if (r.decision_client) decisions.add(r.decision_client);

        const ttc = r.montant_sejour_ttc;
        if (ttc !== null) {
          minTtc = minTtc === null ? Number(ttc) : Math.min(minTtc, Number(ttc));
          maxTtc = maxTtc === null ? Number(ttc) : Math.max(maxTtc, Number(ttc));
        }
        const reg = r.montant_regle;
        if (reg !== null) {
          minRegle = minRegle === null ? Number(reg) : Math.min(minRegle, Number(reg));
          maxRegle = maxRegle === null ? Number(reg) : Math.max(maxRegle, Number(reg));
        }
        if (r.date_debut_sejour) {
          if (!minArrivee || r.date_debut_sejour < minArrivee) minArrivee = r.date_debut_sejour;
          if (!maxArrivee || r.date_debut_sejour > maxArrivee) maxArrivee = r.date_debut_sejour;
        }
        if (r.date_depart_sejour) {
          if (!minDepart || r.date_depart_sejour < minDepart) minDepart = r.date_depart_sejour;
          if (!maxDepart || r.date_depart_sejour > maxDepart) maxDepart = r.date_depart_sejour;
        }
      }
      if (data.length < CHUNK) break;
    }

    res.json({
      nombre_personnes: [...nbPersonnes].sort((a, b) => a - b),
      statut_client: [...statuts].sort(),
      categorie_pms: [...categories].sort(),
      quartier: [...quartiers].sort(),
      // Les valeurs métier sont proposées même si aucun dossier ne les porte
      // encore : au démarrage la colonne est vide partout, et un filtre sans
      // option serait inutilisable.
      relogement_statut: [...new Set([...RELOGEMENT_STATUTS, ...relogementStatuts])],
      remise_statut: [...new Set([...REMISE_STATUTS, ...remiseStatuts])],
      // Le front pré-remplit le taux avec cette valeur plutôt que de la coder en
      // dur de son côté : une seule source de vérité.
      remise_taux_defaut: REMISE_TAUX_DEFAUT,
      modes_paiement: [...modesPaiement].sort(),
      camping_relogement: [...campings].sort(),
      situation_desc: [...situations].sort(),
      statut_emplacement: [...statutsEmplacement].sort(),
      // Les actions du camping sont proposées d'emblée, la colonne se
      // remplissant au fil de la gestion de crise.
      action_camping: [...new Set([...ACTIONS_CAMPING, ...actionsCamping])],
      // Les 3 valeurs métier sont toujours proposées, même si aucune ligne ne
      // les porte encore (la colonne se remplit au fil de la gestion de crise).
      remboursement: [...new Set([...REMBOURSEMENT_VALUES, ...remboursements])],
      // Idem : les 4 méthodes sont proposées d'emblée, dans l'ordre qui compte
      // pour le camping — les dossiers à contrôler en premier.
      methode_remboursement: [...new Set([...METHODES_REMBOURSEMENT, ...methodes])],
      // Les 2 valeurs sont toujours proposées, même si aucune ligne ne les porte.
      decision_client: [...new Set([...DECISIONS_CLIENT, ...decisions])],
      // Les grandes familles d'abord, puis les libellés restés tels quels.
      bornes: {
        ttc: { min: minTtc, max: maxTtc },
        regle: { min: minRegle, max: maxRegle },
        arrivee: { min: minArrivee, max: maxArrivee },
        depart: { min: minDepart, max: maxDepart },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// Colonnes triables de la Liste séjours : toutes celles affichées dans le
// tableau. La clé est le nom envoyé par le navigateur, la valeur les colonnes
// réelles utilisées pour trier.
const SEJOURS_TRI_AUTORISE = {};
[
  'numero_client_groupe', 'nom', 'email', 'telephone_portable',
  'date_debut_sejour', 'date_depart_sejour', 'nombre_personnes',
  'numero_reservation', 'numero_emplacement', 'categorie_pms', 'quartier', 'modes_paiement',
  'relogement_statut', 'relogement_hebergement', 'remise_statut', 'remise_taux',
  'montant_sejour_ttc', 'montant_regle', 'assurance_annulation', 'fidelity_use',
  'remboursement', 'methode_remboursement', 'decision_client', 'action_camping', 'statut_client', 'situation_desc', 'statut_emplacement',
  'mailing_1', 'mailing_2', 'mailing_3',
  'date_entree_relogement', 'date_sortie_relogement', 'camping_relogement',
].forEach((colonne) => { SEJOURS_TRI_AUTORISE[colonne] = [colonne]; });
// « Réponse forms » n'est volontairement pas triable : la colonne affiche
// désormais le formulaire d'origine, qui vit dans choix_client, alors que le
// tri ne peut porter que sur l'identifiant du lien. Trier dessus classerait par
// ordre d'import sans rapport avec ce qui est affiché. Le filtre par formulaire
// répond au besoin.
// Le tri par nom départage sur le prénom, comme l'ordre par défaut.
SEJOURS_TRI_AUTORISE.nom = ['nom', 'prenom'];

const SEJOURS_TRI_DEFAUT = { colonnes: ['nom', 'prenom'], ascending: true };

// Le formulaire d'origine n'est pas une colonne de master_sejours : il se lit
// dans choix_client. Avant de construire la requête, on récupère donc les
// identifiants des réponses issues des formulaires demandés.
//
// Cocher toutes les cases revient à ne pas filtrer, et n'entraîne aucune lecture
// supplémentaire.
//
// La liste d'identifiants finit dans l'URL envoyée à PostgREST, et Supabase
// rejette les requêtes dont les entêtes dépassent 16 Ko. Au Les Petits Camarguais le
// un formulaire peut porter à lui seul plusieurs milliers de réponses, ce qui
// produisait une URL de 23 Ko et une erreur 500 au Brasilia.
//
// D'où l'inversion : filtrer sur un formulaire revient exactement à exclure les
// réponses des autres. On construit donc la liste la plus courte des
// deux, et on l'applique en inclusion ou en exclusion selon le cas.
const PLAFOND_IDS_SOURCE = 20000;
const IDS_MAX_DANS_URL = 1500;

// Supabase plafonne toute lecture à 1000 lignes, et ce plafond s'applique même
// quand on demande explicitement davantage : sans pagination, la liste des
// identifiants serait silencieusement tronquée et le filtre renverrait moins de
// séjours qu'il ne devrait. On parcourt donc par tranches.
async function listerReponses(sources) {
  if (sources.length === 0) return [];
  const clause = sources.map((s) => `${s.colonne}.not.is.null`).join(',');
  const TRANCHE = 1000;
  const ids = [];
  for (let de = 0; de < PLAFOND_IDS_SOURCE; de += TRANCHE) {
    const { data, error } = await supabase
      .from('choix_client')
      .select('id')
      .or(clause)
      .order('id')
      .range(de, de + TRANCHE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    ids.push(...data.map((r) => r.id));
    if (data.length < TRANCHE) break;
  }
  return ids;
}

async function resoudreSourceForms(filters) {
  const demandees = SOURCES_FORMULAIRE.filter((s) => filters.sourceForms.includes(s.cle));
  if (demandees.length === 0 || demandees.length === SOURCES_FORMULAIRE.length) return;

  const exclues = SOURCES_FORMULAIRE.filter((s) => !filters.sourceForms.includes(s.cle));
  const retenus = await listerReponses(demandees);

  // Chemin direct tant que la liste tient dans l'URL.
  if (retenus.length <= IDS_MAX_DANS_URL) {
    filters.idsSourceForms = retenus;
    return;
  }

  // Sinon on passe par le complément : « rattaché à une réponse, mais pas à
  // l'une de celles-là ». Résultat identique, URL beaucoup plus courte.
  const ecartes = await listerReponses(exclues);
  if (ecartes.length <= IDS_MAX_DANS_URL) {
    filters.idsSourceFormsExclus = ecartes;
    return;
  }

  // Les deux listes sont trop longues : mieux vaut le dire clairement que de
  // laisser Supabase renvoyer une erreur 500 incompréhensible.
  const e = new Error('Le filtre « Réponse forms » porte sur trop de réponses pour être appliqué. '
    + 'Restreignez la sélection avec un autre filtre, puis réessayez.');
  e.statusCode = 400;
  throw e;
}

function buildSejoursQuery(filters, { count = false } = {}) {
  let query = supabase
    .from('master_sejours')
    .select(SEJOURS_FULL_COLUMNS, count ? { count: 'exact' } : undefined);
  query = appliquerTri(query, filters.tri);
  return applySejoursFilters(query, filters);
}

app.get('/api/sejours', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const filters = parseSejoursFilters(req.query);
    await resoudreSourceForms(filters);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await buildSejoursQuery(filters, { count: true }).range(from, to);
    if (error) {
      if (estHorsTranche(error)) {
        const { count: total } = await buildSejoursQuery(filters, { count: true }).range(0, 0);
        return res.json({ rows: [], total: total || 0, page, pageSize });
      }
      throw error;
    }

    res.json({ rows: await ajouterSourceForms(data || []), total: count, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sejours/export : export Excel de la sélection courante.
// Applique exactement les mêmes filtres que la liste (via buildSejoursQuery),
// mais SANS pagination : le fichier contient toutes les lignes correspondantes.
// Sans aucun filtre, l'export est donc une copie complète de master_sejours.
// ---------------------------------------------------------------------------

// Colonnes exportées : reproduction à l'identique de l'onglet "Base séjour"
// du fichier maître (même ordre, mêmes intitulés). Les intitulés conservent
// volontairement les espaces de fin présents dans le fichier source
// ("Remboursement ", "Camping ") pour que l'export reste ré-injectable tel quel.
const SEJOURS_EXPORT_SHEET_NAME = 'Base séjour';

const SEJOURS_EXPORT_COLUMNS = [
  ['nom_entreprise', 'nom_entreprise'],
  ['numero_client_groupe', 'numero_client_groupe'],
  ['nom', 'nom'],
  ['prenom', 'prenom'],
  ['email', 'email'],
  ['telephone_fixe', 'telephone_fixe'],
  ['telephone_portable', 'telephone_portable'],
  ['type_to_ce', 'typeToCe'],
  ['nom_to', 'nom_to'],
  ['prenom_to', 'prenom_to'],
  ['email_to', 'email_to'],
  ['telephone_fixe_to', 'telephone_fixe_to'],
  ['telephone_portable_to', 'telephone_portable_to'],
  ['date_debut_sejour', 'date_debut_sejour'],
  ['date_depart_sejour', 'date_depart_sejour'],
  ['nombre_personnes', 'nombre_personnes'],
  ['categorie_pms', 'categorie_pms'],
  ['quartier', 'Quartier'],
  ['relogement_statut', 'Suivi relogement'],
  ['relogement_hebergement', 'Hébergement de relogement'],
  ['remise_statut', 'Suivi remise'],
  ['remise_taux', 'Taux de remise (%)'],
  ['numero_emplacement', 'numero_emplacement'],
  ['numero_reservation', 'numero_reservation'],
  ['montant_sejour_ttc', 'montant_sejour_ttc'],
  ['montant_regle', 'montant_regle'],
  ['assurance_annulation', 'assurance_annulation'],
  ['situation', 'situation'],
  ['situation_desc', 'situation_desc'],
  ['statut_emplacement', 'Statut emplacement'],
  ['fidelity_use', 'fidelity_use'],
  ['fidelity_map', 'fidelity_map'],
  ['modes_paiement', 'modes_paiement'],
  ['transactions_lyra', 'transactions_lyra'],
  ['canal_saisie', 'canal_saisie'],
  ['sales_channel_brut', 'sales_channel_brut'],
  ['canal_reservation_online', 'canal_reservation_online'],
  ['type_origine_code', 'type_origine_code'],
  ['statut_client', 'Statut Client'],
  ['mailing_1', 'Mailing 1'],
  ['date_envoi_m1', 'Date envoi M1'],
  ['mailing_2', 'Mailing 2'],
  ['date_envoi_m2', 'Date envoi M2'],
  ['mailing_3', 'Mailing 3'],
  ['date_envoi_m3', 'Date envoi M3'],
  ['los', 'LOS'],
  ['montant_ht_nuit', 'Montant HT / Nuit'],
  ['nuits_non_consommees', 'Nuits non consomm\u00e9es'],
  ['calcul_rbs_nuits_non_consommees', 'Calcul Rbs Nuits non consomm\u00e9es'],
  ['id_choix_client', 'R\u00e9ponse forms'],
  ['remboursement', 'Remboursement'],
  ['methode_remboursement', 'Méthode remboursement'],
  ['decision_client', 'Décision client'],
  // Les commentaires libres restent hors export, comme avant : ce sont des
  // mémos internes au camping. L'action, elle, est un statut comme les autres.
  ['action_camping', 'Action camping'],
  ['date_entree_relogement', "Date d'entr\u00e9e si relogement"],
  ['date_sortie_relogement', 'Date de sortie de relogement'],
  ['camping_relogement', 'Camping'],
  ['relogements_detail', 'Détail des relogements'],
  ['nom_prenom', 'NomPr\u00e9nom'],
];

// ---------------------------------------------------------------------------
// Colonnes bancaires : présentes UNIQUEMENT quand le filtre « Méthode de
// remboursement = Virement » est actif.
// ---------------------------------------------------------------------------
// Le camping prépare ses virements à la chaîne. Sans ces colonnes il doit
// ouvrir la fiche de chaque dossier pour relever l'IBAN, ce qui est intenable
// sur une centaine de dossiers.
//
// Elles ne sont pas ajoutées à tous les exports pour autant : un fichier
// contenant des IBAN en clair ne doit pas se promener sans raison. Filtrer sur
// « Virement » est une intention explicite de préparer des virements ; c'est ce
// qui déclenche leur présence, que le filtre soit seul ou combiné à d'autres.
//
// Les coordonnées vivent dans choix_client, pas dans master_sejours : elles
// sont donc lues séparément, par tranches (voir ajouterSourceForms pour la
// raison du découpage).
const SEJOURS_EXPORT_COLUMNS_BANCAIRES = [
  ['banque_method_remb', 'Mode de règlement déclaré'],
  ['banque_iban', 'IBAN'],
  ['banque_bic', 'BIC / SWIFT'],
  ['banque_nom', 'Banque'],
];

const exportAvecCoordonneesBancaires = (filters) =>
  Array.isArray(filters.methodeRemboursement)
  && filters.methodeRemboursement.includes(METHODE_VIREMENT);

async function ajouterCoordonneesBancaires(rows) {
  const ids = [...new Set(rows.map((r) => r.id_choix_client).filter((v) => v !== null && v !== undefined))];
  const parId = new Map();
  for (let i = 0; i < ids.length; i += TRANCHE_IDS_SOURCE) {
    const { data, error } = await supabase
      .from('choix_client')
      .select('id, method_remb, iban, bic, info_banque')
      .in('id', ids.slice(i, i + TRANCHE_IDS_SOURCE));
    if (error) throw error;
    (data || []).forEach((r) => parId.set(r.id, r));
  }
  rows.forEach((r) => {
    const rep = parId.get(r.id_choix_client);
    r.banque_method_remb = rep ? rep.method_remb : null;
    r.banque_iban = rep ? rep.iban : null;
    r.banque_bic = rep ? rep.bic : null;
    r.banque_nom = rep ? rep.info_banque : null;
  });
  return rows;
}

// Colonnes à forcer en texte dans le fichier Excel : sans cela, Excel
// réinterprète ces valeurs en nombres et supprime les zéros initiaux des
// numéros de téléphone (problème déjà rencontré sur les fichiers sources).
// L'IBAN et le BIC sont dans le même cas : Excel transforme volontiers un IBAN
// en notation scientifique, ce qui le rend inutilisable pour un virement.
const EXPORT_TEXT_COLUMNS = new Set([
  'telephone_fixe', 'telephone_portable', 'telephone_fixe_to', 'telephone_portable_to',
  'numero_emplacement', 'numero_reservation', 'fidelity_map',
  'banque_iban', 'banque_bic',
]);

// GET /api/aquabulle : la liste des 304 dossiers à traiter, et seulement eux.
// Réutilise exactement les filtres et le tri de la liste générale — un seul
// code de filtrage à maintenir — en ajoutant la contrainte de périmètre.
app.get('/api/aquabulle', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const filters = parseSejoursFilters(req.query);
    await resoudreSourceForms(filters);

    const from = (page - 1) * pageSize;
    const { data, error, count } = await buildSejoursQuery(filters, { count: true })
      .eq('quartier', QUARTIER_AQUABULLE)
      .range(from, from + pageSize - 1);
    if (error) throw error;

    res.json({ rows: await ajouterSourceForms(data || []), total: count, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// GET /api/aquabulle/avancement : les compteurs d'étape affichés en tête
// d'onglet. Calculés côté serveur pour que l'écran n'ait pas à ramener les 304
// lignes rien que pour les compter.
app.get('/api/aquabulle/avancement', async (req, res) => {
  try {
    const rows = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await supabase
        .from('master_sejours')
        .select('id_choix_client, decision_client, methode_remboursement, remboursement, relogement_statut, remise_statut')
        .eq('quartier', QUARTIER_AQUABULLE)
        .order('id')
        .range(de, de + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }

    const estRelogement = (r) => r.decision_client === DECISION_RELOGEMENT;
    const estAnnule = (r) => r.decision_client === DECISION_ANNULE;
    res.json({
      total: rows.length,
      sans_reponse: rows.filter((r) => !r.id_choix_client).length,
      ont_repondu: rows.filter((r) => r.id_choix_client).length,
      annules: rows.filter(estAnnule).length,
      relogements: rows.filter(estRelogement).length,
      // Un remboursement reste à faire tant que la colonne du camping est vide.
      remboursements_a_traiter: rows.filter((r) => estAnnule(r) && !r.remboursement).length,
      a_verifier: rows.filter((r) => estAnnule(r) && r.methode_remboursement === METHODE_A_VERIFIER).length,
      relogements_a_faire: rows.filter((r) => estRelogement(r) && r.relogement_statut !== 'Relogé'
                                                              && r.relogement_statut !== 'Refusé par le client').length,
      remises_a_appliquer: rows.filter((r) => estRelogement(r) && r.remise_statut !== 'Appliquée').length,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

app.get('/api/sejours/export', async (req, res) => {
  try {
    const filters = parseSejoursFilters(req.query);
    await resoudreSourceForms(filters);
    // L'onglet Aquabulle exporte sa sélection via cette même route : un seul
    // code d'export à maintenir, avec la contrainte de périmètre en plus.
    const limiterAuxAquabulle = req.query.perimetre === 'aquabulle';

    // Supabase plafonne le nombre de lignes par requête : on parcourt par
    // tranches jusqu'à avoir récupéré toute la sélection.
    const CHUNK = 1000;
    const rows = [];
    for (let from = 0; ; from += CHUNK) {
      let requete = buildSejoursQuery(filters);
      if (limiterAuxAquabulle) requete = requete.eq('quartier', QUARTIER_AQUABULLE);
      const { data, error } = await requete.range(from, from + CHUNK - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < CHUNK) break;
    }

    // Le formulaire d'origine est ajouté aux lignes comme pour l'écran : la
    // colonne « Réponse forms » de l'export doit dire la même chose que la
    // colonne du tableau, et non l'identifiant interne qui ne parle à personne.
    await ajouterSourceForms(rows);

    // Coordonnées bancaires : uniquement si le camping prépare des virements.
    const colonnes = exportAvecCoordonneesBancaires(filters)
      ? [...SEJOURS_EXPORT_COLUMNS, ...SEJOURS_EXPORT_COLUMNS_BANCAIRES]
      : SEJOURS_EXPORT_COLUMNS;
    if (colonnes !== SEJOURS_EXPORT_COLUMNS) await ajouterCoordonneesBancaires(rows);

    // Construction de la feuille : entêtes lisibles + lignes typées.
    const header = colonnes.map(([, label]) => label);
    const sheet = XLSX.utils.aoa_to_sheet([header]);

    const body = rows.map((row) =>
      colonnes.map(([key]) => {
        if (key === 'id_choix_client') return libelleSourceForms(row);
        const v = row[key];
        if (v === null || v === undefined) return '';
        return EXPORT_TEXT_COLUMNS.has(key) ? String(v) : v;
      })
    );
    XLSX.utils.sheet_add_aoa(sheet, body, { origin: 'A2' });

    // Forçage du format texte sur les colonnes sensibles (zéros initiaux).
    colonnes.forEach(([key], colIndex) => {
      if (!EXPORT_TEXT_COLUMNS.has(key)) return;
      for (let i = 0; i < body.length; i += 1) {
        const ref = XLSX.utils.encode_cell({ c: colIndex, r: i + 1 });
        const cell = sheet[ref];
        if (cell && cell.v !== '') {
          cell.t = 's';
          cell.z = '@';
        }
      }
    });

    sheet['!cols'] = colonnes.map(([key, label]) => ({
      wch: key === 'banque_iban' ? 34 : key === 'banque_method_remb' ? 40 : Math.max(12, label.length + 2),
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, SEJOURS_EXPORT_SHEET_NAME);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `sejours_${stamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Rows', String(rows.length));
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

// PUT /api/sejours/:id : édition d'une ligne depuis la pop-in. Le payload est
// construit uniquement à partir des listes de champs ci-dessus : tout champ
// non listé (id, id_choix_client, montants) est ignoré même s'il est envoyé.
app.put('/api/sejours/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });

    const body = req.body || {};

    const remboursement = cleanValue(body.remboursement);
    if (remboursement !== null && !REMBOURSEMENT_VALUES.has(remboursement)) {
      return res.status(400).json({
        error: `Valeur de remboursement invalide : "${remboursement}". Valeurs autorisées : Oui, Non, Partiel.`,
      });
    }

    // Même contrôle pour l'action du camping : une valeur libre rendrait la
    // ligne invisible au filtre correspondant.
    const actionCamping = cleanValue(body.action_camping);
    if (actionCamping !== null && !ACTIONS_CAMPING.includes(actionCamping)) {
      return res.status(400).json({
        error: `Action camping invalide : "${actionCamping}". Valeurs autorisées : ${ACTIONS_CAMPING.join(', ')}.`,
      });
    }

    // La méthode reste modifiable par le camping, mais uniquement parmi les
    // valeurs connues : sans ce contrôle, une faute de frappe rendrait la ligne
    // invisible au filtre correspondant.
    const decisionClient = cleanValue(body.decision_client);
    if (decisionClient !== null && !DECISIONS_CLIENT.includes(decisionClient)) {
      return res.status(400).json({
        error: `Décision client invalide : "${decisionClient}". Valeurs autorisées : ${DECISIONS_CLIENT.join(', ')}.`,
      });
    }

    const methodeRemboursement = cleanValue(body.methode_remboursement);
    if (methodeRemboursement !== null && !METHODES_REMBOURSEMENT.includes(methodeRemboursement)) {
      return res.status(400).json({
        error: `Méthode de remboursement invalide : "${methodeRemboursement}". Valeurs autorisées : ${METHODES_REMBOURSEMENT.join(', ')}.`,
      });
    }

    // Même garde-fou pour les deux étapes du suivi : une faute de frappe rendrait
    // le dossier invisible au filtre, donc introuvable pour le camping.
    for (const [champ, valeurs, libelle] of [
      ['relogement_statut', RELOGEMENT_STATUTS, 'Suivi du relogement'],
      ['remise_statut', REMISE_STATUTS, 'Suivi de la remise'],
    ]) {
      const v = cleanValue(body[champ]);
      if (v !== null && !valeurs.includes(v)) {
        return res.status(400).json({
          error: `${libelle} invalide : "${v}". Valeurs autorisées : ${valeurs.join(', ')}.`,
        });
      }
    }

    // Le taux de remise est un pourcentage : hors de 0 à 100, c'est une erreur
    // de saisie, pas une négociation.
    const taux = cleanNumeric(body.remise_taux);
    if (taux !== null && (taux < 0 || taux > 100)) {
      return res.status(400).json({
        error: `Taux de remise invalide : ${taux}. Il doit être compris entre 0 et 100.`,
      });
    }

    // Seules les colonnes réellement transmises sont écrites. La pop-in les
    // envoie toutes, donc rien ne change pour elle ; mais une requête partielle
    // — un appel forgé, un corps tronqué — mettait auparavant à null tout ce
    // qu'elle ne contenait pas, et vidait la fiche entière. Une colonne absente
    // doit vouloir dire « ne touche pas », jamais « efface ».
    const payload = {};
    const ecrire = (field, valeur) => { if (field in body) payload[field] = valeur; };
    for (const field of SEJOUR_TEXT_FIELDS) ecrire(field, cleanValue(body[field]));
    for (const field of SEJOUR_INTEGER_FIELDS) ecrire(field, cleanInt(body[field]));
    for (const field of SEJOUR_NUMERIC_FIELDS) ecrire(field, cleanNumeric(body[field]));
    for (const field of SEJOUR_DATE_FIELDS) ecrire(field, cleanDate(body[field]));

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable transmis : rien à enregistrer.' });
    }

    const { data, error } = await supabase
      .from('master_sejours')
      .update(payload)
      .eq('id', id)
      .select(SEJOURS_FULL_COLUMNS)
      .single();
    if (error) {
      // Aucune ligne mise à jour : l'identifiant n'existe pas (ou plus).
      if (error.code === ERREUR_AUCUNE_LIGNE) {
        return res.status(404).json({ error: 'Séjour introuvable : aucune modification enregistrée.' });
      }
      throw error;
    }

    res.json({ ok: true, row: data });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: messageErreurLisible(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
