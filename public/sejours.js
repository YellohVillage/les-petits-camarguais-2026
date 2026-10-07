(function () {
  const pageSize = 50;
  let currentPage = 1;
  let searchTerm = '';
  let searchTimeout = null;
  let rowsById = {};
  let currentEditId = null;

  const tableBody = document.getElementById('table-body');
  const totalCountEl = document.getElementById('total-count');
  const pageInfoEl = document.getElementById('page-info');
  const prevBtn = document.getElementById('prev-page');
  const nextBtn = document.getElementById('next-page');
  const searchInput = document.getElementById('search-input');
  const loadingEl = document.getElementById('loading-message');
  const emptyEl = document.getElementById('empty-message');
  const exportBtn = document.getElementById('export-btn');
  const exportMessage = document.getElementById('export-message');

  // -------------------------------------------------------------------------
  // Masquage des colonnes : préférence d'affichage propre à chaque utilisateur.
  // Elle est conservée dans le navigateur (localStorage) et n'a aucun effet sur
  // la fiche détaillée ni sur l'export Excel, qui gardent toutes les données.
  // -------------------------------------------------------------------------
  const COLUMNS_STORAGE_KEY = 'sejours.colonnes-masquees';
  const columnsPanel = document.getElementById('columns-panel');
  const columnsToggle = document.getElementById('columns-toggle');
  const columnsList = document.getElementById('columns-list');
  const columnsAll = document.getElementById('columns-all');
  const columnsClose = document.getElementById('columns-close');
  const columnsCount = document.getElementById('columns-count');

  // Colonnes masquables, dans l'ordre du tableau. Les colonnes "i" et "Action"
  // en sont volontairement absentes : elles donnent accès à la fiche.
  const TABLE_COLUMNS = [
    ['numero_client_groupe', 'N° client'],
    ['nom', 'Nom'],
    ['email', 'Email'],
    ['telephone_portable', 'Portable'],
    ['date_debut_sejour', 'Arrivée'],
    ['date_depart_sejour', 'Départ'],
    ['nombre_personnes', 'Pers.'],
    ['numero_reservation', 'N° résa'],
    ['numero_emplacement', 'Emplac.'],
    ['categorie_pms', 'Catégorie'],
    ['quartier', 'Quartier'],
    ['relogement_statut', 'Suivi relogement'],
    ['relogement_hebergement', 'Hébergement relog.'],
    ['remise_statut', 'Suivi remise'],
    ['remise_taux', 'Remise %'],
    ['modes_paiement', 'Modes de paiement'],
    ['montant_sejour_ttc', 'Montant TTC'],
    ['montant_regle', 'Réglé'],
    ['assurance_annulation', 'Assurance'],
    ['fidelity_use', 'Fidélité'],
    ['remboursement', 'Remboursement / BAV'],
    ['methode_remboursement', 'Méthode remb. / BAV'],
    ['decision_client', 'Décision client'],
    ['action_camping', 'Action camping'],
    ['statut_client', 'Statut client'],
    ['situation_desc', 'Situation client'],
    ['statut_emplacement', 'Statut emplacement'],
    ['mailing_1', 'Mailing 1'],
    ['mailing_2', 'Mailing 2'],
    ['mailing_3', 'Mailing 3'],
    ['id_choix_client', 'Réponse forms'],
    ['date_entree_relogement', 'Entrée reloge.'],
    ['date_sortie_relogement', 'Sortie reloge.'],
    ['camping_relogement', 'Camping reloge.'],
  ];

  function loadHiddenColumns() {
    try {
      const brut = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
      if (!brut) return new Set();
      const liste = JSON.parse(brut);
      // On ignore les clés inconnues : le tableau a pu évoluer depuis.
      const connues = new Set(TABLE_COLUMNS.map(([k]) => k));
      return new Set((Array.isArray(liste) ? liste : []).filter((k) => connues.has(k)));
    } catch (e) {
      return new Set();   // préférence illisible : on repart de zéro
    }
  }

  function saveHiddenColumns(set) {
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...set]));
    } catch (e) {
      /* stockage indisponible : la préférence ne survivra pas au rechargement */
    }
  }

  let hiddenColumns = loadHiddenColumns();

  // Applique le masquage aux entêtes et à toutes les cellules affichées.
  function applyHiddenColumns() {
    document.querySelectorAll('.data-table [data-col]').forEach((cell) => {
      cell.hidden = hiddenColumns.has(cell.dataset.col);
    });
    const n = hiddenColumns.size;
    columnsCount.textContent = String(n);
    columnsCount.hidden = n === 0;
    syncScrollbarWidth();   // la largeur du tableau a changé
  }

  function renderColumnsList() {
    columnsList.innerHTML = '';
    TABLE_COLUMNS.forEach(([key, label]) => {
      const item = document.createElement('label');
      item.className = 'filter-chip';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !hiddenColumns.has(key);   // coché = colonne visible
      item.classList.toggle('checked', input.checked);
      input.addEventListener('change', () => {
        if (input.checked) hiddenColumns.delete(key);
        else hiddenColumns.add(key);
        item.classList.toggle('checked', input.checked);
        saveHiddenColumns(hiddenColumns);
        applyHiddenColumns();
      });
      item.appendChild(input);
      item.appendChild(document.createTextNode(label));
      columnsList.appendChild(item);
    });
  }

  columnsToggle.addEventListener('click', () => {
    columnsPanel.hidden = !columnsPanel.hidden;
    if (!columnsPanel.hidden) filtersPanel.hidden = true;   // un seul panneau ouvert
  });
  columnsClose.addEventListener('click', () => { columnsPanel.hidden = true; });
  columnsAll.addEventListener('click', () => {
    hiddenColumns = new Set();
    saveHiddenColumns(hiddenColumns);
    renderColumnsList();
    applyHiddenColumns();
  });

  const filtersPanel = document.getElementById('filters-panel');
  const filtersToggle = document.getElementById('filters-toggle');
  const filtersApply = document.getElementById('filters-apply');
  const filtersReset = document.getElementById('filters-reset');
  const filtersCount = document.getElementById('filters-count');

  const fl = {
    arriveeDu: document.getElementById('fl-arrivee-du'),
    arriveeAu: document.getElementById('fl-arrivee-au'),
    departDu: document.getElementById('fl-depart-du'),
    departAu: document.getElementById('fl-depart-au'),
    ttcMin: document.getElementById('fl-ttc-min'),
    ttcMax: document.getElementById('fl-ttc-max'),
    regleMin: document.getElementById('fl-regle-min'),
    regleMax: document.getElementById('fl-regle-max'),
    nbPersonnes: document.getElementById('fl-nb-personnes'),
    remboursement: document.getElementById('fl-remboursement'),
    methodeRemboursement: document.getElementById('fl-methode-remboursement'),
    decisionClient: document.getElementById('fl-decision-client'),
    statutClient: document.getElementById('fl-statut-client'),
    categoriePms: document.getElementById('fl-categorie-pms'),
    quartier: document.getElementById('fl-quartier'),
    relogementStatut: document.getElementById('fl-relogement-statut'),
    remiseStatut: document.getElementById('fl-remise-statut'),
    fidelite: document.getElementById('fl-fidelite'),
    reponseForms: document.getElementById('fl-reponse-forms'),
    sourceForms: document.getElementById('fl-source-forms'),
    actionCamping: document.getElementById('fl-action-camping'),
    situationDesc: document.getElementById('fl-situation-desc'),
    statutEmplacement: document.getElementById('fl-statut-emplacement'),
    modesPaiement: document.getElementById('fl-modes-paiement'),
    camping: document.getElementById('fl-camping'),
    mailing1: document.getElementById('fl-mailing-1'),
    mailing2: document.getElementById('fl-mailing-2'),
    mailing3: document.getElementById('fl-mailing-3'),
  };

  const modalOverlay = document.getElementById('modal-overlay');
  const modalForm = document.getElementById('modal-form');
  const modalMessage = document.getElementById('modal-message');
  const modalCancel = document.getElementById('modal-cancel');
  const modalClose = document.getElementById('modal-close');
  const modalSaveTop = document.getElementById('modal-save-top');
  const modalFormsBtn = document.getElementById('modal-forms-btn');

  // Modale secondaire : réponse au formulaire (table choix_client).
  const formsOverlay = document.getElementById('forms-overlay');
  const formsForm = document.getElementById('forms-form');
  const formsMessage = document.getElementById('forms-message');
  const formsClose = document.getElementById('forms-close');
  const formsCancel = document.getElementById('forms-cancel');
  const formsSave = document.getElementById('forms-save');
  const formsSubtitle = document.getElementById('forms-subtitle');

  // Les trois formulaires ne posent pas les mêmes questions : la pop-in les
  // affiche toutes, celles qui ne concernent pas la réponse restent vides.
  const FORMS_EDITABLE = ['nom', 'prenom', 'email', 'num_resa', 'choix', 'situation', 'je_choisis', 'je_decide', 'nous_proposons', 'method_remb', 'iban', 'bic', 'info_banque', 'statut'];
  const FORMS_READONLY = ['id', 'source'];
  const formsFields = {};
  [...FORMS_EDITABLE, ...FORMS_READONLY].forEach((key) => {
    formsFields[key] = document.getElementById('fm-' + key);
  });
  let currentFormsId = null;
  const modalSave = document.getElementById('modal-save');

  // Champs envoyés au serveur lors de l'enregistrement (doivent correspondre
  // aux listes SEJOUR_*_FIELDS de server.js).
  const TEXT_FIELDS = [
    'nom_entreprise', 'nom', 'prenom', 'email', 'telephone_fixe', 'telephone_portable',
    'type_to_ce', 'nom_to', 'prenom_to', 'email_to', 'telephone_fixe_to', 'telephone_portable_to',
    'categorie_pms', 'quartier', 'relogement_statut', 'relogement_hebergement',
    'remise_statut', 'remise_taux', 'numero_emplacement', 'numero_reservation', 'fidelity_map',
    'modes_paiement', 'transactions_lyra', 'canal_saisie', 'canal_reservation_online',
    'remboursement', 'methode_remboursement', 'decision_client', 'commentaire_remboursement',
    'action_camping', 'commentaire_camping', 'statut_client', 'mailing_1', 'mailing_2', 'mailing_3', 'camping_relogement',
    'situation_desc', 'statut_emplacement', 'nom_prenom',
  ];
  const NUMBER_FIELDS = [
    'numero_client_groupe', 'nombre_personnes', 'fidelity_use', 'sales_channel_brut',
    'type_origine_code', 'assurance_annulation', 'los',
    'nuits_non_consommees', 'situation',
  ];
  const DATE_FIELDS = [
    'date_debut_sejour', 'date_depart_sejour',
    'date_envoi_m1', 'date_envoi_m2', 'date_envoi_m3',
    'date_entree_relogement', 'date_sortie_relogement',
  ];
  const ALL_FIELDS = [...TEXT_FIELDS, ...NUMBER_FIELDS, ...DATE_FIELDS];

  // Champs affichés à titre informatif uniquement : consultables dans la pop-in
  // mais jamais envoyés dans le payload.
  //   - identifiants internes ;
  //   - montants PMS (TTC, réglé) ;
  //   - montants calculés par le siège dans le fichier maître : le montant HT
  //     par nuit et le remboursement des nuits non consommées se déduisent du
  //     TTC et des nuits, les retoucher à la main désaligne l'outil du fichier.
  const READONLY_FIELDS = [
    'id', 'id_choix_client', 'montant_sejour_ttc', 'montant_regle',
    'montant_ht_nuit', 'calcul_rbs_nuits_non_consommees',
    'relogements_detail',
  ];
  const DISPLAY_FIELDS = [...ALL_FIELDS, ...READONLY_FIELDS];

  const fields = {};
  DISPLAY_FIELDS.forEach((key) => {
    fields[key] = document.getElementById('f-' + key);
  });

  // ---------------------------------------------------------------------------
  // Montants issus d'un calcul du siège (montant TTC divisé par le nombre de
  // nuits, puis multiplié par les nuits non consommées). La division tombe
  // rarement juste : la base contient des valeurs à quinze décimales, illisibles
  // dans un champ de saisie.
  //
  // La fiche affiche donc l'arrondi au centime, tout en gardant la valeur exacte
  // de côté. À l'enregistrement, c'est elle qui repart si l'utilisateur n'a pas
  // touché au champ : afficher un arrondi ne doit jamais dégrader la donnée.
  // Dès qu'il saisit quelque chose, sa valeur fait foi.
  // ---------------------------------------------------------------------------
  const CHAMPS_MONTANT_CALCULE = ['assurance_annulation', 'montant_ht_nuit', 'calcul_rbs_nuits_non_consommees'];

  function arrondiAffichage(valeur) {
    if (valeur === null || valeur === undefined || valeur === '') return '';
    const n = Number(valeur);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(valeur);
  }

  function poserMontantCalcule(key, valeur) {
    const champ = fields[key];
    if (!champ) return;
    const exacte = valeur === null || valeur === undefined ? '' : String(valeur);
    const affichee = arrondiAffichage(exacte);
    champ.value = affichee;
    if (exacte !== '' && exacte !== affichee) {
      champ.dataset.valeurExacte = exacte;
      champ.title = 'Valeur exacte enregistrée : ' + exacte
        + '\nL\'affichage est arrondi au centime ; la valeur exacte est conservée tant que vous ne modifiez pas ce champ.';
    } else {
      delete champ.dataset.valeurExacte;
      champ.removeAttribute('title');
    }
  }

  // Toute frappe de l'utilisateur invalide la valeur exacte mémorisée.
  CHAMPS_MONTANT_CALCULE.forEach((key) => {
    if (!fields[key]) return;
    fields[key].addEventListener('input', () => {
      delete fields[key].dataset.valeurExacte;
      fields[key].removeAttribute('title');
    });
  });

  // Valeur à envoyer au serveur : l'exacte si le champ n'a pas bougé.
  function valeurMontantCalcule(key) {
    const champ = fields[key];
    const exacte = champ.dataset.valeurExacte;
    if (exacte && champ.value === arrondiAffichage(exacte)) return exacte;
    return champ.value;
  }

  // Glisser-déposer horizontal sur le tableau : beaucoup de colonnes ne
  // tiennent pas à l'écran. Même logique que les dashboards.
  function enableDragScroll(container) {
    if (!container) return;
    let isDown = false;
    let hasDragged = false;
    let startX = 0;
    let startScrollLeft = 0;

    const DRAG_THRESHOLD = 5;

    function onDown(clientX) {
      isDown = true;
      hasDragged = false;
      startX = clientX;
      startScrollLeft = container.scrollLeft;
    }

    function onMove(clientX, event) {
      if (!isDown) return;
      const delta = clientX - startX;
      if (Math.abs(delta) > DRAG_THRESHOLD) {
        hasDragged = true;
        container.classList.add('dragging');
        if (event && event.cancelable) event.preventDefault();
      }
      container.scrollLeft = startScrollLeft - delta;
    }

    function onUp() {
      isDown = false;
      container.classList.remove('dragging');
    }

    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      onDown(e.pageX);
    });
    window.addEventListener('mousemove', (e) => onMove(e.pageX, e));
    window.addEventListener('mouseup', onUp);

    container.addEventListener(
      'click',
      (e) => {
        if (hasDragged) {
          e.preventDefault();
          e.stopPropagation();
          hasDragged = false;
        }
      },
      true
    );

    container.addEventListener('touchstart', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      onDown(e.touches[0].pageX);
    }, { passive: true });
    container.addEventListener('touchmove', (e) => onMove(e.touches[0].pageX, e), { passive: true });
    container.addEventListener('touchend', onUp);
  }

  document.querySelectorAll('.table-wrap').forEach(enableDragScroll);

  // Barre de défilement horizontale dupliquée au-dessus du tableau : elle
  // offre un second moyen de navigation (en plus du glisser-déposer, qui reste
  // actif) et indique visuellement où l'on se situe dans les colonnes.
  // Les deux conteneurs se synchronisent mutuellement, avec un verrou pour
  // éviter la boucle infinie d'événements scroll.
  const tableWrap = document.querySelector('.table-wrap');
  const scrollTop = document.getElementById('scroll-top');
  const scrollTopInner = document.getElementById('scroll-top-inner');

  function syncScrollbarWidth() {
    if (!tableWrap || !scrollTop || !scrollTopInner) return;
    const table = tableWrap.querySelector('table');
    const width = table ? table.scrollWidth : 0;
    scrollTopInner.style.width = width + 'px';
    // Masquée tant qu'il n'y a rien à faire défiler.
    scrollTop.hidden = width <= tableWrap.clientWidth;
  }

  if (tableWrap && scrollTop) {
    let syncing = false;
    scrollTop.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      tableWrap.scrollLeft = scrollTop.scrollLeft;
      syncing = false;
    });
    tableWrap.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      scrollTop.scrollLeft = tableWrap.scrollLeft;
      syncing = false;
    });
    window.addEventListener('resize', syncScrollbarWidth);
  }

  // -------------------------------------------------------------------------
  // Tri au clic sur l'entête de colonne.
  //
  // Le tri est demandé au serveur : la liste étant paginée, trier uniquement
  // les lignes visibles donnerait un classement faux. Trois états se succèdent
  // au clic : croissant, décroissant, puis retour au classement par défaut.
  //
  // Le sens est indiqué par une flèche, et les colonnes de chiffres, de
  // montants et de dates sont annoncées comme telles pour que l'utilisateur
  // sache à quoi s'attendre.
  // -------------------------------------------------------------------------
  const COLONNES_NUMERIQUES = new Set([
    'remise_taux',
    'numero_client_groupe', 'nombre_personnes', 'montant_sejour_ttc', 'montant_regle',
    'assurance_annulation', 'fidelity_use', 'id_choix_client',
    'date_debut_sejour', 'date_depart_sejour', 'date_entree_relogement', 'date_sortie_relogement',
  ]);

  let tri = { colonne: null, sens: 'asc' };

  function libelleTri(colonne, sens) {
    if (COLONNES_NUMERIQUES.has(colonne)) {
      return sens === 'asc' ? 'du plus petit au plus grand' : 'du plus grand au plus petit';
    }
    return sens === 'asc' ? 'de A à Z' : 'de Z à A';
  }

  // « Réponse forms » affiche le formulaire d'origine, qui vit dans une autre
  // table : le serveur ne peut trier que sur l'identifiant du lien, sans rapport
  // avec ce que l'utilisateur lit. Plutôt qu'un tri trompeur, la colonne est
  // filtrable par formulaire.
  const COLONNES_NON_TRIABLES = new Set(['id_choix_client']);

  // Taux de remise proposé par défaut, fourni par le serveur pour n'avoir qu'une
  // seule source de vérité. La valeur ci-dessous ne sert qu'au cas où l'appel
  // aux options de filtre n'aurait pas encore répondu.
  let tauxRemiseDefaut = 20;

  function appliquerIndicateursTri() {
    document.querySelectorAll('.data-table thead th[data-col]').forEach((th) => {
      const colonne = th.dataset.col;
      // Une colonne non triable ne reçoit ni flèche ni consigne de tri.
      if (COLONNES_NON_TRIABLES.has(colonne)) return;
      const actif = tri.colonne === colonne;
      th.classList.toggle('tri-actif', actif);
      th.setAttribute('aria-sort', actif ? (tri.sens === 'asc' ? 'ascending' : 'descending') : 'none');
      let fleche = th.querySelector('.tri-fleche');
      if (!fleche) {
        fleche = document.createElement('span');
        fleche.className = 'tri-fleche';
        th.appendChild(fleche);
      }
      fleche.textContent = actif ? (tri.sens === 'asc' ? '▲' : '▼') : '⇅';
      th.title = actif
        ? 'Trié ' + libelleTri(colonne, tri.sens) + ' — cliquer pour ' +
          (tri.sens === 'asc' ? 'inverser' : 'revenir au classement par défaut')
        : 'Cliquer pour trier ' + libelleTri(colonne, 'asc');
    });
  }

  function activerTriEntetes() {
    document.querySelectorAll('.data-table thead th[data-col]').forEach((th) => {
      if (COLONNES_NON_TRIABLES.has(th.dataset.col)) {
        th.title = 'Colonne non triable : utiliser le filtre « Formulaire rempli »';
        return;
      }
      th.classList.add('triable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      const basculer = () => {
        const colonne = th.dataset.col;
        if (tri.colonne !== colonne) tri = { colonne, sens: 'asc' };
        else if (tri.sens === 'asc') tri = { colonne, sens: 'desc' };
        else tri = { colonne: null, sens: 'asc' };   // 3e clic : classement par défaut
        currentPage = 1;   // un nouveau tri renvoie en tête de liste
        appliquerIndicateursTri();
        loadPage();
      };
      th.addEventListener('click', basculer);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); basculer(); }
      });
    });
    appliquerIndicateursTri();
  }

  // Montants : affichage lisible pour des utilisateurs non techniques
  // (séparateur de milliers + 2 décimales + symbole euro). Une valeur nulle
  // reste vide, un 0 est affiché tel quel (0,00 €).
  function formatMontant(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    if (Number.isNaN(n)) return escapeHtml(v);
    return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  // Modes de paiement : la valeur brute cumule libellés ET montants, séparés
  // par des "|" (ex. "VENTE A DISTANCE : 448.00 € | ESPECES : 50.00 €").
  // Dans le tableau on n'affiche que les libellés distincts pour rester
  // lisible ; la valeur complète reste disponible au survol et dans la pop-in.
  // Colonne "Réponse forms" : quand un séjour est rattaché à une réponse, la
  // cellule devient un lien qui ouvre la modale de la réponse. Sinon, cellule vide.
  //
  // Le lien affiche le formulaire auquel le client a répondu, et non plus
  // l'identifiant interne de la réponse : celui-ci ne disait rien au camping.
  // Le nom du fichier est rappelé entre parenthèses, c'est celui à redéposer
  // dans l'onglet Import.
  const LIBELLES_SOURCE_FORMS = {
    relogement: 'Relogement (relogement.xlsx)',
  };

  function formatReponseForms(row) {
    const id = row.id_choix_client;
    if (id === null || id === undefined || id === '') return '';
    // Une réponse dont le formulaire d'origine serait indéterminable reste
    // cliquable : on retombe alors sur l'identifiant, plutôt que sur une
    // cellule muette.
    const libelle = LIBELLES_SOURCE_FORMS[row.source_forms] || String(id);
    return '<button type="button" class="link-forms" data-forms-id="' + escapeHtml(id)
      + '" title="Voir la réponse au formulaire (réponse n° ' + escapeHtml(id) + ')">'
      + escapeHtml(libelle) + '</button>';
  }

  // Action camping : drapeau posé par le camping sur un client à rappeler. Mis
  // en évidence, et le motif saisi remonte en infobulle pour éviter d'ouvrir la
  // fiche juste pour le lire.
  function formatActionCamping(row) {
    const v = row.action_camping;
    if (v === null || v === undefined || v === '') return '';
    const motif = row.commentaire_camping ? '\n' + row.commentaire_camping : '';
    return '<span class="action-camping" title="' + escapeHtml('Signalé par le camping.' + motif) + '">'
      + escapeHtml(v) + '</span>';
  }

  // Présence à la date pivot (7 octobre 2026) : stockée 1/0 en base, lue Oui/Non par les équipes.
  // Une valeur absente reste une cellule vide (information non renseignée).
  function formatOuiNon(v) {
    if (v === null || v === undefined || v === '') return '';
    return Number(v) === 1 ? 'Oui' : 'Non';
  }

  // Méthode de remboursement : « À vérifier » signale un dossier dont la réponse
  // du client contredit les paiements enregistrés au PMS. Il est mis en évidence
  // pour que le camping ne le traite pas machinalement comme les autres.
  function formatMethodeRemboursement(v) {
    if (v === null || v === undefined || v === '') return '';
    const valeur = String(v);
    const classe = valeur === 'À vérifier' ? 'methode methode-alerte' : 'methode';
    const titre = valeur === 'À vérifier'
      ? ' title="La réponse du client ne correspond pas aux paiements enregistrés au PMS : à contrôler avant de rembourser."'
      : '';
    return '<span class="' + classe + '"' + titre + '>' + escapeHtml(valeur) + '</span>';
  }

  function formatModesPaiement(v) {
    if (v === null || v === undefined || v === '') return '';
    return String(v)
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => '<span class="mode-line">' + escapeHtml(part) + '</span>')
      .join('');
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Numéro de la dernière demande envoyée. Deux clics rapprochés (inverser un
  // tri, enchaîner deux filtres) lancent deux appels : sans ce garde-fou, la
  // réponse la plus lente peut arriver en dernier et afficher un contenu qui ne
  // correspond plus à ce que l'utilisateur a demandé. Toute réponse dont le
  // numéro n'est plus le plus récent est donc ignorée.
  let derniereRequete = 0;

  async function loadPage() {
    const numeroRequete = ++derniereRequete;
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    tableBody.innerHTML = '';
    rowsById = {};

    const url = new URL('/api/sejours', window.location.origin);
    currentFilterParams().forEach((value, key) => url.searchParams.set(key, value));
    url.searchParams.set('page', String(currentPage));
    url.searchParams.set('pageSize', String(pageSize));

    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (numeroRequete !== derniereRequete) return;   // une demande plus récente a pris le relais
      loadingEl.hidden = true;

      if (!resp.ok) {
        emptyEl.textContent = data.error || 'Erreur de chargement.';
        emptyEl.hidden = false;
        totalCountEl.textContent = '–';
        syncScrollbarWidth();
        return;
      }

      totalCountEl.textContent = data.total;
      const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
      pageInfoEl.textContent = `Page ${data.page} / ${totalPages}`;
      prevBtn.disabled = data.page <= 1;
      nextBtn.disabled = data.page >= totalPages;

      if (data.rows.length === 0) {
        emptyEl.textContent = 'Aucun résultat.';
        emptyEl.hidden = false;
        syncScrollbarWidth();
        return;
      }

      for (const row of data.rows) {
        rowsById[row.id] = row;
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><button class="btn-info" data-id="' + row.id + '" title="Voir la fiche du séjour" aria-label="Voir la fiche du séjour">i</button></td>' +
          '<td data-col="numero_client_groupe">' + escapeHtml(row.numero_client_groupe) + '</td>' +
          '<td data-col="nom">' + escapeHtml(row.nom) + '</td>' +
          '<td data-col="email">' + escapeHtml(row.email) + '</td>' +
          '<td data-col="telephone_portable">' + escapeHtml(row.telephone_portable) + '</td>' +
          '<td data-col="date_debut_sejour">' + escapeHtml(row.date_debut_sejour) + '</td>' +
          '<td data-col="date_depart_sejour">' + escapeHtml(row.date_depart_sejour) + '</td>' +
          '<td data-col="nombre_personnes">' + escapeHtml(row.nombre_personnes) + '</td>' +
          '<td data-col="numero_reservation">' + escapeHtml(row.numero_reservation) + '</td>' +
          '<td data-col="numero_emplacement">' + escapeHtml(row.numero_emplacement) + '</td>' +
          '<td data-col="categorie_pms">' + escapeHtml(row.categorie_pms) + '</td>' +
          '<td data-col="quartier">' + escapeHtml(row.quartier) + '</td>' +
          '<td data-col="relogement_statut">' + escapeHtml(row.relogement_statut) + '</td>' +
          '<td data-col="relogement_hebergement">' + escapeHtml(row.relogement_hebergement) + '</td>' +
          '<td data-col="remise_statut">' + escapeHtml(row.remise_statut) + '</td>' +
          '<td data-col="remise_taux">' + (row.remise_taux === null || row.remise_taux === undefined ? '' : escapeHtml(row.remise_taux) + ' %') + '</td>' +
          '<td class="cell-modes" data-col="modes_paiement">' + formatModesPaiement(row.modes_paiement) + '</td>' +
          '<td data-col="montant_sejour_ttc">' + formatMontant(row.montant_sejour_ttc) + '</td>' +
          '<td data-col="montant_regle">' + formatMontant(row.montant_regle) + '</td>' +
          '<td data-col="assurance_annulation">' + formatMontant(row.assurance_annulation) + '</td>' +
          '<td data-col="fidelity_use">' + escapeHtml(row.fidelity_use) + '</td>' +
          '<td data-col="remboursement">' + escapeHtml(row.remboursement) + '</td>' +
          '<td data-col="methode_remboursement">' + formatMethodeRemboursement(row.methode_remboursement) + '</td>' +
          '<td data-col="decision_client">' + escapeHtml(row.decision_client) + '</td>' +
          '<td data-col="action_camping">' + formatActionCamping(row) + '</td>' +
          '<td data-col="statut_client">' + escapeHtml(row.statut_client) + '</td>' +
          '<td data-col="situation_desc">' + escapeHtml(row.situation_desc) + '</td>' +
          '<td data-col="statut_emplacement">' + escapeHtml(row.statut_emplacement) + '</td>' +
          '<td data-col="mailing_1">' + escapeHtml(row.mailing_1) + '</td>' +
          '<td data-col="mailing_2">' + escapeHtml(row.mailing_2) + '</td>' +
          '<td data-col="mailing_3">' + escapeHtml(row.mailing_3) + '</td>' +
          '<td data-col="id_choix_client">' + formatReponseForms(row) + '</td>' +
          '<td data-col="date_entree_relogement">' + escapeHtml(row.date_entree_relogement) + '</td>' +
          '<td data-col="date_sortie_relogement">' + escapeHtml(row.date_sortie_relogement) + '</td>' +
          '<td data-col="camping_relogement">' + escapeHtml(row.camping_relogement) + '</td>' +
          '<td><button class="btn-toggle" data-id="' + row.id + '">Modifier</button></td>';
        tableBody.appendChild(tr);
      }

      tableBody.querySelectorAll('.btn-toggle, .btn-info').forEach((btn) => {
        btn.addEventListener('click', () => openModal(btn.dataset.id));
      });

      tableBody.querySelectorAll('.link-forms').forEach((link) => {
        link.addEventListener('click', () => openFormsModal(link.dataset.formsId));
      });

      // Le contenu vient de changer : on réapplique le masquage puis on
      // recalcule la largeur de la barre de défilement.
      applyHiddenColumns();
    } catch (err) {
      if (numeroRequete !== derniereRequete) return;
      loadingEl.hidden = true;
      emptyEl.textContent = 'Erreur réseau : ' + err.message;
      emptyEl.hidden = false;
    }
  }

  // Le commentaire de remboursement n'a de sens que pour un remboursement
  // partiel, et le motif de rappel que si le camping a signalé le client :
  // chacun n'apparaît que lorsqu'il sert, pour ne pas alourdir la fiche.
  const commentaireBlock = document.getElementById('field-commentaire_remboursement');
  const commentaireCampingBlock = document.getElementById('field-commentaire_camping');

  // Zone tour-opérateur / CSE : elle ne concerne qu'une poignée de séjours.
  // On ne l'affiche que si au moins un des 6 champs est renseigné, pour ne pas
  // rallonger inutilement la fiche dans l'immense majorité des cas.
  const sectionToCe = document.getElementById('section-to-ce');
  const TO_CE_FIELDS = ['type_to_ce', 'nom_to', 'prenom_to', 'email_to', 'telephone_fixe_to', 'telephone_portable_to'];

  function refreshToCeVisibility() {
    const rempli = TO_CE_FIELDS.some((key) => {
      const v = fields[key].value;
      return v !== null && v !== undefined && String(v).trim() !== '';
    });
    sectionToCe.hidden = !rempli;
  }

  function refreshCommentaireVisibility() {
    const partiel = fields.remboursement.value === 'Partiel';
    // On garde le champ visible s'il contient déjà du texte, afin de ne jamais
    // masquer une information saisie précédemment.
    commentaireBlock.hidden = !partiel && !fields.commentaire_remboursement.value;
  }

  // Même principe pour le motif du rappel : il n'apparaît que si le camping a
  // posé une action, ou s'il porte déjà un texte à ne pas escamoter.
  function refreshCommentaireCampingVisibility() {
    const aUneAction = fields.action_camping.value !== '';
    commentaireCampingBlock.hidden = !aUneAction && !fields.commentaire_camping.value;
  }

  // Aide affichée sous la méthode de remboursement : elle rappelle le geste
  // attendu, et surtout signale les dossiers à contrôler avant traitement.
  const methodeAide = document.getElementById('methode-aide');
  const AIDES_METHODE = {
    'Carte': 'Remboursement automatique sur le moyen de paiement utilisé.',
    'Virement': 'Virement bancaire à effectuer. L\'IBAN se trouve dans la réponse au formulaire.',
    'BAV': 'Bon à valoir à générer et à envoyer au client, puis passer Remboursement à « Oui ».',
    'À vérifier': 'La réponse du client ne correspond pas aux paiements enregistrés au PMS. Contrôler le dossier dans le PMS, puis choisir la méthode ici.',
  };

  function refreshMethodeAide() {
    const valeur = fields.methode_remboursement.value;
    methodeAide.textContent = AIDES_METHODE[valeur] || '';
    methodeAide.hidden = !AIDES_METHODE[valeur];
    methodeAide.classList.toggle('modal-aide-alerte', valeur === 'À vérifier');
  }

  // Décision du client. La valeur peut légitimement être vide : les évacués
  // dont le séjour se terminait avant la réouverture n'ont eu ni à annuler ni à
  // décaler, la question ne leur a pas été posée. On l'explique plutôt que de
  // laisser une case vide inexpliquée.
  const decisionAide = document.getElementById('decision-aide');

  function refreshDecisionAide() {
    const aReponse = fields.id_choix_client.value !== '';
    const valeur = fields.decision_client.value;
    let texte = '';
    if (valeur === 'Annulé') texte = 'Le client a annulé son séjour.';
    else if (valeur === 'Décalé') texte = 'Le client revient après la réouverture du camping.';
    else if (aReponse) {
      texte = 'Le formulaire n\'a pas posé la question : le séjour se terminait avant la réouverture, '
        + 'il n\'y avait ni à annuler ni à décaler.';
    }
    decisionAide.textContent = texte;
    decisionAide.hidden = texte === '';
  }

  // -------------------------------------------------------------------------
  // Coordonnées bancaires, affichées pour un remboursement par virement.
  //
  // Elles appartiennent à la réponse du client (table choix_client) et non au
  // séjour : on va donc les chercher au moment où elles servent, plutôt que de
  // les charger pour les 3022 lignes de la liste. Elles restent en lecture
  // seule ici — leur correction passe par la modale « Réponse forms », qui
  // relance le rapprochement.
  // -------------------------------------------------------------------------
  const blocBanque = document.getElementById('bloc-coordonnees-bancaires');
  const banqueMessage = document.getElementById('banque-message');
  const banqueChamps = document.getElementById('banque-champs');
  const banqueIban = document.getElementById('f-banque-iban');
  const banqueBic = document.getElementById('f-banque-bic');
  const banqueEtablissement = document.getElementById('f-banque-etablissement');

  // Évite de redemander la même réponse à chaque bascule de la liste déroulante.
  let banqueChargeePour = null;

  function afficherMessageBanque(texte, alerte) {
    banqueMessage.textContent = texte;
    banqueMessage.hidden = !texte;
    banqueMessage.classList.toggle('modal-aide-alerte', !!alerte);
    banqueChamps.hidden = !!texte;
  }

  function viderChampsBanque() {
    banqueIban.value = '';
    banqueBic.value = '';
    banqueEtablissement.value = '';
  }

  async function refreshCoordonneesBancaires() {
    const virement = fields.methode_remboursement.value === 'Virement';
    blocBanque.hidden = !virement;
    if (!virement) return;

    const idReponse = fields.id_choix_client.value;
    if (!idReponse) {
      viderChampsBanque();
      afficherMessageBanque(
        "Aucune réponse au formulaire n'est rattachée à ce séjour : les coordonnées bancaires ne sont pas disponibles.",
        true
      );
      return;
    }

    if (banqueChargeePour === idReponse) return;   // déjà à l'écran

    viderChampsBanque();
    afficherMessageBanque('Chargement des coordonnées bancaires...', false);

    try {
      const resp = await fetch('/api/clients/' + idReponse);
      const data = await resp.json();
      // La fiche a pu être refermée ou changer de séjour pendant la requête.
      if (fields.id_choix_client.value !== idReponse) return;
      if (!resp.ok || !data.row) {
        afficherMessageBanque('Coordonnées bancaires indisponibles : ' + (data.error || 'réponse introuvable.'), true);
        return;
      }

      const r = data.row;
      banqueIban.value = r.iban || '';
      banqueBic.value = r.bic || '';
      banqueEtablissement.value = r.info_banque || '';
      banqueChargeePour = idReponse;

      if (!r.iban) {
        afficherMessageBanque(
          "Le client n'a pas communiqué ses coordonnées bancaires : il faut le recontacter avant de pouvoir virer.",
          true
        );
      } else {
        afficherMessageBanque('', false);
      }
    } catch (err) {
      if (fields.id_choix_client.value !== idReponse) return;
      afficherMessageBanque('Coordonnées bancaires indisponibles : ' + err.message, true);
    }
  }

  function openModal(id) {
    const row = rowsById[id];
    if (!row) return;

    currentEditId = row.id;
    DISPLAY_FIELDS.forEach((key) => {
      fields[key].value = row[key] === null || row[key] === undefined ? '' : row[key];
    });
    CHAMPS_MONTANT_CALCULE.forEach((key) => poserMontantCalcule(key, row[key]));
    refreshCommentaireVisibility();
    refreshCommentaireCampingVisibility();
    // Le détail n'a de sens que si le séjour a connu un relogement.
    const blocDetail = document.getElementById('field-relogements_detail');
    if (blocDetail) blocDetail.hidden = !fields.relogements_detail.value;
    banqueChargeePour = null;   // nouvelle fiche : les coordonnées seront rechargées
    refreshMethodeAide();
    refreshDecisionAide();
    refreshCoordonneesBancaires();
    refreshToCeVisibility();
    refreshSuiviRelogement();

    // Le raccourci vers la réponse au formulaire n'a de sens que si ce séjour
    // est effectivement rattaché à une réponse.
    const lien = row.id_choix_client;
    modalFormsBtn.hidden = lien === null || lien === undefined || lien === '';
    modalFormsBtn.dataset.formsId = lien || '';

    modalMessage.hidden = true;
    modalSave.disabled = false;
    modalSave.textContent = 'Enregistrer';
    modalOverlay.hidden = false;
  }

  // Le suivi du relogement et de la remise ne concerne que les clients qui ont
  // choisi de rester. Pour une annulation, ces champs n'ont aucun sens et sont
  // masqués : un écran qui propose de reloger quelqu'un qui a annulé invite à
  // l'erreur de saisie.
  const BLOCS_SUIVI_RELOGEMENT = ['field-suivi-relogement', 'field-relogement-statut',
    'field-relogement-hebergement', 'field-remise-statut', 'field-remise-taux'];

  function refreshSuiviRelogement() {
    const concerne = fields.decision_client.value === 'Relogement + remise';
    BLOCS_SUIVI_RELOGEMENT.forEach((id) => {
      const bloc = document.getElementById(id);
      if (bloc) bloc.hidden = !concerne;
    });
    // Première ouverture d'un dossier relogé : on propose le taux habituel
    // plutôt qu'une case vide, tout en laissant le camping le corriger.
    if (concerne && fields.remise_taux.value === '') {
      fields.remise_taux.value = String(tauxRemiseDefaut);
    }
  }

  function closeModal() {
    modalOverlay.hidden = true;
    currentEditId = null;
    // Plus de fiche en arrière-plan : une fermeture de la réponse formulaire ne
    // doit plus rien faire réapparaître.
    ficheMasqueeParForms = false;
  }

  // Trois façons de fermer sans enregistrer : la croix, le bouton Annuler et le
  // clic en dehors de la pop-in. Aucune n'envoie de requête au serveur : les
  // saisies en cours sont simplement abandonnées, et les champs seront
  // repeuplés depuis la base à la prochaine ouverture.
  fields.remboursement.addEventListener('change', refreshCommentaireVisibility);
  fields.action_camping.addEventListener('change', refreshCommentaireCampingVisibility);
  fields.decision_client.addEventListener('change', refreshDecisionAide);
  fields.decision_client.addEventListener('change', refreshSuiviRelogement);
  fields.methode_remboursement.addEventListener('change', () => {
    refreshMethodeAide();
    refreshCoordonneesBancaires();
  });

  // Le bouton du haut soumet le même formulaire que celui du bas : une seule et
  // même logique d'enregistrement, aucun risque de divergence.
  modalSaveTop.addEventListener('click', () => {
    modalForm.requestSubmit ? modalForm.requestSubmit() : modalForm.dispatchEvent(new Event('submit', { cancelable: true }));
  });

  modalCancel.addEventListener('click', closeModal);
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Échap ferme aussi la pop-in, sans enregistrer. On remonte le fil d'un cran
  // à chaque appui : réponse formulaire, puis fiche séjour, puis le tableau.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!formsOverlay.hidden) { closeFormsModal(); return; }
    if (!modalOverlay.hidden) closeModal();
  });

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentEditId) return;

    // La validation native du navigateur est désactivée sur ce formulaire :
    // elle refusait l'envoi sans le moindre message, la fiche semblait figée.
    // Le contrôle est fait ici, avec une explication à l'écran.
    const invalides = ALL_FIELDS
      .filter((key) => fields[key].type === 'number' && fields[key].value !== ''
        && !Number.isFinite(Number(fields[key].value)))
      .map((key) => {
        const label = document.querySelector('label[for="f-' + key + '"]');
        return label ? label.textContent.trim() : key;
      });
    if (invalides.length) {
      modalMessage.textContent = 'Valeur numérique incorrecte : ' + invalides.join(', ') + '.';
      modalMessage.className = 'modal-message error';
      modalMessage.hidden = false;
      return;
    }

    modalSave.disabled = true;
    modalSave.textContent = 'Enregistrement...';
    modalMessage.hidden = true;

    const payload = {};
    ALL_FIELDS.forEach((key) => {
      payload[key] = CHAMPS_MONTANT_CALCULE.includes(key)
        ? valeurMontantCalcule(key)
        : fields[key].value;
    });

    try {
      const resp = await fetch('/api/sejours/' + currentEditId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();

      if (!resp.ok) {
        modalMessage.textContent = data.error || 'Erreur lors de la mise à jour.';
        modalMessage.className = 'modal-message error';
        modalMessage.hidden = false;
        modalSave.disabled = false;
        modalSave.textContent = 'Enregistrer';
        return;
      }

      modalMessage.textContent = 'Séjour mis à jour.';
      modalMessage.className = 'modal-message success';
      modalMessage.hidden = false;

      setTimeout(() => {
        closeModal();
        loadPage();
      }, 1000);
    } catch (err) {
      modalMessage.textContent = 'Erreur réseau : ' + err.message;
      modalMessage.className = 'modal-message error';
      modalMessage.hidden = false;
      modalSave.disabled = false;
      modalSave.textContent = 'Enregistrer';
    }
  });

  // Construit les paramètres de filtrage courants. Utilisé à la fois par la
  // liste et par l'export : ils partagent ainsi toujours le même périmètre.
  // Les futurs filtres de colonnes devront être ajoutés ici (et dans
  // parseSejoursFilters côté serveur).
  // Valeurs cochées d'un groupe de "chips" (cases à cocher stylisées).
  function checkedValues(container) {
    if (!container) return [];
    return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  }

  // Construit les paramètres envoyés au serveur. Source unique de vérité :
  // utilisée à la fois par la liste et par l'export, qui portent donc toujours
  // exactement le même périmètre de lignes.
  function currentFilterParams() {
    const p = new URLSearchParams();
    if (searchTerm) p.set('search', searchTerm);

    const setIf = (key, value) => { if (value !== '' && value !== null && value !== undefined) p.set(key, value); };
    setIf('arrivee_du', fl.arriveeDu.value);
    setIf('arrivee_au', fl.arriveeAu.value);
    setIf('depart_du', fl.departDu.value);
    setIf('depart_au', fl.departAu.value);
    setIf('ttc_min', fl.ttcMin.value);
    setIf('ttc_max', fl.ttcMax.value);
    setIf('regle_min', fl.regleMin.value);
    setIf('regle_max', fl.regleMax.value);

    const joinIf = (key, values) => { if (values.length) p.set(key, values.join('|')); };
    joinIf('nombre_personnes', checkedValues(fl.nbPersonnes));
    joinIf('remboursement', checkedValues(fl.remboursement));
    joinIf('methode_remboursement', checkedValues(fl.methodeRemboursement));
    joinIf('decision_client', checkedValues(fl.decisionClient));
    joinIf('statut_client', checkedValues(fl.statutClient));
    joinIf('situation_desc', checkedValues(fl.situationDesc));
    joinIf('statut_emplacement', checkedValues(fl.statutEmplacement));
    joinIf('categorie_pms', checkedValues(fl.categoriePms));
    joinIf('quartier', checkedValues(fl.quartier));
    joinIf('relogement_statut', checkedValues(fl.relogementStatut));
    joinIf('remise_statut', checkedValues(fl.remiseStatut));
    joinIf('modes_paiement', checkedValues(fl.modesPaiement));
    joinIf('camping_relogement', checkedValues(fl.camping));

    joinIf('fidelite', checkedValues(fl.fidelite));
    // Le tri accompagne les filtres : l'export reprend donc exactement le même
    // classement que celui affiché à l'écran.
    if (tri.colonne) { p.set('tri', tri.colonne); p.set('sens', tri.sens); }

    joinIf('reponse_forms', checkedValues(fl.reponseForms));
    joinIf('source_forms', checkedValues(fl.sourceForms));
    joinIf('action_camping', checkedValues(fl.actionCamping));
    // Aucune case cochée => pas de contrainte, les deux cochées non plus.

    // Opérateur appliqué aux modes de paiement (ET / OU).
    const opModes = document.querySelector('input[name="fl-modes-op"]:checked');
    if (opModes && opModes.value === 'et') p.set('modes_paiement_op', 'et');

    if (fl.mailing1.checked) p.set('mailing_1', '1');
    if (fl.mailing2.checked) p.set('mailing_2', '1');
    if (fl.mailing3.checked) p.set('mailing_3', '1');

    return p;
  }

  // Nombre de filtres actifs (hors recherche libre) pour le badge du bouton.
  function activeFilterCount() {
    let n = 0;
    ['arriveeDu','arriveeAu','departDu','departAu','ttcMin','ttcMax','regleMin','regleMax']
      .forEach((k) => { if (fl[k].value !== '') n += 1; });
    n += checkedValues(fl.nbPersonnes).length;
    n += checkedValues(fl.remboursement).length;
    n += checkedValues(fl.methodeRemboursement).length;
    n += checkedValues(fl.decisionClient).length;
    n += checkedValues(fl.statutClient).length;
    n += checkedValues(fl.situationDesc).length;
    n += checkedValues(fl.statutEmplacement).length;
    n += checkedValues(fl.categoriePms).length;
    n += checkedValues(fl.quartier).length;
    n += checkedValues(fl.relogementStatut).length;
    n += checkedValues(fl.remiseStatut).length;
    n += checkedValues(fl.modesPaiement).length;
    n += checkedValues(fl.camping).length;
    ['mailing1','mailing2','mailing3'].forEach((k) => { if (fl[k].checked) n += 1; });
    n += checkedValues(fl.fidelite).length;
    n += checkedValues(fl.reponseForms).length;
    n += checkedValues(fl.sourceForms).length;
    n += checkedValues(fl.actionCamping).length;
    return n;
  }

  function refreshFilterBadge() {
    const n = activeFilterCount();
    filtersCount.textContent = String(n);
    filtersCount.hidden = n === 0;
  }

  // Génère un groupe de chips cochables à partir des valeurs réellement
  // présentes en base (endpoint /api/sejours/filter-options).
  // optionsFixes : cases qui ne viennent pas des données mais du métier, comme
  // « Vide » pour isoler les dossiers pas encore traités. Elles sont ajoutées
  // en fin de liste, après les valeurs réellement présentes en base.
  function renderChips(container, values, { emptyLabel, optionsFixes } = {}) {
    container.innerHTML = '';
    const fixes = optionsFixes || [];
    if ((!values || values.length === 0) && fixes.length === 0) {
      container.classList.add('filter-chips-empty');
      container.textContent = emptyLabel || 'Aucune valeur disponible';
      return;
    }
    container.classList.remove('filter-chips-empty');

    const ajouterChip = (valeur, libelle, classeSup) => {
      const label = document.createElement('label');
      label.className = 'filter-chip' + (classeSup ? ' ' + classeSup : '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(valeur);
      input.addEventListener('change', () => {
        label.classList.toggle('checked', input.checked);
        refreshFilterBadge();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(libelle));
      container.appendChild(label);
    };

    (values || []).forEach((v) => ajouterChip(v, String(v)));
    fixes.forEach((o) => ajouterChip(o.valeur, o.libelle, 'filter-chip-special'));
  }

  async function loadFilterOptions() {
    try {
      const resp = await fetch('/api/sejours/filter-options');
      if (!resp.ok) return;
      const data = await resp.json();
      renderChips(fl.nbPersonnes, data.nombre_personnes);
      // « Vide » n'existe pas en base : c'est une option métier, qui isole les
      // dossiers dont le remboursement n'a pas encore été renseigné.
      renderChips(fl.remboursement, data.remboursement, {
        optionsFixes: [{ valeur: '__vide__', libelle: 'Vide (non traité)' }],
      });
      renderChips(fl.methodeRemboursement, data.methode_remboursement);
      renderChips(fl.decisionClient, data.decision_client);
      renderChips(fl.statutClient, data.statut_client);
      renderChips(fl.situationDesc, data.situation_desc, { emptyLabel: 'Aucune situation renseignée' });
      renderChips(fl.statutEmplacement, data.statut_emplacement, { emptyLabel: 'Aucun état d\'emplacement renseigné' });
      renderChips(fl.categoriePms, data.categorie_pms);
      renderChips(fl.quartier, data.quartier, { emptyLabel: 'Aucun quartier renseigné' });
      renderChips(fl.relogementStatut, data.relogement_statut, {
        optionsFixes: [{ valeur: '__vide__', libelle: 'Pas encore traité' }],
      });
      renderChips(fl.remiseStatut, data.remise_statut, {
        optionsFixes: [{ valeur: '__vide__', libelle: 'Pas encore traitée' }],
      });
      if (typeof data.remise_taux_defaut === 'number') tauxRemiseDefaut = data.remise_taux_defaut;
      renderChips(fl.modesPaiement, data.modes_paiement);
      renderChips(fl.camping, data.camping_relogement, { emptyLabel: 'Aucun relogement enregistré' });
      // Les chips viennent d'être reconstruites : on remet les compteurs des
      // listes repliables d'aplomb. Le repli lui-même n'est pas touché, l'écoute
      // du conteneur ayant survécu au remplacement de son contenu.
      refreshCategorieCount();

      // Les bornes réelles guident la saisie sans la contraindre.
      const b = data.bornes || {};
      if (b.arrivee && b.arrivee.min) {
        [fl.arriveeDu, fl.arriveeAu].forEach((el) => { el.min = b.arrivee.min; el.max = b.arrivee.max; });
      }
      if (b.depart && b.depart.min) {
        [fl.departDu, fl.departAu].forEach((el) => { el.min = b.depart.min; el.max = b.depart.max; });
      }
      if (b.ttc && b.ttc.min !== null) {
        fl.ttcMin.placeholder = 'min ' + Math.floor(b.ttc.min);
        fl.ttcMax.placeholder = 'max ' + Math.ceil(b.ttc.max);
      }
      if (b.regle && b.regle.min !== null) {
        fl.regleMin.placeholder = 'min ' + Math.floor(b.regle.min);
        fl.regleMax.placeholder = 'max ' + Math.ceil(b.regle.max);
      }
    } catch (err) {
      /* les filtres restent utilisables même si les options ne chargent pas */
    }
  }

  // Cases fidélité, réponse forms et présence à la date pivot : ces chips sont écrites
  // en dur dans le HTML, on leur donne le même comportement visuel que celles
  // générées depuis /filter-options.
  [fl.fidelite, fl.reponseForms, fl.sourceForms, fl.actionCamping].forEach((conteneur) => {
    conteneur.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        input.closest('.filter-chip').classList.toggle('checked', input.checked);
        refreshFilterBadge();
      });
    });
  });


  // Bascule ET / OU des modes de paiement : met à jour l'aide contextuelle.
  const modesHint = document.getElementById('fl-modes-hint');
  document.querySelectorAll('input[name="fl-modes-op"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('input[name="fl-modes-op"]').forEach((r) => {
        r.closest('.op-chip').classList.toggle('checked', r.checked);
      });
      modesHint.innerHTML = radio.value === 'et'
        ? "Plusieurs modes cochés : le séjour doit contenir <strong>tous</strong> les modes sélectionnés."
        : "Plusieurs modes cochés : le séjour est retenu s'il contient <strong>au moins un</strong> des modes sélectionnés.";
    });
  });

  filtersToggle.addEventListener('click', () => {
    filtersPanel.hidden = !filtersPanel.hidden;
    if (!filtersPanel.hidden) columnsPanel.hidden = true;   // un seul panneau ouvert
  });

  const filtersApplyTop = document.getElementById('filters-apply-top');
  const filtersResetTop = document.getElementById('filters-reset-top');
  filtersApplyTop.addEventListener('click', () => filtersApply.click());
  filtersResetTop.addEventListener('click', () => filtersReset.click());

  // Listes longues et variables selon les campings : repliées par défaut, avec
  // un compteur pour que l'utilisateur voie qu'un filtre est actif dedans même
  // quand la liste est fermée.
  //
  // Un seul mécanisme pour toutes ces listes : deux câblages séparés finiraient
  // par diverger, et une flèche désynchronisée de l'état réel est le genre de
  // détail qui passe inaperçu en développement et saute aux yeux à l'usage.
  const replis = [];

  // Déclarée en `function` et non en `const` : le chargement asynchrone des
  // options de filtre l'appelle, et une fonction hissée ne dépend pas de
  // l'ordre d'exécution.
  function refreshCategorieCount() {
    replis.forEach((r) => r.majCompteur());
  }

  function installerRepli(idBouton, idCompteur, conteneur, nomPluriel) {
    const bouton = document.getElementById(idBouton);
    const compteur = document.getElementById(idCompteur);
    if (!bouton || !compteur || !conteneur) return null;

    const fleche = bouton.querySelector('.filter-collapse-arrow');

    // Le nombre de valeurs disponibles, affiché avant même le premier clic :
    // c'est ce qui signale qu'une liste se cache là, et ce qu'elle contient.
    // Construit ici plutôt que dans le HTML pour que toute liste repliable en
    // hérite sans avoir à dupliquer le balisage.
    const indice = document.createElement('span');
    indice.className = 'filter-collapse-hint';
    const espaceur = document.createElement('span');
    espaceur.className = 'filter-collapse-spacer';

    // Ordre imposé ici plutôt que subi du HTML : libellé, décompte des valeurs,
    // espaceur, puis chevron collé à droite. appendChild déplace un nœud déjà
    // présent, donc l'ordre final ne dépend pas de celui du gabarit.
    bouton.querySelector('.filter-label').after(indice);
    bouton.appendChild(espaceur);
    bouton.appendChild(compteur);
    bouton.appendChild(fleche);

    const majIndice = () => {
      const total = conteneur.querySelectorAll('input[type="checkbox"]').length;
      indice.textContent = total ? total + ' ' + nomPluriel : '';
    };

    const majCompteur = () => {
      majIndice();
      const n = checkedValues(conteneur).length;
      compteur.textContent = String(n);
      compteur.hidden = n === 0;
    };

    // L'état affiché découle toujours de `hidden`, jamais d'une variable
    // parallèle : impossible que chevron, aria-expanded et contenu divergent.
    // Le chevron pivote en CSS depuis aria-expanded — une seule source de
    // vérité, et rien à resynchroniser à la main.
    const appliquerEtat = () => {
      bouton.setAttribute('aria-expanded', String(!conteneur.hidden));
    };

    bouton.addEventListener('click', () => {
      conteneur.hidden = !conteneur.hidden;
      appliquerEtat();
    });
    conteneur.addEventListener('change', majCompteur);

    appliquerEtat();
    majCompteur();

    const repli = { majCompteur, replier: () => { conteneur.hidden = true; appliquerEtat(); } };
    replis.push(repli);
    return repli;
  }

  installerRepli('fl-categorie-toggle', 'fl-categorie-count', fl.categoriePms, 'catégories');
  installerRepli('fl-camping-toggle', 'fl-camping-count', fl.camping, 'campings');


  filtersApply.addEventListener('click', () => {
    currentPage = 1;
    refreshFilterBadge();
    filtersPanel.hidden = true;   // referme le panneau après application
    loadPage();
  });

  filtersReset.addEventListener('click', () => {
    ['arriveeDu','arriveeAu','departDu','departAu','ttcMin','ttcMax','regleMin','regleMax']
      .forEach((k) => { fl[k].value = ''; });
    [fl.nbPersonnes, fl.remboursement, fl.methodeRemboursement, fl.decisionClient, fl.statutClient, fl.situationDesc, fl.categoriePms, fl.quartier, fl.relogementStatut, fl.remiseStatut, fl.modesPaiement, fl.fidelite, fl.reponseForms, fl.sourceForms, fl.actionCamping, fl.statutEmplacement, fl.camping].forEach((container) => {
      container.querySelectorAll('input[type="checkbox"]').forEach((i) => {
        i.checked = false;
        i.closest('.filter-chip').classList.remove('checked');
      });
    });
    ['mailing1','mailing2','mailing3'].forEach((k) => { fl[k].checked = false; });
    // Réinitialiser, c'est aussi revenir à l'état d'ouverture initial : les
    // listes longues se referment, sinon le panneau rouvre déplié sans qu'aucun
    // filtre n'y soit coché.
    replis.forEach((r) => { r.replier(); r.majCompteur(); });
    const opOu = document.querySelector('input[name="fl-modes-op"][value="ou"]');
    if (opOu) { opOu.checked = true; opOu.dispatchEvent(new Event('change')); }
    currentPage = 1;
    refreshFilterBadge();
    filtersPanel.hidden = true;   // referme le panneau, comme Appliquer
    loadPage();
  });

  async function exportSelection() {
    exportBtn.disabled = true;
    const originalLabel = exportBtn.textContent;
    exportBtn.textContent = 'Export en cours...';
    exportMessage.hidden = true;

    try {
      const url = new URL('/api/sejours/export', window.location.origin);
      currentFilterParams().forEach((value, key) => url.searchParams.set(key, value));

      const resp = await fetch(url);
      if (!resp.ok) {
        let msg = 'Erreur lors de l\'export.';
        try {
          const data = await resp.json();
          if (data && data.error) msg = data.error;
        } catch (e) { /* réponse non JSON : on garde le message générique */ }
        throw new Error(msg);
      }

      const exportedRows = resp.headers.get('X-Export-Rows');
      const blob = await resp.blob();

      // Récupère le nom de fichier proposé par le serveur si disponible.
      let filename = 'sejours.xlsx';
      const disposition = resp.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];

      const link = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);

      exportMessage.textContent = exportedRows
        ? `Export réussi : ${exportedRows} ligne(s) dans ${filename}.`
        : `Export réussi : ${filename}.`;
      exportMessage.className = 'export-message success';
      exportMessage.hidden = false;
    } catch (err) {
      exportMessage.textContent = err.message || 'Erreur lors de l\'export.';
      exportMessage.className = 'export-message error';
      exportMessage.hidden = false;
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = originalLabel;
    }
  }

  exportBtn.addEventListener('click', exportSelection);

  // -------------------------------------------------------------------------
  // Modale "Réponse au formulaire" : consultation et édition d'une ligne de
  // choix_client, accessible depuis la fiche séjour ou depuis la valeur
  // cliquable de la colonne "Réponse forms".
  // -------------------------------------------------------------------------

  // Mêmes libellés que dans les vues "A répondu" / "Match incorrect" et que dans
  // l'export : formulaire 1 le décalage, formulaire 2 les évacués,
  // formulaire 3 les No Show.
  //
  // Chaque formulaire pose ses propres questions, et ne demande de coordonnées
  // bancaires que s'il peut déboucher sur un remboursement — ce que le
  // formulaire 3 ne fait jamais, ses deux réponses aboutissant à un bon à valoir.
  // À ajuster quand les formulaires seront connus : `questions` liste les champs
  // réellement posés par ce formulaire, `remboursement` dit s'il demande les
  // coordonnées bancaires. Les champs non listés sont masqués dans la pop-in.
  const FORMULAIRES = [
    { cle: 'id_f1', libelle: 'Relogement', questions: ['choix'], remboursement: true },
  ];
  // Champs susceptibles d'être masqués. Les autres (nom, prénom, email, numéro
  // de réservation, statut) valent pour les trois formulaires.
  const CHAMPS_QUESTIONS = ['choix', 'situation', 'je_choisis', 'je_decide', 'nous_proposons'];
  const CHAMPS_REMBOURSEMENT = ['method_remb', 'iban', 'bic', 'info_banque'];

  function formulaireDeLaReponse(row) {
    return FORMULAIRES.find((f) => row[f.cle] !== null && row[f.cle] !== undefined) || null;
  }

  function sourceLabel(row) {
    const f = formulaireDeLaReponse(row);
    return f ? f.libelle : '–';
  }

  // Masque les questions qui n'appartiennent pas au formulaire auquel le client
  // a répondu, pour ne laisser à l'écran que ce qui le concerne.
  //
  // Deux garde-fous. Un champ portant une valeur reste toujours affiché, même
  // s'il ne relève pas du formulaire : on ne cache jamais une donnée réelle, et
  // ce cas est signalé par la mention du formulaire d'origine. Et si aucune
  // colonne d'identifiant n'est renseignée, tout est affiché : mieux vaut une
  // pop-in trop longue qu'une information escamotée.
  //
  // Cette fonction ne touche qu'à l'affichage : tous les champs restent
  // renseignés et envoyés à l'enregistrement, exactement comme avant.
  function ajusterChampsAuFormulaire(row) {
    const formulaire = formulaireDeLaReponse(row);
    const attendus = new Set(formulaire ? formulaire.questions : CHAMPS_QUESTIONS);
    if (!formulaire || formulaire.remboursement) CHAMPS_REMBOURSEMENT.forEach((c) => attendus.add(c));

    [...CHAMPS_QUESTIONS, ...CHAMPS_REMBOURSEMENT].forEach((cle) => {
      const champ = formsFields[cle];
      if (!champ) return;
      const bloc = champ.closest('.modal-field');
      if (!bloc) return;
      const aUneValeur = String(champ.value || '').trim() !== '';
      const duFormulaire = attendus.has(cle);
      bloc.hidden = !(duFormulaire || aUneValeur);

      // La précision « (formulaire N) » ne sert plus quand seuls les champs du
      // bon formulaire sont affichés : on ne la garde que pour signaler une
      // réponse qui sort de son formulaire.
      const mention = bloc.querySelector('.modal-hint');
      if (mention) mention.hidden = duFormulaire;
    });
  }

  // Remet toute la pop-in visible : état de départ avant chaque chargement.
  function afficherTousLesChamps() {
    [...CHAMPS_QUESTIONS, ...CHAMPS_REMBOURSEMENT].forEach((cle) => {
      const champ = formsFields[cle];
      const bloc = champ && champ.closest('.modal-field');
      if (bloc) bloc.hidden = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Enchaînement des pop-in.
  //
  // Deux fenêtres ne sont jamais affichées en même temps. La réponse au
  // formulaire peut s'ouvrir de deux endroits :
  //   - depuis la colonne "Réponse forms" du tableau : à la fermeture, on
  //     revient simplement au tableau ;
  //   - depuis le bouton "Réponse forms" de la fiche séjour : on masque alors
  //     la fiche le temps de la consultation, puis on la réaffiche à la
  //     fermeture pour que l'utilisateur retrouve son point de départ.
  //
  // La fiche masquée n'est pas fermée : son contenu et le séjour en cours
  // d'édition restent intacts, on ne fait que la retirer de l'écran.
  // ---------------------------------------------------------------------------
  let ficheMasqueeParForms = false;

  async function openFormsModal(formsId, { depuisFiche = false } = {}) {
    if (!formsId) return;
    currentFormsId = Number(formsId);

    ficheMasqueeParForms = depuisFiche;
    if (depuisFiche) modalOverlay.hidden = true;

    // Réinitialisation avant chargement, pour ne jamais afficher les données
    // d'une réponse précédemment consultée.
    FORMS_EDITABLE.forEach((k) => { formsFields[k].value = ''; });
    formsFields.id.value = formsId;
    formsFields.source.value = '';
    // On repart d'une pop-in complète : le tri des champs se fera une fois la
    // réponse chargée, quand on saura de quel formulaire elle vient.
    afficherTousLesChamps();
    formsMessage.hidden = true;
    formsSave.disabled = true;
    formsSave.textContent = 'Chargement...';
    formsOverlay.hidden = false;

    try {
      const resp = await fetch('/api/clients/' + formsId);
      const data = await resp.json();
      if (!resp.ok) {
        formsMessage.textContent = data.error || 'Réponse formulaire introuvable.';
        formsMessage.className = 'modal-message error';
        formsMessage.hidden = false;
        formsSave.textContent = 'Enregistrer';
        return;
      }

      const row = data.row;
      FORMS_EDITABLE.forEach((k) => {
        formsFields[k].value = row[k] === null || row[k] === undefined ? '' : row[k];
      });
      formsFields.id.value = row.id;
      formsFields.source.value = sourceLabel(row);
      ajusterChampsAuFormulaire(row);
      formsSave.disabled = false;
      formsSave.textContent = 'Enregistrer';
    } catch (err) {
      formsMessage.textContent = 'Erreur réseau : ' + err.message;
      formsMessage.className = 'modal-message error';
      formsMessage.hidden = false;
      formsSave.textContent = 'Enregistrer';
    }
  }

  // rouvrirFiche : vrai pour une simple fermeture (croix, Annuler, Échap, clic
  // à côté) où l'on rend la main à la fiche séjour. Faux après un
  // enregistrement, car la fiche serait alors périmée : on la rouvre à jour.
  function closeFormsModal({ rouvrirFiche = true } = {}) {
    formsOverlay.hidden = true;
    currentFormsId = null;
    if (rouvrirFiche && ficheMasqueeParForms) modalOverlay.hidden = false;
    ficheMasqueeParForms = false;
  }

  modalFormsBtn.addEventListener('click', () => {
    openFormsModal(modalFormsBtn.dataset.formsId, { depuisFiche: true });
  });

  // Fermeture sans enregistrer : croix, Annuler, clic à côté (Échap est géré
  // plus bas, en même temps que la fiche séjour).
  formsClose.addEventListener('click', closeFormsModal);
  formsCancel.addEventListener('click', closeFormsModal);
  formsOverlay.addEventListener('click', (e) => {
    if (e.target === formsOverlay) closeFormsModal();
  });

  formsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentFormsId) return;

    formsSave.disabled = true;
    formsSave.textContent = 'Enregistrement...';
    formsMessage.hidden = true;

    const payload = {};
    FORMS_EDITABLE.forEach((k) => { payload[k] = formsFields[k].value; });

    try {
      const resp = await fetch('/api/clients/' + currentFormsId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();

      if (!resp.ok) {
        formsMessage.textContent = data.error || 'Erreur lors de la mise à jour.';
        formsMessage.className = 'modal-message error';
        formsMessage.hidden = false;
        formsSave.disabled = false;
        formsSave.textContent = 'Enregistrer';
        return;
      }

      // Le serveur relance le rapprochement avec les séjours : on restitue le
      // résultat pour que l'utilisateur sache si le lien a changé.
      let msg = 'Réponse mise à jour.';
      if (data.match) {
        msg += data.match.matched
          ? ' Correspondance trouvée dans les séjours (' +
            (data.match.via === 'email' ? 'par email' : 'par numéro de réservation') + ').'
          : ' Aucune correspondance trouvée dans les séjours.';
        if (data.match.statutForced) msg += ' Le statut a été forcé à « A répondu ».';
        // Le rapprochement redétermine la méthode de remboursement.
        if (data.match.methode) msg += ' Méthode de remboursement : ' + data.match.methode + '.';
      }
      formsMessage.textContent = msg;
      formsMessage.className = 'modal-message success';
      formsMessage.hidden = false;

      setTimeout(async () => {
        // Le rapprochement a pu déplacer le lien id_choix_client : on recharge
        // la liste, puis on rouvre la fiche séjour avec ses données à jour si
        // c'est de là que l'utilisateur venait.
        const sejourDOrigine = ficheMasqueeParForms ? currentEditId : null;
        closeFormsModal({ rouvrirFiche: false });
        await loadPage();
        if (sejourDOrigine && rowsById[sejourDOrigine]) openModal(sejourDOrigine);
      }, 1400);
    } catch (err) {
      formsMessage.textContent = 'Erreur réseau : ' + err.message;
      formsMessage.className = 'modal-message error';
      formsMessage.hidden = false;
      formsSave.disabled = false;
      formsSave.textContent = 'Enregistrer';
    }
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchTerm = searchInput.value.trim();
      currentPage = 1;
      loadPage();
    }, 350);
  });

  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage -= 1;
      loadPage();
    }
  });

  nextBtn.addEventListener('click', () => {
    currentPage += 1;
    loadPage();
  });

  renderColumnsList();
  applyHiddenColumns();
  activerTriEntetes();
  loadFilterOptions();
  loadPage();
})();
