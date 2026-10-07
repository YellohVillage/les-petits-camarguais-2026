const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzone-text');
const fileInput = document.getElementById('file-input');
const submitBtn = document.getElementById('submit-btn');
const form = document.getElementById('import-form');
const statusMessage = document.getElementById('status-message');
const resultsSection = document.getElementById('results');
const errorsBlock = document.getElementById('errors-block');
const errorsList = document.getElementById('errors-list');
const progressBlock = document.getElementById('progress-block');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

function setSelectedFile(file) {
  if (!file) return;
  dropzoneText.textContent = file.name;
  dropzone.classList.add('has-file');
  submitBtn.disabled = false;
}

dropzone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setSelectedFile(fileInput.files[0]);
});

['dragover', 'dragenter'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    setSelectedFile(file);
  }
});

function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.hidden = false;
}

function setProgress(percent, current, total) {
  progressFill.style.width = percent + '%';
  progressLabel.textContent = total ? `${percent}% (${current}/${total})` : `${percent}%`;
}

function renderResult(data) {
  document.getElementById('stat-total').textContent = data.total_lignes_fichier;
  document.getElementById('stat-delta').textContent = data.lignes_delta_a_importer;
  document.getElementById('stat-repondu').textContent = data.statut_a_repondu;
  document.getElementById('stat-rappeler').textContent = data.statut_a_rappeler;
  document.getElementById('stat-corrections').textContent = data.corrections_email ?? 0;

  if (data.erreurs && data.erreurs.length > 0) {
    errorsList.innerHTML = data.erreurs.map((e) => `<li>${e}</li>`).join('');
    errorsBlock.hidden = false;
  } else {
    errorsBlock.hidden = true;
  }

  resultsSection.hidden = false;
  showStatus(
    `Import terminé : ${data.inserees} nouvelle(s) ligne(s) insérée(s) sur ${data.lignes_delta_a_importer} en delta.`,
    'info'
  );
}

function pollProgress() {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch('/api/import-progress');
        const data = await resp.json();

        if (!data.active) {
          clearInterval(interval);
          reject(new Error("Le suivi de progression a été perdu."));
          return;
        }

        setProgress(data.percent, data.processed, data.total);

        if (data.done) {
          clearInterval(interval);
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data.result);
          }
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 500);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Import en cours...';
  resultsSection.hidden = true;
  statusMessage.hidden = true;
  progressBlock.hidden = false;
  setProgress(0, 0, 0);

  const formData = new FormData();
  formData.append('file', file, file.name);

  try {
    const resp = await fetch('/api/import', { method: 'POST', body: formData });
    const data = await resp.json();

    if (!resp.ok) {
      showStatus(data.error || "Erreur lors de l'import.", 'error');
      return;
    }

    const result = await pollProgress();
    setProgress(100, result.lignes_delta_a_importer, result.lignes_delta_a_importer);
    renderResult(result);
  } catch (err) {
    showStatus('Erreur : ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Importer le fichier';
    progressBlock.hidden = true;
  }
});
