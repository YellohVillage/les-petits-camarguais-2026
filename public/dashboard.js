(function () {
  const config = window.DASHBOARD_CONFIG;
  const pageSize = 50;
  let currentPage = 1;
  let searchTerm = '';
  let searchTimeout = null;
  let rowsById = {};

  const tableBody = document.getElementById('table-body');
  const totalCountEl = document.getElementById('total-count');
  const pageInfoEl = document.getElementById('page-info');
  const prevBtn = document.getElementById('prev-page');
  const nextBtn = document.getElementById('next-page');
  const searchInput = document.getElementById('search-input');
  const loadingEl = document.getElementById('loading-message');
  const emptyEl = document.getElementById('empty-message');

  const modalOverlay = document.getElementById('modal-overlay');
  const modalForm = document.getElementById('modal-form');
  const modalMessage = document.getElementById('modal-message');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSave = document.getElementById('modal-save');

  const fields = {
    langue: document.getElementById('f-langue'),
    situation: document.getElementById('f-situation'),
    je_choisis: document.getElementById('f-je-choisis'),
    je_decide: document.getElementById('f-je-decide'),
    nous_proposons: document.getElementById('f-nous-proposons'),
    nom: document.getElementById('f-nom'),
    prenom: document.getElementById('f-prenom'),
    email: document.getElementById('f-email'),
    num_resa: document.getElementById('f-num-resa'),
    choix: document.getElementById('f-choix'),
    method_remb: document.getElementById('f-method-remb'),
    iban: document.getElementById('f-iban'),
    bic: document.getElementById('f-bic'),
    info_banque: document.getElementById('f-info-banque'),
    statut: document.getElementById('f-statut'),
  };

  // Les questions posées varient d'un camping à l'autre : la pop-in de cette
  // application ne contient que celles des Petits Camarguais. Les autres champs sont
  // simplement absents de la page, et ces deux fonctions s'en accommodent —
  // une colonne absente de l'écran n'est ni remplie, ni renvoyée au serveur,
  // donc jamais écrasée.
  function remplirChamps(row, defauts = {}) {
    Object.entries(fields).forEach(([cle, champ]) => {
      if (!champ) return;
      champ.value = row[cle] || defauts[cle] || '';
    });
  }

  function lireChamps() {
    const payload = {};
    Object.entries(fields).forEach(([cle, champ]) => {
      if (champ) payload[cle] = champ.value;
    });
    return payload;
  }

  let currentEditId = null;

  // Glisser-déposer horizontal sur le tableau : les dashboards ont beaucoup
  // de colonnes qui ne tiennent pas toutes à l'écran. On peut cliquer/toucher
  // n'importe où dans le tableau et glisser pour faire défiler horizontalement,
  // en plus du scroll natif (trackpad, molette + shift, barre de défilement).
  // Générique : réutilisable tel quel par les futures vues dashboard.
  function enableDragScroll(container) {
    if (!container) return;
    let isDown = false;
    let hasDragged = false;
    let startX = 0;
    let startScrollLeft = 0;

    const DRAG_THRESHOLD = 5; // px avant de considérer que c'est un glissé, pas un clic

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

    // Souris
    container.addEventListener('mousedown', (e) => {
      // Ignore les clics sur des éléments interactifs (boutons, liens, champs)
      if (e.target.closest('button, a, input, select, textarea')) return;
      onDown(e.pageX);
    });
    window.addEventListener('mousemove', (e) => onMove(e.pageX, e));
    window.addEventListener('mouseup', onUp);

    // Empêche qu'un glissé déclenche un clic non désiré sur la ligne / bouton
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

    // Tactile (tablette)
    container.addEventListener('touchstart', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      onDown(e.touches[0].pageX);
    }, { passive: true });
    container.addEventListener('touchmove', (e) => onMove(e.touches[0].pageX, e), { passive: true });
    container.addEventListener('touchend', onUp);
  }

  document.querySelectorAll('.table-wrap').forEach(enableDragScroll);

  // -------------------------------------------------------------------------
  // Filtres et export : présents uniquement sur les pages qui déclarent le
  // panneau correspondant. Sur les autres, ce bloc reste inerte.
  // -------------------------------------------------------------------------
  const filtersPanel = document.getElementById('filters-panel');
  const filtersToggle = document.getElementById('filters-toggle');
  const filtersCount = document.getElementById('filters-count');
  const exportBtn = document.getElementById('export-btn');
  const exportMessage = document.getElementById('export-message');
  const aDesFiltres = !!filtersPanel;

  const fl = aDesFiltres ? {
    source: document.getElementById('fl-source'),
    langue: document.getElementById('fl-langue'),
    choix: document.getElementById('fl-choix'),
    situation: document.getElementById('fl-situation'),
    jeDecide: document.getElementById('fl-je-decide'),
    methodRemb: document.getElementById('fl-method-remb'),
    // Absent de l'écran « Match incorrect » : par définition, aucune de ces
    // réponses n'est rattachée à un séjour.
    rattachement: document.getElementById('fl-rattachement'),
  } : {};

  function checkedValues(container) {
    if (!container) return [];
    return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  }

  // -------------------------------------------------------------------------
  // Tri au clic sur l'entête de colonne, identique à celui de la Liste séjours.
  // Le tri est demandé au serveur : la liste étant paginée, trier uniquement
  // les lignes visibles donnerait un classement faux. Trois états au clic :
  // croissant, décroissant, puis retour au classement par défaut.
  // -------------------------------------------------------------------------
  const COLONNES_NUMERIQUES_TRI = new Set(['id']);
  let tri = { colonne: null, sens: 'asc' };

  function libelleTri(colonne, sens) {
    if (COLONNES_NUMERIQUES_TRI.has(colonne)) {
      return sens === 'asc' ? 'du plus petit au plus grand' : 'du plus grand au plus petit';
    }
    return sens === 'asc' ? 'de A à Z' : 'de Z à A';
  }

  function appliquerIndicateursTri() {
    document.querySelectorAll('.data-table thead th[data-sort]').forEach((th) => {
      const colonne = th.dataset.sort;
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
    document.querySelectorAll('.data-table thead th[data-sort]').forEach((th) => {
      th.classList.add('triable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      const basculer = () => {
        const colonne = th.dataset.sort;
        if (tri.colonne !== colonne) tri = { colonne, sens: 'asc' };
        else if (tri.sens === 'asc') tri = { colonne, sens: 'desc' };
        else tri = { colonne: null, sens: 'asc' };
        currentPage = 1;
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

  // Source unique de vérité : la liste et l'export envoient les mêmes filtres.
  function currentFilterParams() {
    const p = new URLSearchParams();
    p.set('statut', config.statut);
    if (searchTerm) p.set('search', searchTerm);
    // Le tri accompagne les filtres : l'export reprend le classement affiché.
    if (tri.colonne) { p.set('tri', tri.colonne); p.set('sens', tri.sens); }
    if (!aDesFiltres) return p;

    const joinIf = (key, values) => { if (values.length) p.set(key, values.join('|')); };
    joinIf('source', checkedValues(fl.source));
    joinIf('langue', checkedValues(fl.langue));
    joinIf('choix', checkedValues(fl.choix));
    joinIf('situation', checkedValues(fl.situation));
    joinIf('je_decide', checkedValues(fl.jeDecide));
    joinIf('method_remb', checkedValues(fl.methodRemb));
    joinIf('rattachement', checkedValues(fl.rattachement));
    return p;
  }

  function activeFilterCount() {
    if (!aDesFiltres) return 0;
    return ['source', 'langue', 'choix', 'situation', 'jeDecide', 'methodRemb', 'rattachement']
      .reduce((n, k) => n + checkedValues(fl[k]).length, 0);
  }

  function refreshFilterBadge() {
    if (!filtersCount) return;
    const n = activeFilterCount();
    filtersCount.textContent = String(n);
    filtersCount.hidden = n === 0;
  }

  // Les libellés de réponses sont très longs : on tronque l'affichage tout en
  // conservant la valeur exacte pour le filtrage et en infobulle.
  function renderChips(container, values, { compteur } = {}) {
    if (!container) return;
    container.innerHTML = '';
    if (!values || values.length === 0) {
      container.classList.add('filter-chips-empty');
      container.textContent = 'Aucune valeur disponible';
      return;
    }
    container.classList.remove('filter-chips-empty');
    values.forEach((v) => {
      const value = typeof v === 'object' ? v.value : String(v);
      const label = typeof v === 'object' ? v.label : String(v);
      const item = document.createElement('label');
      item.className = 'filter-chip';
      item.title = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = value;
      input.addEventListener('change', () => {
        item.classList.toggle('checked', input.checked);
        refreshFilterBadge();
        if (compteur) compteur();
      });
      item.appendChild(input);
      item.appendChild(document.createTextNode(label.length > 60 ? label.slice(0, 60) + '…' : label));
      container.appendChild(item);
    });
  }

  // Bloc repliable : les listes de réponses sont longues.
  function setupCollapse(toggleId, container, countId) {
    const toggle = document.getElementById(toggleId);
    const badge = document.getElementById(countId);
    if (!toggle || !container) return null;
    const refresh = () => {
      if (!badge) return;
      const n = checkedValues(container).length;
      badge.textContent = String(n);
      badge.hidden = n === 0;
    };
    toggle.addEventListener('click', () => {
      const replie = container.hidden;
      container.hidden = !replie;
      toggle.setAttribute('aria-expanded', String(replie));
      toggle.querySelector('.filter-collapse-arrow').textContent = replie ? '▾' : '▸';
    });
    return refresh;
  }

  let refreshChoixCount, refreshSituationCount, refreshJeDecideCount, refreshMethodCount;

  async function loadFilterOptions() {
    if (!aDesFiltres) return;
    try {
      const url = new URL('/api/clients/filter-options', window.location.origin);
      url.searchParams.set('statut', config.statut);
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      renderChips(fl.source, data.source);
      renderChips(fl.langue, data.langue);
      renderChips(fl.choix, data.choix, { compteur: () => refreshChoixCount && refreshChoixCount() });
      renderChips(fl.situation, data.situation, { compteur: () => refreshSituationCount && refreshSituationCount() });
      renderChips(fl.jeDecide, data.je_decide, { compteur: () => refreshJeDecideCount && refreshJeDecideCount() });
      renderChips(fl.methodRemb, data.method_remb, { compteur: () => refreshMethodCount && refreshMethodCount() });
    } catch (err) { /* les filtres restent utilisables */ }
  }

  if (aDesFiltres) {
    // Les chips du rattachement sont écrites dans le HTML, pas rendues depuis
    // les données : elles n'héritent donc pas de l'écouteur de renderChips.
    if (fl.rattachement) {
      fl.rattachement.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener('change', () => {
          input.closest('.filter-chip').classList.toggle('checked', input.checked);
          refreshFilterBadge();
        });
      });
    }

    refreshChoixCount = setupCollapse('fl-choix-toggle', fl.choix, 'fl-choix-count');
    refreshSituationCount = setupCollapse('fl-situation-toggle', fl.situation, 'fl-situation-count');
    refreshJeDecideCount = setupCollapse('fl-je-decide-toggle', fl.jeDecide, 'fl-je-decide-count');
    refreshMethodCount = setupCollapse('fl-method-remb-toggle', fl.methodRemb, 'fl-method-remb-count');

    filtersToggle.addEventListener('click', () => { filtersPanel.hidden = !filtersPanel.hidden; });

    const appliquer = () => {
      currentPage = 1;
      refreshFilterBadge();
      filtersPanel.hidden = true;
      loadPage();
    };
    const reinitialiser = () => {
      Object.values(fl).forEach((container) => {
        if (!container) return;
        container.querySelectorAll('input[type="checkbox"]').forEach((i) => {
          i.checked = false;
          i.closest('.filter-chip').classList.remove('checked');
        });
      });
      // Réinitialiser remet l'écran dans son état d'ouverture, pas dans un état
      // sans aucun filtre : sans cela, le suivi repartirait avec les doublons
      // dedans et les compteurs seraient de nouveau faux.
      const parDefaut = fl.rattachement
        && fl.rattachement.querySelector('input[value="rattachee"]');
      if (parDefaut) {
        parDefaut.checked = true;
        parDefaut.closest('.filter-chip').classList.add('checked');
      }
      [refreshChoixCount, refreshSituationCount, refreshJeDecideCount, refreshMethodCount]
        .forEach((f) => f && f());
      currentPage = 1;
      refreshFilterBadge();
      filtersPanel.hidden = true;
      loadPage();
    };

    document.getElementById('filters-apply').addEventListener('click', appliquer);
    document.getElementById('filters-reset').addEventListener('click', reinitialiser);
    document.getElementById('filters-apply-top').addEventListener('click', appliquer);
    document.getElementById('filters-reset-top').addEventListener('click', reinitialiser);
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      const label = exportBtn.textContent;
      exportBtn.textContent = 'Export en cours...';
      exportMessage.hidden = true;
      try {
        const url = new URL('/api/clients/export', window.location.origin);
        currentFilterParams().forEach((value, key) => url.searchParams.set(key, value));
        const resp = await fetch(url);
        if (!resp.ok) {
          let msg = "Erreur lors de l'export.";
          try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch (e) { /* réponse non JSON */ }
          throw new Error(msg);
        }
        const nb = resp.headers.get('X-Export-Rows');
        const blob = await resp.blob();
        let filename = 'reponses.xlsx';
        const disp = resp.headers.get('Content-Disposition') || '';
        const m = disp.match(/filename="?([^"]+)"?/);
        if (m) filename = m[1];
        const a = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
        exportMessage.textContent = nb ? `Export réussi : ${nb} ligne(s) dans ${filename}.` : `Export réussi : ${filename}.`;
        exportMessage.className = 'export-message success';
        exportMessage.hidden = false;
      } catch (err) {
        exportMessage.textContent = err.message || "Erreur lors de l'export.";
        exportMessage.className = 'export-message error';
        exportMessage.hidden = false;
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = label;
      }
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Le choix exprimé par le client porte un nom différent selon le formulaire :
  // "Que souhaitez-vous faire ?" (décalage) ou "Je choisis" (évacués). Les deux
  // colonnes restent distinctes en base, mais une seule est affichée puisqu'une
  // réponse ne peut jamais renseigner les deux.
  function choixDuClient(row) {
    return row.choix || row.je_choisis || row.nous_proposons || '';
  }

  // id_f1 = formulaire 1 (solidarité), id_f2 = formulaire 2 (décalage).
  function sourceLabel(row) {
    if (row.id_f1 !== null && row.id_f1 !== undefined) return 'Formulaire 1';
    if (row.id_f2 !== null && row.id_f2 !== undefined) return 'Formulaire 2';
    if (row.id_f3 !== null && row.id_f3 !== undefined) return 'Formulaire 3';
    return '–';
  }

  // Numéro de la dernière demande envoyée. Deux clics rapprochés (inverser un
  // tri, enchaîner deux filtres) lancent deux appels : sans ce garde-fou, la
  // réponse la plus lente peut arriver en dernier et afficher un contenu qui ne
  // correspond plus à ce que l'utilisateur a demandé.
  let derniereRequete = 0;

  async function loadPage() {
    const numeroRequete = ++derniereRequete;
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    tableBody.innerHTML = '';
    rowsById = {};

    const url = new URL('/api/clients', window.location.origin);
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
        return;
      }

      for (const row of data.rows) {
        rowsById[row.id] = row;
        const tr = document.createElement('tr');
        // Réponse supplantée : le client a répondu à nouveau, et c'est la
        // réponse suivante qui porte le dossier. On le dit sur la ligne plutôt
        // que de laisser croire à un dossier de plus.
        const supplantee = row.rattachee === false;
        if (supplantee) tr.classList.add('ligne-supplantee');
        const marque = supplantee
          ? ' <span class="badge-supplantee" title="Le client a répondu à nouveau : '
            + 'c\'est sa réponse la plus récente qui porte le dossier. Celle-ci '
            + 'est conservée pour mémoire.">doublon</span>'
          : '';
        tr.innerHTML =
          (config.showIdColumn ? '<td>' + escapeHtml(row.id) + '</td>' : '') +
          '<td>' + escapeHtml(row.nom) + marque + '</td>' +
          '<td>' + escapeHtml(row.prenom) + '</td>' +
          '<td>' + escapeHtml(row.email) + '</td>' +
          '<td>' + escapeHtml(row.num_resa) + '</td>' +
          '<td>' + sourceLabel(row) + '</td>' +
          '<td>' + escapeHtml(row.langue) + '</td>' +
          '<td>' + escapeHtml(choixDuClient(row)) + '</td>' +
          '<td>' + escapeHtml(row.method_remb) + '</td>' +
          '<td>' + escapeHtml(row.iban) + '</td>' +
          '<td>' + escapeHtml(row.bic) + '</td>' +
          '<td>' + escapeHtml(row.info_banque) + '</td>' +
          '<td><button class="btn-toggle" data-id="' + row.id + '">' + escapeHtml(config.toggleLabel) + '</button></td>' +
          (config.showDeleteButton ? '<td><button class="btn-delete" data-id="' + row.id + '">Supprimer la ligne</button></td>' : '');
        tableBody.appendChild(tr);
      }

      tableBody.querySelectorAll('.btn-toggle').forEach((btn) => {
        btn.addEventListener('click', () => openModal(btn.dataset.id));
      });

      tableBody.querySelectorAll('.btn-delete').forEach((btn) => {
        btn.addEventListener('click', () => deleteRow(btn));
      });
    } catch (err) {
      if (numeroRequete !== derniereRequete) return;
      loadingEl.hidden = true;
      emptyEl.textContent = 'Erreur réseau : ' + err.message;
      emptyEl.hidden = false;
    }
  }

  function openModal(id) {
    const row = rowsById[id];
    if (!row) return;

    currentEditId = row.id;
    remplirChamps(row, { statut: config.statut });

    modalMessage.hidden = true;
    modalSave.disabled = false;
    modalSave.textContent = 'Enregistrer';
    modalOverlay.hidden = false;
  }

  function closeModal() {
    modalOverlay.hidden = true;
    currentEditId = null;
  }

  async function deleteRow(btn) {
    const id = btn.dataset.id;
    const row = rowsById[id];
    const label = row ? [row.nom, row.prenom].filter(Boolean).join(' ') || ('dossier #' + id) : ('dossier #' + id);

    if (!window.confirm('Supprimer définitivement la ligne de ' + label + ' ? Cette action est irréversible.')) {
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Suppression...';

    try {
      const resp = await fetch('/api/clients/' + id, { method: 'DELETE' });
      const data = await resp.json();

      if (!resp.ok) {
        alert(data.error || 'Erreur lors de la suppression.');
        btn.disabled = false;
        btn.textContent = 'Supprimer la ligne';
        return;
      }

      loadPage();
    } catch (err) {
      alert('Erreur réseau : ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Supprimer la ligne';
    }
  }

  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentEditId) return;

    modalSave.disabled = true;
    modalSave.textContent = 'Enregistrement...';
    modalMessage.hidden = true;

    const payload = lireChamps();

    try {
      const resp = await fetch('/api/clients/' + currentEditId, {
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

      let msg;
      if (data.match.matched) {
        msg = 'Enregistré. Correspondance trouvée dans master_sejours (' +
          (data.match.via === 'email' ? 'par email' : 'par numéro de réservation') + ')' +
          (data.match.overwroteOtherLink ? ' — un lien précédent vers un autre dossier a été remplacé.' : '.');
        // Le rapprochement détermine aussi la méthode de remboursement : on la
        // restitue tout de suite, c'est l'information utile pour la suite.
        if (data.match.methode) {
          msg += ' Méthode de remboursement : ' + data.match.methode
            + (data.match.methode === 'À vérifier'
              ? ' — la réponse du client ne correspond pas aux paiements du PMS, à contrôler.'
              : '.');
        }
      } else {
        msg = 'Enregistré. Aucune correspondance trouvée dans master_sejours pour ces informations.';
      }
      modalMessage.textContent = msg;
      modalMessage.className = 'modal-message success';
      modalMessage.hidden = false;

      setTimeout(() => {
        closeModal();
        loadPage();
      }, 1400);
    } catch (err) {
      modalMessage.textContent = 'Erreur réseau : ' + err.message;
      modalMessage.className = 'modal-message error';
      modalMessage.hidden = false;
      modalSave.disabled = false;
      modalSave.textContent = 'Enregistrer';
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

  activerTriEntetes();
  // Le badge doit refléter l'état d'ouverture, pas seulement les changements :
  // un filtre coché d'emblée doit s'annoncer, sinon l'utilisateur voit un
  // décompte réduit sans savoir pourquoi.
  refreshFilterBadge();
  loadFilterOptions();
  loadPage();
})();
