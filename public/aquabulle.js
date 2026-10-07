// Onglet « Dossiers Aquabulle » : la vue de travail des séjours du quartier
// sinistré, seuls concernés par le formulaire. Volontairement plus pauvre que la liste générale — pas de
// masquage de colonnes, pas de filtres de dates ni de montants — parce qu'elle
// répond à une seule question : où en est chaque dossier. La liste générale
// reste la vue exhaustive, rien n'y est caché.
(() => {
  const PAGE_SIZE = 50;
  const VIDE = '__vide__';
  const TAUX_DEFAUT_REPLI = 20;

  // Vocabulaire métier, identique à celui que le serveur valide. Il est répété
  // ici parce que la base démarre sans aucune réponse : /filter-options ne
  // proposerait rien et le camping n'aurait aucun filtre le premier jour. Les
  // valeurs réellement présentes en base sont fusionnées au chargement, donc une
  // valeur ajoutée côté serveur apparaît sans toucher à ce fichier.
  const DECISIONS = ['Annulé', 'Relogement + remise'];
  const METHODES = ['Carte', 'Virement', 'BAV', 'À vérifier'];
  const REMBOURSEMENTS = ['Oui', 'Non', 'Partiel'];
  const RELOGEMENT_STATUTS = ['À reloger', 'Relogé', 'Refusé par le client'];
  const REMISE_STATUTS = ['À appliquer', 'Appliquée'];
  const DECISION_RELOGEMENT = 'Relogement + remise';
  const DECISION_ANNULE = 'Annulé';

  // Les colonnes du tableau, dans l'ordre des <th> de la page. Le libellé n'est
  // pas repris ici (il vit dans le HTML) : seule la correspondance
  // clé -> rendu compte, pour que l'ordre des cellules ne puisse pas dériver de
  // celui des entêtes.
  const COLONNES = [
    { col: 'client', valeur: (r) => [r.nom, r.prenom].filter(Boolean).join(' ') },
    { col: 'numero_reservation', valeur: (r) => r.numero_reservation },
    { col: 'numero_emplacement', valeur: (r) => r.numero_emplacement },
    { col: 'date_debut_sejour', valeur: (r) => formatDate(r.date_debut_sejour) },
    { col: 'date_depart_sejour', valeur: (r) => formatDate(r.date_depart_sejour) },
    { col: 'montant_regle', valeur: (r) => formatMontant(r.montant_regle), classe: 'num' },
    { col: 'reponse_forms', valeur: (r) => (r.id_choix_client ? 'Oui' : '—') },
    { col: 'decision_client', valeur: (r) => r.decision_client },
    { col: 'methode_remboursement', valeur: (r) => r.methode_remboursement },
    { col: 'remboursement', valeur: (r) => r.remboursement },
    { col: 'relogement_statut', valeur: (r) => r.relogement_statut },
    { col: 'relogement_hebergement', valeur: (r) => r.relogement_hebergement },
    { col: 'remise_statut', valeur: (r) => r.remise_statut },
    { col: 'remise_taux', valeur: (r) => formatTaux(r.remise_taux), classe: 'num' },
  ];

  // Les six familles de filtres de l'onglet. Chaque entrée dit où sont ses
  // chips, quel paramètre d'URL elle alimente, et si elle propose une case
  // « pas encore traité » pour isoler les dossiers en attente.
  const FILTRES = [
    { cle: 'reponseForms', param: 'reponse_forms', conteneur: 'fl-reponse-forms', statique: true },
    { cle: 'decisionClient', param: 'decision_client', conteneur: 'fl-decision-client', valeurs: DECISIONS, champ: 'decision_client', vide: 'Pas encore de réponse' },
    { cle: 'methodeRemboursement', param: 'methode_remboursement', conteneur: 'fl-methode-remboursement', valeurs: METHODES, champ: 'methode_remboursement' },
    { cle: 'remboursement', param: 'remboursement', conteneur: 'fl-remboursement', valeurs: REMBOURSEMENTS, champ: 'remboursement', vide: 'Vide (non traité)' },
    { cle: 'relogementStatut', param: 'relogement_statut', conteneur: 'fl-relogement-statut', valeurs: RELOGEMENT_STATUTS, champ: 'relogement_statut', vide: 'Pas encore traité' },
    { cle: 'remiseStatut', param: 'remise_statut', conteneur: 'fl-remise-statut', valeurs: REMISE_STATUTS, champ: 'remise_statut', vide: 'Pas encore traitée' },
  ];

  // Les compteurs d'avancement. Cliquer sur l'un d'eux applique exactement les
  // filtres qui produisent les lignes qu'il compte : le chiffre affiché et la
  // liste obtenue disent donc toujours la même chose.
  const COMPTEURS = [
    { cle: 'total', libelle: 'Dossiers Aquabulle', filtres: {} },
    { cle: 'sans_reponse', libelle: 'Sans réponse', ton: 'stat-warn', filtres: { reponseForms: ['sans'] } },
    { cle: 'ont_repondu', libelle: 'Ont répondu', ton: 'stat-info', filtres: { reponseForms: ['avec'] } },
    { cle: 'annules', libelle: 'Annulations', filtres: { decisionClient: [DECISION_ANNULE] } },
    { cle: 'relogements', libelle: 'Relogements', filtres: { decisionClient: [DECISION_RELOGEMENT] } },
    {
      cle: 'remboursements_a_traiter', libelle: 'Remboursements à faire', ton: 'stat-warn',
      filtres: { decisionClient: [DECISION_ANNULE], remboursement: [VIDE] },
    },
    {
      cle: 'a_verifier', libelle: 'Méthode à vérifier', ton: 'stat-warn',
      filtres: { decisionClient: [DECISION_ANNULE], methodeRemboursement: ['À vérifier'] },
    },
    {
      cle: 'relogements_a_faire', libelle: 'Relogements à faire', ton: 'stat-warn',
      filtres: { decisionClient: [DECISION_RELOGEMENT], relogementStatut: [VIDE, 'À reloger'] },
    },
    {
      cle: 'remises_a_appliquer', libelle: 'Remises à appliquer', ton: 'stat-warn',
      filtres: { decisionClient: [DECISION_RELOGEMENT], remiseStatut: [VIDE, 'À appliquer'] },
    },
  ];

  // Les champs que la pop-in enregistre. Rien d'autre n'est transmis : la route
  // PUT n'écrit que les colonnes reçues, donc le reste de la fiche — montants,
  // coordonnées, rapprochement — est hors d'atteinte depuis cet onglet.
  const CHAMPS_EDITABLES = [
    'decision_client', 'methode_remboursement', 'remboursement',
    'relogement_statut', 'relogement_hebergement', 'remise_statut', 'remise_taux',
    'commentaire_camping',
  ];

  const el = (id) => document.getElementById(id);
  const tableBody = el('table-body');
  const totalCount = el('total-count');
  const pageInfo = el('page-info');
  const searchInput = el('search-input');
  const exportMessage = el('export-message');
  const filtersPanel = el('filters-panel');
  const filtersCount = el('filters-count');
  const avancement = el('avancement');
  const modalOverlay = el('modal-overlay');
  const modalMessage = el('modal-message');

  let page = 1;
  let total = 0;
  let tauxRemiseDefaut = TAUX_DEFAUT_REPLI;
  let sejourCourant = null;
  let compteurActif = null;
  let banqueChargeePour = null;

  function formatDate(valeur) {
    if (!valeur) return '';
    const d = new Date(valeur);
    if (Number.isNaN(d.getTime())) return String(valeur);
    const jj = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return jj + '/' + mm + '/' + d.getUTCFullYear();
  }

  function formatMontant(valeur) {
    if (valeur === null || valeur === undefined || valeur === '') return '';
    const n = Number(valeur);
    if (Number.isNaN(n)) return String(valeur);
    return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function formatTaux(valeur) {
    if (valeur === null || valeur === undefined || valeur === '') return '';
    const n = Number(valeur);
    if (Number.isNaN(n)) return String(valeur);
    // 20 et non « 20,00 » : un taux entier s'écrit sans décimales.
    return (Number.isInteger(n) ? String(n) : n.toLocaleString('fr-FR')) + ' %';
  }

  // ---------------------------------------------------------------------------
  // Filtres
  // ---------------------------------------------------------------------------

  function conteneurDe(f) { return el(f.conteneur); }

  function cases(f) {
    const c = conteneurDe(f);
    return c ? [...c.querySelectorAll('input[type="checkbox"]')] : [];
  }

  function valeursCochees(f) {
    return cases(f).filter((i) => i.checked).map((i) => i.value);
  }

  function nbFiltresActifs() {
    return FILTRES.reduce((n, f) => n + (valeursCochees(f).length ? 1 : 0), 0);
  }

  function refreshFilterBadge() {
    const n = nbFiltresActifs();
    filtersCount.textContent = String(n);
    filtersCount.hidden = n === 0;
  }

  function renderChips(f, valeursEnBase) {
    const conteneur = conteneurDe(f);
    if (!conteneur || f.statique) return;   // les chips « réponse » sont dans le HTML

    // Les valeurs du métier d'abord, dans leur ordre logique, puis toute valeur
    // trouvée en base qui n'y figurerait pas : on ne masque jamais une donnée
    // réelle sous prétexte qu'elle est inattendue.
    const connues = f.valeurs || [];
    const extras = (valeursEnBase || []).filter((v) => !connues.includes(v));
    conteneur.innerHTML = '';

    const ajouter = (valeur, libelle, classeSup) => {
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
      conteneur.appendChild(label);
    };

    connues.concat(extras).forEach((v) => ajouter(v, String(v)));
    if (f.vide) ajouter(VIDE, f.vide, 'filter-chip-special');
  }

  // Les chips statiques du HTML n'ont pas d'écouteur : on le pose ici pour que
  // le badge « Filtres » les compte comme les autres.
  function brancherChipsStatiques() {
    FILTRES.filter((f) => f.statique).forEach((f) => {
      cases(f).forEach((input) => {
        input.addEventListener('change', () => {
          input.closest('.filter-chip').classList.toggle('checked', input.checked);
          refreshFilterBadge();
        });
      });
    });
  }

  async function loadFilterOptions() {
    try {
      const data = await (await fetch('/api/sejours/filter-options')).json();
      FILTRES.forEach((f) => renderChips(f, f.champ ? data[f.champ] : null));
      if (typeof data.remise_taux_defaut === 'number') tauxRemiseDefaut = data.remise_taux_defaut;
    } catch (err) {
      // Sans les options on garde les valeurs du métier : l'onglet reste
      // utilisable, c'est le minimum attendu en gestion de crise.
      FILTRES.forEach((f) => renderChips(f, null));
      console.error('Options de filtre indisponibles :', err);
    }
  }

  // Coche exactement les cases décrites, décoche tout le reste.
  function appliquerSelection(selection) {
    FILTRES.forEach((f) => {
      const voulues = selection[f.cle] || [];
      cases(f).forEach((input) => {
        input.checked = voulues.includes(input.value);
        input.closest('.filter-chip').classList.toggle('checked', input.checked);
      });
    });
    refreshFilterBadge();
  }

  function buildQuery({ pagination = true } = {}) {
    const params = new URLSearchParams();
    if (pagination) {
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
    }
    const recherche = searchInput.value.trim();
    if (recherche) params.set('search', recherche);
    FILTRES.forEach((f) => {
      const v = valeursCochees(f);
      if (v.length) params.set(f.param, v.join('|'));
    });
    return params;
  }

  // ---------------------------------------------------------------------------
  // Tableau
  // ---------------------------------------------------------------------------

  function renderRows(rows) {
    tableBody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = COLONNES.length + 1;
      td.className = 'empty-row';
      td.textContent = 'Aucun dossier ne correspond à ces critères.';
      tr.appendChild(td);
      tableBody.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement('tr');
      COLONNES.forEach((c) => {
        const td = document.createElement('td');
        td.dataset.col = c.col;
        if (c.classe) td.className = c.classe;
        const v = c.valeur(r);
        td.textContent = v === null || v === undefined ? '' : String(v);
        tr.appendChild(td);
      });

      const tdAction = document.createElement('td');
      tdAction.dataset.col = 'action';
      const bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'btn-toggle';
      bouton.textContent = 'Suivre';
      bouton.title = 'Mettre à jour l\'avancement de ce dossier';
      bouton.addEventListener('click', () => ouvrirModal(r));
      tdAction.appendChild(bouton);
      tr.appendChild(tdAction);

      tableBody.appendChild(tr);
    });
  }

  async function loadRows() {
    tableBody.innerHTML = '<tr><td colspan="' + (COLONNES.length + 1)
      + '" class="empty-row">Chargement...</td></tr>';
    try {
      const resp = await fetch('/api/aquabulle?' + buildQuery().toString());
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Chargement impossible.');
      total = data.total || 0;
      totalCount.textContent = String(total);
      renderRows(data.rows || []);
      majPagination();
    } catch (err) {
      total = 0;
      totalCount.textContent = '–';
      tableBody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = COLONNES.length + 1;
      td.className = 'empty-row';
      td.textContent = 'Erreur : ' + err.message;
      tr.appendChild(td);
      tableBody.appendChild(tr);
      majPagination();
    }
  }

  function majPagination() {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pageInfo.textContent = 'Page ' + page + ' / ' + pages;
    el('prev-page').disabled = page <= 1;
    el('next-page').disabled = page >= pages;
  }

  // ---------------------------------------------------------------------------
  // Avancement
  // ---------------------------------------------------------------------------

  async function loadAvancement() {
    try {
      const resp = await fetch('/api/aquabulle/avancement');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Avancement indisponible.');
      renderAvancement(data);
    } catch (err) {
      avancement.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'subtitle';
      p.textContent = 'Avancement indisponible : ' + err.message;
      avancement.appendChild(p);
    }
  }

  function renderAvancement(data) {
    avancement.innerHTML = '';
    COMPTEURS.forEach((c) => {
      const bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'stat stat-clickable' + (c.ton ? ' ' + c.ton : '');
      bouton.dataset.compteur = c.cle;
      bouton.setAttribute('aria-pressed', 'false');
      bouton.title = 'Filtrer sur « ' + c.libelle + ' »';

      const valeur = document.createElement('span');
      valeur.className = 'stat-value';
      valeur.textContent = String(data[c.cle] ?? 0);
      const libelle = document.createElement('span');
      libelle.className = 'stat-label';
      libelle.textContent = c.libelle;
      bouton.appendChild(valeur);
      bouton.appendChild(libelle);

      bouton.addEventListener('click', () => {
        // Recliquer le compteur actif revient à tout afficher : le raccourci
        // s'annule comme il s'est appliqué.
        const annule = compteurActif === c.cle;
        compteurActif = annule ? null : c.cle;
        appliquerSelection(annule ? {} : c.filtres);
        searchInput.value = '';
        page = 1;
        majCompteurActif();
        loadRows();
      });

      avancement.appendChild(bouton);
    });
    majCompteurActif();
  }

  function majCompteurActif() {
    [...avancement.querySelectorAll('.stat-clickable')].forEach((b) => {
      const actif = b.dataset.compteur === compteurActif;
      b.classList.toggle('actif', actif);
      b.setAttribute('aria-pressed', actif ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------------------
  // Pop-in de suivi
  // ---------------------------------------------------------------------------

  const champ = (nom) => el('f-' + nom);

  // Ce qui est visible dépend de la décision du client : on ne demande pas une
  // méthode de remboursement à quelqu'un qu'on reloge, ni un hébergement
  // d'accueil à quelqu'un qui a annulé.
  function refreshBlocs() {
    const decision = champ('decision_client').value;
    const annule = decision === DECISION_ANNULE;
    const reloge = decision === DECISION_RELOGEMENT;

    ['bloc-annulation', 'champ-methode', 'champ-remboursement'].forEach((id) => { el(id).hidden = !annule; });
    ['bloc-relogement', 'champ-relogement-statut', 'champ-relogement-hebergement',
      'champ-remise-statut', 'champ-remise-taux'].forEach((id) => { el(id).hidden = !reloge; });

    // Le taux par défaut est proposé dès qu'un relogement est acté, et reste
    // modifiable : le cas particulier se saisit par-dessus.
    if (reloge && champ('remise_taux').value === '') {
      champ('remise_taux').value = String(tauxRemiseDefaut);
    }

    el('champ-banque').hidden = !(annule && champ('methode_remboursement').value === 'Virement');
    if (!el('champ-banque').hidden) chargerBanque();
  }

  async function chargerBanque() {
    const zone = champ('banque');
    const idReponse = sejourCourant && sejourCourant.id_choix_client;
    if (!idReponse) {
      banqueChargeePour = null;
      zone.value = "Aucune réponse au formulaire n'est rattachée à ce séjour : "
        + 'pas de coordonnées bancaires disponibles.';
      return;
    }
    if (banqueChargeePour === idReponse) return;

    zone.value = 'Chargement...';
    try {
      const resp = await fetch('/api/clients/' + idReponse);
      const data = await resp.json();
      // La pop-in a pu être refermée ou changer de dossier pendant la requête.
      if (!sejourCourant || sejourCourant.id_choix_client !== idReponse) return;
      if (!resp.ok || !data.row) throw new Error(data.error || 'réponse introuvable');
      const r = data.row;
      zone.value = r.iban
        ? ['IBAN : ' + r.iban, 'BIC : ' + (r.bic || '—'), 'Banque : ' + (r.info_banque || '—')].join('\n')
        : "Le client n'a pas communiqué ses coordonnées bancaires : il faut le "
          + 'recontacter avant de pouvoir virer.';
      banqueChargeePour = idReponse;
    } catch (err) {
      if (!sejourCourant || sejourCourant.id_choix_client !== idReponse) return;
      zone.value = 'Coordonnées bancaires indisponibles : ' + err.message;
    }
  }

  function afficherMessage(texte, erreur) {
    modalMessage.textContent = texte || '';
    modalMessage.hidden = !texte;
    modalMessage.classList.toggle('error', !!erreur);
  }

  function ouvrirModal(row) {
    sejourCourant = row;
    banqueChargeePour = null;
    afficherMessage('', false);

    el('modal-titre').textContent = [row.nom, row.prenom].filter(Boolean).join(' ') || 'Dossier';
    el('modal-sous-titre').textContent = [
      row.numero_reservation ? 'Résa ' + row.numero_reservation : null,
      row.numero_emplacement ? 'Emplacement ' + row.numero_emplacement : null,
      row.date_debut_sejour ? 'du ' + formatDate(row.date_debut_sejour) + ' au ' + formatDate(row.date_depart_sejour) : null,
      row.id_choix_client ? 'a répondu au formulaire' : 'pas de réponse au formulaire',
    ].filter(Boolean).join(' · ');

    CHAMPS_EDITABLES.forEach((nom) => {
      const c = champ(nom);
      if (c) c.value = row[nom] === null || row[nom] === undefined ? '' : String(row[nom]);
    });
    champ('banque').value = '';
    refreshBlocs();
    modalOverlay.hidden = false;
  }

  function fermerModal() {
    modalOverlay.hidden = true;
    sejourCourant = null;
    banqueChargeePour = null;
  }

  async function enregistrer(event) {
    event.preventDefault();
    if (!sejourCourant) return;

    // Seuls les champs pertinents sont envoyés : laisser partir un taux de
    // remise sur un dossier annulé reviendrait à écrire une donnée qui n'a pas
    // de sens, et qui ressortirait ensuite dans les filtres.
    const decision = champ('decision_client').value;
    const annule = decision === DECISION_ANNULE;
    const reloge = decision === DECISION_RELOGEMENT;
    const pertinent = {
      decision_client: true,
      commentaire_camping: true,
      methode_remboursement: annule,
      remboursement: annule,
      relogement_statut: reloge,
      relogement_hebergement: reloge,
      remise_statut: reloge,
      remise_taux: reloge,
    };

    const payload = {};
    CHAMPS_EDITABLES.forEach((nom) => {
      const c = champ(nom);
      if (!c) return;
      // Un champ devenu hors-sujet est explicitement vidé, pas ignoré : sinon
      // une ancienne méthode de remboursement survivrait à un passage en
      // relogement et le dossier resterait dans le filtre « à rembourser ».
      payload[nom] = pertinent[nom] ? c.value.trim() : '';
    });

    const bouton = el('modal-save');
    bouton.disabled = true;
    afficherMessage('Enregistrement...', false);
    try {
      const resp = await fetch('/api/sejours/' + sejourCourant.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Enregistrement impossible.');
      fermerModal();
      // L'avancement se recalcule : un dossier traité doit disparaître du
      // compteur correspondant tout de suite, sinon le camping le retraite.
      await Promise.all([loadRows(), loadAvancement()]);
    } catch (err) {
      afficherMessage(err.message, true);
    } finally {
      bouton.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async function exporter() {
    const bouton = el('export-btn');
    const params = buildQuery({ pagination: false });
    params.set('perimetre', 'aquabulle');
    bouton.disabled = true;
    exportMessage.hidden = false;
    exportMessage.classList.remove('error');
    exportMessage.textContent = 'Préparation de l\'export...';
    try {
      const resp = await fetch('/api/sejours/export?' + params.toString());
      if (!resp.ok) {
        let message = 'Export impossible.';
        try { message = (await resp.json()).error || message; } catch (e) { /* réponse non JSON */ }
        throw new Error(message);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = 'dossiers-aquabulle.xlsx';
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      URL.revokeObjectURL(url);
      exportMessage.textContent = 'Export téléchargé.';
    } catch (err) {
      exportMessage.classList.add('error');
      exportMessage.textContent = err.message;
    } finally {
      bouton.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Branchements
  // ---------------------------------------------------------------------------

  function appliquerFiltres() {
    page = 1;
    compteurActif = null;
    majCompteurActif();
    loadRows();
  }

  function init() {
    brancherChipsStatiques();
    refreshFilterBadge();

    el('filters-toggle').addEventListener('click', () => { filtersPanel.hidden = !filtersPanel.hidden; });
    el('filters-apply').addEventListener('click', () => { filtersPanel.hidden = true; appliquerFiltres(); });
    el('filters-reset').addEventListener('click', () => {
      appliquerSelection({});
      searchInput.value = '';
      appliquerFiltres();
    });

    let minuterie = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => { page = 1; loadRows(); }, 300);
    });

    el('prev-page').addEventListener('click', () => { if (page > 1) { page -= 1; loadRows(); } });
    el('next-page').addEventListener('click', () => {
      if (page < Math.ceil(total / PAGE_SIZE)) { page += 1; loadRows(); }
    });

    el('export-btn').addEventListener('click', exporter);

    el('modal-form').addEventListener('submit', enregistrer);
    el('modal-close').addEventListener('click', fermerModal);
    el('modal-cancel').addEventListener('click', fermerModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) fermerModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalOverlay.hidden) fermerModal(); });
    champ('decision_client').addEventListener('change', () => {
      // Changer de décision remet le taux en jeu : il sera reproposé à 20 %.
      if (champ('decision_client').value !== DECISION_RELOGEMENT) champ('remise_taux').value = '';
      refreshBlocs();
    });
    champ('methode_remboursement').addEventListener('change', refreshBlocs);

    loadFilterOptions();
    loadAvancement();
    loadRows();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
