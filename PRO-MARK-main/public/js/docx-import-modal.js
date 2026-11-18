(function () {
  'use strict';

  function createModal() {
    if (document.getElementById('docxImportModal')) return;

    const modal = document.createElement('div');
    modal.id = 'docxImportModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card" style="width: min(940px, 96vw); max-height: 92vh; border-radius: 18px; padding: 24px; box-shadow: 0 25px 80px rgba(0,0,0,0.4);">
        <button type="button" class="modal-close" id="docxCloseModal">&times;</button>
        
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
          <div style="width: 44px; height: 44px; border-radius: 12px; background: #17365D; color: #fff; display: grid; place-items: center; font-size: 22px;">📄</div>
          <div>
            <h2 style="margin: 0; font-size: 1.35rem; color: #17365D;">Word Document (.docx) Class Importer</h2>
            <p class="muted small" style="margin: 2px 0 0;">Upload a Word table with embedded passport photos for instant class enrollment.</p>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0; background: #f8fafc; padding: 14px; border-radius: 12px; border: 1px solid #e2e8f0;">
          <label style="font-weight: 700; font-size: 0.82rem; color: #334155;">
            Target Academic Year
            <select id="docxYear" style="width: 100%; margin-top: 5px; padding: 8px; border-radius: 8px; border: 1px solid #cbd5e1;"></select>
          </label>
          <label style="font-weight: 700; font-size: 0.82rem; color: #334155;">
            Target Class
            <select id="docxClass" style="width: 100%; margin-top: 5px; padding: 8px; border-radius: 8px; border: 1px solid #cbd5e1;"></select>
          </label>
          <div style="display: flex; flex-direction: column; justify-content: center;">
            <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 800;">Curriculum Mode</span>
            <div id="docxCurriculumBadge" style="margin-top: 4px; display: inline-flex; align-items: center; font-size: 0.82rem; font-weight: 800; color: #047857; background: #d1fae5; padding: 4px 10px; border-radius: 999px;">
              🌱 Junior School (JSS): Exploratory
            </div>
          </div>
        </div>

        <div id="docxDropzone" style="border: 2px dashed #94a3b8; border-radius: 14px; padding: 26px 18px; text-align: center; cursor: pointer; background: #fafbfc; transition: border-color 0.2s, background 0.2s;">
          <input type="file" id="docxFileInput" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="display: none;">
          <div style="font-size: 32px; margin-bottom: 6px;">📥</div>
          <b style="color: #17365D; font-size: 1rem;">Click to upload or drag & drop Word document (.docx)</b>
          <p class="muted small" style="margin: 4px 0 0;">Accepts Microsoft Word tables containing passport photos, full names, Adm/Ass numbers & parent contacts.</p>
        </div>

        <div id="docxStatusMessage" style="margin-top: 10px; font-size: 0.88rem; display: none;" class="status"></div>

        <div id="docxPreviewArea" style="display: none; margin-top: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="display: flex; gap: 10px; align-items: center;">
              <span class="pill" id="docxCountBadge" style="background: #17365D; color: #fff;">0 Learners</span>
              <span class="pill" id="docxPhotosBadge" style="background: #047857; color: #fff;">0 Photos Matched</span>
              <span class="pill" id="docxDupBadge" style="background: #e2e8f0; color: #334155; display: none;">0 Duplicates</span>
            </div>
          </div>

          <div style="max-height: 280px; overflow-y: auto; border: 1px solid #cbd5e1; border-radius: 10px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">
              <thead style="background: #f1f5f9; position: sticky; top: 0; z-index: 2;">
                <tr>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Photo</th>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Learner Name</th>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Adm / Ass No.</th>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">DOB / Gender</th>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">CBC Pathway</th>
                  <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Parent Contact</th>
                </tr>
              </thead>
              <tbody id="docxPreviewRows"></tbody>
            </table>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding-top: 14px; border-top: 1px solid #e2e8f0;">
          <button type="button" class="btn secondary" id="docxCancelBtn">Cancel</button>
          <div style="display: flex; gap: 10px;">
            <button type="button" class="btn primary" id="docxCommitBtn" disabled style="background: #047857; border-color: #047857;">Confirm & Enrol Class</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => {
      modal.classList.remove('open');
      reset();
    };
    document.getElementById('docxCloseModal').onclick = close;
    document.getElementById('docxCancelBtn').onclick = close;

    let selectedFile = null;
    const dropzone = document.getElementById('docxDropzone');
    const fileInput = document.getElementById('docxFileInput');

    dropzone.onclick = () => fileInput.click();
    dropzone.ondragover = e => {
      e.preventDefault();
      dropzone.style.background = '#eff6ff';
      dropzone.style.borderColor = '#17365D';
    };
    dropzone.ondragleave = () => {
      dropzone.style.background = '#fafbfc';
      dropzone.style.borderColor = '#94a3b8';
    };
    dropzone.ondrop = e => {
      e.preventDefault();
      dropzone.style.background = '#fafbfc';
      dropzone.style.borderColor = '#94a3b8';
      if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
    };
    fileInput.onchange = () => {
      if (fileInput.files?.length) handleFile(fileInput.files[0]);
    };

    function reset() {
      selectedFile = null;
      fileInput.value = '';
      document.getElementById('docxPreviewArea').style.display = 'none';
      document.getElementById('docxStatusMessage').style.display = 'none';
      document.getElementById('docxCommitBtn').disabled = true;
      document.getElementById('docxCommitBtn').textContent = 'Confirm & Enrol Class';
    }

    async function handleFile(file) {
      if (!file.name.toLowerCase().endsWith('.docx')) {
        alert('Please upload a Microsoft Word document (.docx)');
        return;
      }
      selectedFile = file;

      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const schoolId = user.school_id || new URLSearchParams(location.search).get('school_id');
      const token = localStorage.getItem('token');
      const classId = document.getElementById('docxClass').value;

      const status = document.getElementById('docxStatusMessage');
      status.style.display = 'block';
      status.className = 'status';
      status.textContent = 'Scanning Word document and extracting passport photos…';

      const formData = new FormData();
      formData.append('file', file);
      formData.append('class_id', classId);

      try {
        const response = await fetch(`/api/docx-import/${schoolId}/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to parse Word document.');

        status.style.display = 'none';
        renderPreview(result);
      } catch (err) {
        status.style.display = 'block';
        status.className = 'status';
        status.style.color = '#b91c1c';
        status.textContent = `Upload error: ${err.message}`;
      }
    }

    function renderPreview(data) {
      const area = document.getElementById('docxPreviewArea');
      area.style.display = 'block';

      document.getElementById('docxCountBadge').textContent = `${data.total_found} Learners`;
      document.getElementById('docxPhotosBadge').textContent = `${data.photos_matched} Photos Matched`;

      const dupBadge = document.getElementById('docxDupBadge');
      if (data.duplicates_count > 0) {
        dupBadge.style.display = 'inline-flex';
        dupBadge.style.background = '#fef2f2';
        dupBadge.style.color = '#991b1b';
        dupBadge.textContent = `${data.duplicates_count} Existing / Duplicates`;
      } else {
        dupBadge.style.display = 'none';
      }

      const tbody = document.getElementById('docxPreviewRows');
      tbody.innerHTML = data.learners.map((l, i) => `
        <tr style="border-bottom: 1px solid #e2e8f0; ${l.is_duplicate ? 'background: #fff1f2;' : (i % 2 === 0 ? 'background: #ffffff;' : 'background: #f8fafc;')}">
          <td style="padding: 6px 8px;">
            ${l.photo_thumbnail 
              ? `<img src="${l.photo_thumbnail}" alt="Passport" style="width: 36px; height: 36px; object-fit: cover; border-radius: 6px; border: 1px solid #cbd5e1;">`
              : `<div style="width: 36px; height: 36px; border-radius: 6px; background: #e2e8f0; display: grid; place-items: center; font-size: 14px; color: #64748b;">👤</div>`
            }
          </td>
          <td style="padding: 6px 8px; font-weight: 700; color: #1e293b;">
            ${escapeHtml(l.first_name)} ${escapeHtml(l.middle_name || '')} ${escapeHtml(l.last_name)}
            ${l.is_duplicate ? `<div style="font-size: 10px; color: #b91c1c;">⚠️ ${escapeHtml(l.duplicate_reason || 'Duplicate')}</div>` : ''}
          </td>
          <td style="padding: 6px 8px; font-family: monospace;">
            <b>${escapeHtml(l.admission_no)}</b>
            ${l.assessment_no ? `<div class="muted small">${escapeHtml(l.assessment_no)}</div>` : ''}
          </td>
          <td style="padding: 6px 8px;">
            ${escapeHtml(l.date_of_birth || '—')} · ${escapeHtml(l.gender || '—')}
          </td>
          <td style="padding: 6px 8px;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 800; ${l.cbc_pathway === 'STEM' ? 'background: #dbeafe; color: #1e40af;' : (l.cbc_pathway === 'SOCIAL_SCIENCES' ? 'background: #fef3c7; color: #92400e;' : (l.cbc_pathway === 'ARTS_SPORTS' ? 'background: #f3e8ff; color: #6b21a8;' : 'background: #e2e8f0; color: #334155;'))}">
              ${escapeHtml(l.cbc_pathway)}
            </span>
          </td>
          <td style="padding: 6px 8px;">
            ${escapeHtml(l.parent_name || '')}
            <div style="font-family: monospace; font-size: 11px; color: #475569;">${escapeHtml(l.parent_phone || 'No phone')}</div>
          </td>
        </tr>
      `).join('');

      const commitBtn = document.getElementById('docxCommitBtn');
      commitBtn.disabled = data.total_found === 0;
      commitBtn.textContent = `Confirm & Enrol ${data.total_found} Learners`;

      commitBtn.onclick = async () => {
        if (!selectedFile) return;
        commitBtn.disabled = true;
        commitBtn.textContent = 'Enrolling learners & saving photos…';

        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const schoolId = user.school_id || new URLSearchParams(location.search).get('school_id');
        const token = localStorage.getItem('token');
        const classId = document.getElementById('docxClass').value;
        const yearId = document.getElementById('docxYear').value;

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('class_id', classId);
        formData.append('academic_year_id', yearId);

        try {
          const res = await fetch(`/api/docx-import/${schoolId}/commit`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Enrollment failed.');

          alert(json.message || `Enrolled ${json.enrolled_count} learners successfully!`);
          modal.classList.remove('open');
          reset();

          if (typeof window.load === 'function') window.load();
        } catch (err) {
          alert(`Enrollment error: ${err.message}`);
          commitBtn.disabled = false;
          commitBtn.textContent = `Retry Enrollment`;
        }
      };
    }

    function escapeHtml(str) {
      return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
  }

  function syncClassOptions() {
    const classSel = document.getElementById('docxClass');
    const yearSel = document.getElementById('docxYear');
    if (!classSel || !yearSel) return;

    const stateYears = (window.state && window.state.years) || [];
    const stateClasses = (window.state && window.state.classes) || [];

    if (stateYears.length && !yearSel.options.length) {
      yearSel.innerHTML = stateYears.map(y => `<option value="${y.id}">${y.year_label}</option>`).join('');
    }
    if (stateClasses.length && !classSel.options.length) {
      classSel.innerHTML = stateClasses.map(c => `<option value="${c.id}" data-level="${c.level_name || ''}">${c.name} ${c.stream || ''} · ${c.level_name || ''}</option>`).join('');
    }

    const badge = document.getElementById('docxCurriculumBadge');
    const updateBadge = () => {
      const selected = classSel.selectedOptions[0];
      const level = String(selected?.dataset?.level || selected?.textContent || '').toUpperCase();
      const isSenior = /SENIOR|GRADE_10|GRADE_11|GRADE_12|FORM_3|FORM_4|10|11|12/.test(level);
      if (badge) {
        if (isSenior) {
          badge.textContent = '🎓 Senior School: CBC Pathways (STEM / Social / Arts)';
          badge.style.background = '#e0e7ff';
          badge.style.color = '#3730a3';
        } else {
          badge.textContent = '🌱 Junior School (JSS): Exploratory / Broad';
          badge.style.background = '#d1fae5';
          badge.style.color = '#047857';
        }
      }
    };

    classSel.onchange = updateBadge;
    updateBadge();
  }

  function injectImportButtons() {
    const lForm = document.getElementById('learnerForm');
    if (lForm && !document.getElementById('btnDocxImportLearnerForm')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btnDocxImportLearnerForm';
      btn.className = 'btn secondary';
      btn.style.cssText = 'margin-bottom: 12px; font-weight: 800; background: #e0f2fe; color: #0369a1; border-color: #bae6fd;';
      btn.innerHTML = '📄 Import Class from Word (.docx) with Photos';
      btn.onclick = () => {
        createModal();
        syncClassOptions();
        document.getElementById('docxImportModal')?.classList.add('open');
      };
      lForm.parentNode.insertBefore(btn, lForm);
    }

    const admHost = document.getElementById('zelimuAdmissionsFormHostV2');
    if (admHost && !document.getElementById('btnDocxImportAdmissions')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btnDocxImportAdmissions';
      btn.className = 'btn secondary';
      btn.style.cssText = 'margin: 10px 0; font-weight: 800; background: #e0f2fe; color: #0369a1; border-color: #bae6fd;';
      btn.innerHTML = '📄 Import Class Register (.docx)';
      btn.onclick = () => {
        createModal();
        syncClassOptions();
        document.getElementById('docxImportModal')?.classList.add('open');
      };
      admHost.parentNode.insertBefore(btn, admHost);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createModal();
      injectImportButtons();
    });
  } else {
    createModal();
    injectImportButtons();
  }

  window.zelimuOpenDocxImport = function(classId) {
    createModal();
    syncClassOptions();
    if (classId) {
      const sel = document.getElementById('docxClass');
      if (sel) sel.value = String(classId);
    }
    document.getElementById('docxImportModal')?.classList.add('open');
  };

  window.addEventListener('load', () => {
    injectImportButtons();
    syncClassOptions();
  });
})();
