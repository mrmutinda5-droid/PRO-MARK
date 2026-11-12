/* ZELIMU Results Command Centre — one screen for marks, merit and analytics */
(function () {
  'use strict';

  var root = document.getElementById('resultsCentre');
  if (!root) return;

  var token = localStorage.getItem('token');
  var user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}') || {}; } catch (e) { user = {}; }
  var querySid = new URLSearchParams(location.search).get('school_id');
  var sid = user.school_id || querySid;
  if (!token || !sid) return;

  var state = {
    booted: false,
    tab: 'command',
    options: null,
    cmd: null,
    merit: null,
    analytics: null,
    identity: null,
    busy: false,
    cmdSel: { year: '', term: '', type: '', class: '' },
    meritSel: { year: '', term: '', assessment: '', class: '', pass: 50, strict: false },
    analyticsSel: { year: '', term: '', class: '' },
    status: ''
  };

  var TYPE_LABEL = { '': 'All assessments', OPENER: 'Opener', MID_TERM: 'Mid Term', CAT: 'CATs', END_TERM: 'End Term' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function api(path, opt) {
    opt = opt || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, opt.headers || {});
    var method = String(opt.method || 'GET').toUpperCase();
    if (opt.body && typeof opt.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(opt.body);
    }
    return fetch(path, Object.assign({}, opt, { headers: headers })).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw && raw.trim()) {
          try { data = JSON.parse(raw); } catch (e) { throw new Error('Server returned an invalid response (HTTP ' + res.status + ').'); }
        }
        if (res.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          location.href = '/login.html';
          throw new Error('Session expired. Please sign in again.');
        }
        if (!res.ok) throw new Error((data.error || 'Request failed') + ' [HTTP ' + res.status + ']');
        return data;
      });
    });
  }

  function num(value, digits) {
    if (value == null || value === '' || !isFinite(Number(value))) return '—';
    var n = Number(value);
    return n.toFixed(digits == null ? 1 : digits).replace(/\.0+$/, '');
  }

  function pct(value) {
    if (value == null || !isFinite(Number(value))) return '—';
    return Math.round(Number(value)) + '%';
  }

  function ago(value) {
    if (!value) return 'No marks yet';
    var then = new Date(value).getTime();
    if (!isFinite(then)) return '—';
    var diff = Math.max(0, Date.now() - then);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(value).toLocaleDateString();
  }

  function badge(stateValue, text) {
    var key = String(stateValue || '').toLowerCase();
    if (key !== 'current' && key !== 'historical' && key !== 'upcoming') key = 'historical';
    return '<span class="zrc-badge ' + key + '">' + esc(text || stateValue || '') + '</span>';
  }

  function gradeClass(label) {
    var key = String(label || '').toUpperCase();
    if (key === 'A' || key.indexOf('EE') === 0) return 'gA';
    if (key === 'B' || key.indexOf('ME') === 0) return 'gB';
    if (key === 'C' || key.indexOf('AE') === 0) return 'gC';
    if (key === 'D' || key.indexOf('BE') === 0) return 'gD';
    if (key.indexOf('E') === 0) return 'gE';
    return '';
  }

  var BAND_COLORS = {
    EE1: '#1b5e20', EE2: '#43a047', EE: '#43a047',
    ME1: '#1565c0', ME2: '#38bdf8', ME: '#38bdf8',
    AE1: '#b4690e', AE2: '#c98a1e', AE: '#c98a1e',
    BE1: '#f0923b', BE2: '#e05c5c', BE: '#e05c5c',
    E: '#a51f1f', A: '#1b5e20', B: '#1565c0', C: '#c98a1e', D: '#e05c5c'
  };

  function bandColor(label) {
    return BAND_COLORS[String(label || '').toUpperCase()] || '#8a94a3';
  }

  function tint(hex, alpha) {
    var n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function gradeChip(label, mini) {
    if (!label) return mini ? '' : '<span class="zrc-grade none">—</span>';
    return '<span class="zrc-grade ' + gradeClass(label) + (mini ? ' mini' : '') + '">' + esc(label) + '</span>';
  }

  function bandHeadCells(labels) {
    return (labels || []).map(function (label) {
      return '<th class="num band-col" style="--bc:' + bandColor(label) + '"><span class="band-dot"></span>' + esc(label) + '</th>';
    }).join('');
  }

  function bandCountCells(counts, labels) {
    return (labels || []).map(function (label) {
      var count = counts && counts[label] ? Number(counts[label]) : 0;
      var color = bandColor(label);
      return '<td class="num band-count">' + (count
        ? '<b style="background:' + tint(color, 0.16) + ';color:' + color + '">' + count + '</b>'
        : '<span class="zero">0</span>') + '</td>';
    }).join('');
  }

  function cellClass(percent) {
    if (percent == null) return 's0';
    if (percent >= 95) return 'g4';
    if (percent >= 75) return 'g3';
    if (percent >= 50) return 'g2';
    if (percent >= 25) return 'g1';
    return 'g0';
  }

  function download(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (raw) {
          var msg = 'Download failed';
          try { msg = JSON.parse(raw).error || msg; } catch (e) { /* keep default */ }
          throw new Error(msg + ' [HTTP ' + res.status + ']');
        });
      }
      var name = 'merit-list';
      var disposition = res.headers.get('Content-Disposition') || '';
      var match = /filename="?([^";]+)"?/i.exec(disposition);
      if (match) name = match[1];
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      });
    });
  }

  function qs(obj) {
    return Object.keys(obj).filter(function (key) {
      var value = obj[key];
      return value !== '' && value != null;
    }).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]);
    }).join('&');
  }

  function option(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (String(selected) === String(value) ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  function termOptions(yearId, selected) {
    var year = (state.options.years || []).filter(function (y) { return String(y.id) === String(yearId); })[0];
    var terms = year ? year.terms : [];
    if (!terms.length) return '<option value="">No term configured</option>';
    return terms.map(function (term) {
      return option(term.id, term.name + (term.state === 'CURRENT' ? ' · current' : ''), selected);
    }).join('');
  }

  function classOptions(selected, includeAll) {
    var classes = state.options.classes || [];
    var html = includeAll && state.options.can_see_all !== false ? option('', 'All classes', selected) : '';
    return html + classes.map(function (c) {
      return option(c.id, c.label + (c.learners != null ? ' · ' + c.learners + ' learners' : ''), selected);
    }).join('');
  }

  function shell() {
    root.classList.add('zrc');
    root.innerHTML = [
      '<div class="zrc-head">',
      '  <div>',
      '    <div class="zrc-eyebrow"><span class="zrc-live-dot" aria-hidden="true"></span>ACADEMIC OPERATIONS · LIVE RESULTS PIPELINE</div>',
      '    <h2>Results Command Centre</h2>',
      '    <p>Capture marks, reproduce the exact merit list and read the same analytics — all from one date-aware context. Report cards, merit and publishing use one scoring path.</p>',
      '  </div>',
      '  <div class="zrc-head-actions">',
      '    <button class="zrc-btn ghost" type="button" data-zrc-action="refresh">Refresh data</button>',
      '    <button class="zrc-btn gold" type="button" data-zrc-action="pack">Generate results pack</button>',
      '  </div>',
      '</div>',
      '<div class="zrc-tabs" role="tablist">',
      '  <button class="zrc-tab is-active" type="button" role="tab" data-zrc-tab="command">Results Command Centre</button>',
      '  <button class="zrc-tab" type="button" role="tab" data-zrc-tab="merit">Merit List Reproduction</button>',
      '  <button class="zrc-tab" type="button" role="tab" data-zrc-tab="analytics">Academic Analytics</button>',
      '</div>',
      '<div class="zrc-panel is-active" data-zrc-panel="command"><div class="zrc-loading">Loading the school calendar…</div></div>',
      '<div class="zrc-panel" data-zrc-panel="merit"><div class="zrc-loading">Merit list loads when you open this tab.</div></div>',
      '<div class="zrc-panel" data-zrc-panel="analytics"><div class="zrc-loading">Analytics load when you open this tab.</div></div>'
    ].join('');
  }

  function panel(name) {
    return root.querySelector('[data-zrc-panel="' + name + '"]');
  }

  function loadOptions(extra) {
    return api('/api/results-centre/' + sid + '/options' + (extra ? '?' + qs(extra) : '')).then(function (options) {
      state.options = options;
      var firstClass = (options.classes || [])[0];
      if (options.can_see_all === false && firstClass && !state.cmdSel.class) {
        state.cmdSel.class = String(firstClass.id);
        state.meritSel.class = String(firstClass.id);
        state.analyticsSel.class = String(firstClass.id);
      }
      return options;
    });
  }

  function currentYear() {
    var sel = state.options.years.filter(function (y) { return String(y.id) === String(state.cmdSel.year); })[0];
    return sel || state.options.year;
  }

  function contextBar(scope) {
    var year = (state.options.years || []).filter(function (y) { return String(y.id) === String(scope.year); })[0] || state.options.year;
    var terms = year ? year.terms : [];
    var term = terms.filter(function (t) { return String(t.id) === String(scope.term); })[0] || terms[0];
    if (scope === state.cmdSel) {
      return [
        '<div class="zrc-context">',
        '  <label class="zrc-field"><span>Academic year</span><div class="zrc-select-wrap">',
        '    <select data-zrc-scope="cmd" data-zrc-key="year">' + (state.options.years || []).map(function (y) {
          return option(y.id, y.label, scope.year);
        }).join('') + '</select>',
        badge(year ? year.state : '', year ? year.state : ''),
        '  </div></label>',
        '  <label class="zrc-field"><span>Term</span><div class="zrc-select-wrap">',
        '    <select data-zrc-scope="cmd" data-zrc-key="term">' + termOptions(scope.year, scope.term) + '</select>',
        badge(term ? term.state : '', term ? term.state : ''),
        '  </div></label>',
        '  <div class="zrc-field"><span>Assessment type</span><div class="zrc-seg" role="group" aria-label="Assessment type">',
        ['', 'OPENER', 'MID_TERM', 'CAT', 'END_TERM'].map(function (type) {
          return '<button type="button" data-zrc-type="' + type + '"' + (scope.type === type ? ' class="is-active"' : '') + '>' + TYPE_LABEL[type] + '</button>';
        }).join(''),
        '  </div></div>',
        '  <label class="zrc-field"><span>Class scope</span><select data-zrc-scope="cmd" data-zrc-key="class">' +
          classOptions(scope.class, true) + '</select></label>',
        '</div>'
      ].join('');
    }
    var scopeName = scope === state.meritSel ? 'merit' : 'analytics';
    var html = [
      '<div class="zrc-context">',
      '  <label class="zrc-field"><span>Academic year</span><div class="zrc-select-wrap">',
      '    <select data-zrc-scope="' + scopeName + '" data-zrc-key="year">' + (state.options.years || []).map(function (y) {
        return option(y.id, y.label, scope.year);
      }).join('') + '</select>',
      badge(year ? year.state : '', year ? year.state : ''),
      '  </div></label>',
      '  <label class="zrc-field"><span>Term</span><div class="zrc-select-wrap">',
      '    <select data-zrc-scope="' + scopeName + '" data-zrc-key="term">' + termOptions(scope.year, scope.term) + '</select>',
      badge(term ? term.state : '', term ? term.state : ''),
      '  </div></label>'
    ];
    if (scopeName === 'merit') {
      html.push(
        '  <label class="zrc-field"><span>Assessment reproduction</span><select data-zrc-scope="merit" data-zrc-key="assessment">',
        '<option value="">All exams in the term score</option>',
        '<option value="CAT"' + (scope.assessment === 'CAT' ? ' selected' : '') + '>All CATs grouped</option>',
        (state.options.assessments || []).map(function (a) {
          return option(a.id, a.name + (a.type ? ' · ' + String(a.type).replace(/_/g, ' ') : ''), scope.assessment);
        }).join(''),
        '</select></label>'
      );
      html.push('  <label class="zrc-field"><span>Class</span><select data-zrc-scope="merit" data-zrc-key="class">' + classOptions(scope.class, true) + '</select></label>');
    } else {
      html.push('  <label class="zrc-field"><span>Class scope</span><select data-zrc-scope="analytics" data-zrc-key="class">' + classOptions(scope.class, true) + '</select></label>');
    }
    html.push('</div>');
    return html.join('');
  }

  function kpi(label, value, small, foot, barPercent, tone) {
    var width = Math.max(0, Math.min(100, Number(barPercent) || 0));
    return [
      '<div class="zrc-kpi">',
      '<div class="zrc-kpi-label">' + esc(label) + '</div>',
      '<div class="zrc-kpi-value zrc-num">' + value + (small ? ' <small>' + small + '</small>' : '') + '</div>',
      '<div class="zrc-kpi-foot">' + foot + '</div>',
      '<div class="bar"><i class="' + (tone || '') + '" style="width:' + width + '%"></i></div>',
      '</div>'
    ].join('');
  }

  function renderCommand(data) {
    state.cmd = data;
    var k = data.kpis || {};
    var year = currentYear();
    var html = [contextBar(state.cmdSel)];
    if (year && year.state === 'HISTORICAL') {
      html.push('<div class="zrc-notice warn"><b>Historical academic year.</b> You are viewing ' + esc(year.label) + ', which closed on ' + esc(year.end_date || 'its end date') + '. This is not the current year and nothing here is treated as live.</div>');
    }
    html.push('<div class="zrc-kpis">');
    html.push(kpi('Marks captured', '<span class="zrc-num">' + Number(k.marks_entered || 0).toLocaleString() + '</span>', 'of ' + Number(k.marks_expected || 0).toLocaleString(), pct(k.marks_percent) + ' of expected entries', k.marks_percent, k.marks_percent >= 95 ? 'good' : 'warn'));
    html.push(kpi('Classes complete', '<span class="zrc-num">' + (k.classes_complete || 0) + '</span>', 'of ' + (k.classes_total || 0), 'Classes at 95% or better', k.classes_total ? (k.classes_complete / k.classes_total) * 100 : 0, 'good'));
    html.push(kpi('Report cards ready', '<span class="zrc-num">' + (k.report_cards_ready || 0) + '</span>', 'of ' + (k.learners || 0) + ' learners', k.learners ? pct((k.report_cards_ready / k.learners) * 100) + ' fully scored' : 'No learners in scope', k.learners ? (k.report_cards_ready / k.learners) * 100 : 0));
    html.push(kpi('Last mark captured', esc(ago(k.last_mark_at)), '', k.published ? 'Published ' + ago(k.published_at) : 'Not published yet', k.published ? 100 : 0, k.published ? 'good' : 'warn'));
    html.push('</div>');

    html.push('<div class="zrc-card">');
    html.push('<div class="zrc-card-head"><div><h3>Mark entry completeness</h3><div class="zrc-sub">Class × subject coverage for the selected context. 95% is the readiness threshold.</div></div><div class="zrc-sub">' + esc(data.context.term_name || '') + ' · ' + esc(data.context.year_label || '') + '</div></div>');
    html.push('<div class="zrc-matrix-wrap">');
    if (!data.rows || !data.rows.length) {
      html.push('<div class="zrc-empty">No class or subject configuration is available for this context yet.</div>');
    } else {
      html.push('<table class="zrc-matrix"><thead><tr><th class="zrc-sticky">Class</th><th>Learners</th>');
      (data.subject_columns || []).forEach(function (s) {
        html.push('<th title="' + esc(s.name) + '">' + esc(s.code || s.name) + '</th>');
      });
      html.push('</tr></thead><tbody>');
      data.rows.forEach(function (row) {
        html.push('<tr><td class="zrc-sticky">' + esc(row.class_name) + '</td><td class="zrc-num">' + row.learners + '</td>');
        var byId = {};
        (row.cells || []).forEach(function (c) { byId[String(c.subject_id)] = c; });
        (data.subject_columns || []).forEach(function (s) {
          var cell = byId[String(s.id)];
          if (!cell) {
            html.push('<td><span class="zrc-cell s0">—</span></td>');
          } else {
            html.push('<td><span class="zrc-cell ' + cellClass(cell.percent) + '" title="' + (cell.percent == null ? 'No subject configured' : cell.entered + ' of ' + cell.expected + ' learners scored') + '">' + (cell.percent == null ? '—' : cell.percent + '%') + '</span></td>');
          }
        });
        html.push('</tr>');
      });
      html.push('</tbody></table>');
    }
    html.push('</div>');
    html.push('<div class="zrc-legend"><span><i style="background:#e05c5c"></i>Below 25%</span><span><i style="background:#f0923b"></i>25–49%</span><span><i style="background:#f6c445"></i>50–74%</span><span><i style="background:#8bc34a"></i>75–94%</span><span><i style="background:#43a047"></i>95%+ ready</span><span><i style="background:#f4f6f9"></i>No subject</span></div>');
    html.push('</div>');

    html.push('<div class="zrc-chart-grid">');
    html.push('<div class="zrc-chart-card"><h3>Pending mark entry</h3><div class="zrc-sub">Lowest coverage first — chase these before printing results.</div>');
    if (data.pending && data.pending.length) {
      html.push('<ul class="zrc-pending">');
      data.pending.forEach(function (p) {
        html.push('<li><span><b>' + esc(p.class_name) + '</b> · ' + esc(p.subject_name || p.subject_code) + '</span><span class="pct">' + p.entered + '/' + p.expected + ' · ' + p.percent + '%</span></li>');
      });
      html.push('</ul>');
    } else {
      html.push('<div class="zrc-notice ok">Every configured class and subject is at 95% or better for this context.</div>');
    }
    html.push('</div>');

    html.push('<div class="zrc-chart-card"><h3>Results pipeline</h3><div class="zrc-sub">The same order the school publishes each term.</div><div class="zrc-pipeline">');
    (data.pipeline || []).forEach(function (step, index) {
      html.push('<div class="zrc-step ' + step.status + '"><div class="dot">' + (step.status === 'complete' ? '✓' : index + 1) + '</div><div class="txt"><b>' + esc(step.label) + '</b><span>' + esc(step.detail) + '</span></div></div>');
    });
    html.push('</div><div class="zrc-pack"><div class="zrc-sub">' + (k.merit_ready ? 'Merit is ready to reproduce for this context.' : 'Capture marks to unlock merit and report generation.') + '</div><button class="zrc-btn primary" type="button" data-zrc-action="pack">Generate results pack</button></div></div>');
    html.push('</div>');

    panel('command').innerHTML = html.join('');
  }

  function loadCommand() {
    var scope = state.cmdSel;
    panel('command').innerHTML = '<div class="zrc-loading">Loading command centre…</div>';
    return api('/api/results-centre/' + sid + '/completeness?' + qs({
      academic_year_id: scope.year, term_id: scope.term,
      assessment_type: scope.type, class_id: scope.class
    })).then(renderCommand).catch(function (error) {
      panel('command').innerHTML = contextBar(scope) + '<div class="zrc-notice error">' + esc(error.message) + '</div>';
    });
  }

  function meritTable(data) {
    var subjects = data.subjects || [];
    var multiClass = !data.context.class_id;
    var html = ['<div class="zrc-table-wrap"><table class="zrc-table"><thead><tr>'];
    html.push('<th class="center">#</th><th>Learner</th><th>ADM. NO.</th>');
    if (multiClass) html.push('<th>Class</th>');
    subjects.forEach(function (s) { html.push('<th class="num" title="' + esc(s.subject_name) + '">' + esc(s.subject_code || s.subject_name) + '</th>'); });
    html.push('<th class="num">Total</th><th class="num">Avg</th><th class="center">Grade</th><th class="num">Overall pos.</th></tr></thead><tbody>');
    if (!data.rows || !data.rows.length) {
      html.push('<tr><td colspan="' + (7 + subjects.length + (multiClass ? 1 : 0)) + '" class="zrc-empty">No learners in this scope.</td></tr>');
    }
    (data.rows || []).forEach(function (row, index) {
      var rank = row.stream_rank != null ? row.stream_rank : (row.average == null ? '—' : index + 1);
      var byId = {};
      (row.subjects || []).forEach(function (s) { byId[String(s.subject_id)] = s; });
      html.push('<tr' + (Number(rank) > 0 && Number(rank) <= 3 ? ' class="top"' : '') + '>');
      html.push('<td class="center rank zrc-num">' + esc(rank) + '</td>');
      html.push('<td class="name">' + esc(row.name) + '</td>');
      html.push('<td class="adm">' + esc(row.admission_no || row.assessment_no || '—') + '</td>');
      if (multiClass) html.push('<td>' + esc(row.class_name || '—') + '</td>');
      subjects.forEach(function (s) {
        var found = byId[String(s.subject_id)];
        if (!found || found.average == null) {
          html.push('<td class="num">—</td>');
        } else {
          html.push('<td class="num markcell" title="' + esc((found.subject_name || '') + (found.grade ? ' · ' + found.grade : '')) + '">' + num(found.average, 1) + '<br>' + gradeChip(found.grade, true) + '</td>');
        }
      });
      html.push('<td class="num total">' + num(row.total, 1) + '</td>');
      html.push('<td class="num avg">' + num(row.average, 1) + '</td>');
      html.push('<td class="center"><span class="zrc-grade ' + gradeClass(row.grade) + '">' + esc(row.grade || '—') + '</span></td>');
      html.push('<td class="num">' + (row.overall_rank != null ? row.overall_rank + (row.overall_rank_total ? ' / ' + row.overall_rank_total : '') : '—') + '</td>');
      html.push('</tr>');
    });
    html.push('</tbody>');
    if (data.rows && data.rows.length && subjects.length) {
      html.push('<tfoot><tr><td></td><td class="name">Subject average</td><td></td>');
      if (multiClass) html.push('<td></td>');
      var ranking = {};
      (data.subject_rankings || []).forEach(function (s) { ranking[String(s.subject_id)] = s; });
      subjects.forEach(function (s) {
        var r = ranking[String(s.subject_id)];
        html.push('<td class="num total markcell">' + (r ? num(r.average, 1) + '<br>' + gradeChip(r.grade, true) : '—') + '</td>');
      });
      html.push('<td></td><td></td><td></td><td></td></tr></tfoot>');
    }
    html.push('</table></div>');
    return html.join('');
  }

  function docStrip(context) {
    var id = state.identity || {};
    var ctx = context || {};
    return [
      '<div class="zrc-doc-strip">',
      id.logo_url ? '<img src="' + esc(id.logo_url) + '" alt="School logo">' : '',
      '<div class="zrc-doc-school"><b>' + esc(id.name || 'ZELIMU CBC SCHOOL') + '</b><span>' + esc(id.motto || 'Official merit reproduction') + '</span></div>',
      '<div class="zrc-doc-ref"><span>Official merit document</span><em>' + esc(ctx.year_label || '') + ' · ' + esc(ctx.term_name || '') + ' · ' + esc(ctx.assessment_label || 'Term score') + '</em></div>',
      '</div>'
    ].join('');
  }

  function renderMerit(data) {
    state.merit = data;
    var stats = data.stats || {};
    var rows = data.rows || [];
    if (state.meritSel.strict) {
      rows = rows.filter(function (row) {
        return (row.subjects || []).length > 0 && row.subjects.every(function (s) { return s.average != null; });
      });
    }
    var view = Object.assign({}, data, { rows: rows });
    var html = [docStrip(data.context), contextBar(state.meritSel)];
    if (!rows.length) {
      html.push('<div class="zrc-notice warn">' + esc(data.diagnostics || 'No marks are available for this reproduction.') + '</div>');
    }
    html.push('<div class="zrc-chips">');
    html.push('<div class="zrc-chip"><span>Mean score</span><strong>' + num(stats.mean, 2) + '</strong><em>out of 100</em></div>');
    html.push('<div class="zrc-chip"><span>Mean grade</span><strong>' + esc(stats.mean_grade || '—') + '</strong><em>grading system</em></div>');
    html.push('<div class="zrc-chip"><span>Top score</span><strong>' + num(stats.top, 2) + '</strong><em>highest average</em></div>');
    html.push('<div class="zrc-chip"><span>Lowest score</span><strong>' + num(stats.lowest, 2) + '</strong><em>needs support</em></div>');
    html.push('<div class="zrc-chip"><span>Pass rate</span><strong>' + pct(stats.pass_rate) + '</strong><em>at ' + num(stats.pass_mark, 0) + '% and above</em></div>');
    html.push('<div class="zrc-chip"><span>Ranked learners</span><strong>' + (stats.ranked || 0) + '</strong><em>of ' + (stats.learners || 0) + ' in scope</em></div>');
    html.push('</div>');
    html.push('<div class="zrc-merit-layout"><aside class="zrc-rail">');
    html.push('<h3>Reproduction settings</h3>');
    html.push('<label class="zrc-field"><span>Pass mark (%)</span><input type="number" min="0" max="100" step="1" data-zrc-merit-input="pass" value="' + esc(state.meritSel.pass) + '"></label>');
    html.push('<label class="zrc-check"><input type="checkbox" data-zrc-merit-input="strict" ' + (state.meritSel.strict ? 'checked' : '') + '> Only fully scored learners</label>');
    html.push('<div class="zrc-notice small" style="margin:10px 0 0"><b>' + esc(data.context.assessment_label || 'All assessments') + '</b><br>' + esc(data.context.year_label || '') + ' · ' + esc(data.context.term_name || '') + (data.context.class_name ? ' · ' + esc(data.context.class_name) : ' · all classes') + '</div>');
    html.push('<button class="zrc-btn primary" type="button" data-zrc-action="merit-load">Reproduce merit list</button>');
    html.push('<button class="zrc-btn" type="button" data-zrc-action="merit-pdf">Official PDF</button>');
    html.push('<button class="zrc-btn" type="button" data-zrc-action="merit-csv">Excel / CSV</button>');
    html.push('<button class="zrc-btn" type="button" data-zrc-action="merit-copy">Copy table</button>');
    html.push('<button class="zrc-btn" type="button" data-zrc-action="merit-print">Print</button>');
    html.push('</aside><div class="zrc-merit-main">');
    var toppers = data.subject_toppers || [];
    if (toppers.length) {
      html.push('<div class="zrc-card"><div class="zrc-card-head"><div><h3>Subject toppers</h3><div class="zrc-sub">Best learner per subject in this reproduction — graded with the bands the admin saved.</div></div></div><div class="zrc-toppers">');
      toppers.forEach(function (t, index) {
        html.push('<div class="zrc-topper" style="--tc:' + bandColor(t.grade) + ';animation-delay:' + (index * 60) + 'ms">' +
          '<div class="t-sub">' + esc(t.subject_code || t.subject_name) + '</div>' +
          '<div class="t-name">' + esc(t.name) + '</div>' +
          '<div class="t-meta">' + esc(t.class_name || '—') + '</div>' +
          '<div class="t-score">' + num(t.average, 1) + gradeChip(t.grade, true) + '</div></div>');
      });
      html.push('</div></div>');
    }
    html.push('<div class="zrc-card"><div class="zrc-card-head"><div><h3>Ranked merit register</h3><div class="zrc-sub">' + esc(data.context.assessment_label || 'Term score') + ' · ' + rows.length + ' learner(s) shown · every subject carries its grade</div></div><div class="zrc-sub">' + esc(data.context.year_label || '') + ' · ' + esc(data.context.term_name || '') + '</div></div>' + meritTable(view) + '</div>');
    html.push('</div></div>');
    panel('merit').innerHTML = html.join('');
    var status = root.querySelector('[data-zrc-status]');
    if (status) status.textContent = state.status;
  }

  function loadMerit() {
    var scope = state.meritSel;
    panel('merit').innerHTML = '<div class="zrc-loading">Reproducing the merit list…</div>';
    var params = {
      academic_year_id: scope.year, term_id: scope.term, class_id: scope.class,
      pass_mark: scope.pass
    };
    if (scope.assessment) {
      if (scope.assessment === 'CAT') params.assessment_type = 'CAT';
      else params.assessment_id = scope.assessment;
    }
    return api('/api/results-centre/' + sid + '/merit?' + qs(params)).then(renderMerit).catch(function (error) {
      panel('merit').innerHTML = contextBar(scope) + '<div class="zrc-notice error">' + esc(error.message) + '</div>';
    });
  }

  /* ---------- SVG chart primitives ---------- */

  var chartUid = 0;
  function uid(prefix) { chartUid += 1; return prefix + chartUid; }

  function grad(id, from, to, horizontal) {
    return '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="' + (horizontal ? '1' : '0') + '" y2="' + (horizontal ? '0' : '1') + '">' +
      '<stop offset="0" stop-color="' + from + '"></stop><stop offset="1" stop-color="' + to + '"></stop></linearGradient></defs>';
  }

  function svg(width, height, body, label) {
    return '<svg class="zrc-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(label || 'chart') + '" preserveAspectRatio="xMidYMid meet">' + body + '</svg>';
  }

  function barChart(categories, series, label) {
    var W = 1120, H = 300, left = 46, right = 16, top = 26, bottom = 64;
    var plotW = W - left - right, plotH = H - top - bottom;
    var max = 100;
    var groups = Math.max(categories.length, 1);
    var groupW = plotW / groups;
    var barW = Math.min(56, (groupW * 0.62) / Math.max(series.length, 1));
    var gid = uid('zrcBarGrad');
    var body = [grad(gid, '#2e5f96', '#12294a', false)];
    for (var g = 0; g <= 4; g++) {
      var y = top + (plotH * g) / 4;
      var value = Math.round(max - (max * g) / 4);
      body.push('<line class="zrc-grid-line" x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (W - right) + '" y2="' + y.toFixed(1) + '"></line>');
      body.push('<text class="zrc-axis-label" x="' + (left - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + value + '</text>');
    }
    categories.forEach(function (category, index) {
      var centre = left + groupW * index + groupW / 2;
      var totalBars = series.length * barW;
      series.forEach(function (item, sIndex) {
        var value = item.values[index];
        if (value == null) return;
        var height = Math.max(0, (Number(value) / max) * plotH);
        var x = centre - totalBars / 2 + sIndex * barW;
        var yTop = top + plotH - height;
        body.push('<rect class="zrc-bar v' + (sIndex > 0 ? ' prev' : '') + '" style="animation-delay:' + (index * 70 + sIndex * 40) + 'ms" fill="' + (sIndex > 0 ? '#c9d3e2' : 'url(#' + gid + ')') + '" x="' + x.toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + (barW - 3).toFixed(1) + '" height="' + height.toFixed(1) + '" rx="2"><title>' + esc(category + ': ' + num(value, 1)) + '</title></rect>');
        if (sIndex === 0 && height > 0) {
          body.push('<text class="zrc-bar-value" x="' + (x + (barW - 3) / 2).toFixed(1) + '" y="' + (yTop - 4).toFixed(1) + '">' + num(value, 1) + '</text>');
        }
      });
      body.push('<text class="zrc-axis-label" x="' + centre.toFixed(1) + '" y="' + (top + plotH + 16) + '" text-anchor="middle">' + esc(String(category).slice(0, 14)) + '</text>');
    });
    body.push('<line class="zrc-axis" x1="' + left + '" y1="' + (top + plotH) + '" x2="' + (W - right) + '" y2="' + (top + plotH) + '"></line>');
    return '<div class="zrc-chart-scroll">' + svg(W, H, body.join(''), label) + '</div>';
  }

  function lineChart(points, label, secondary) {
    var W = 430, H = 230, left = 34, right = 12, top = 16, bottom = 44;
    var plotW = W - left - right, plotH = H - top - bottom;
    if (!points.length) return '<div class="zrc-empty">No trend data yet.</div>';
    var step = points.length > 1 ? plotW / (points.length - 1) : 0;
    function xy(values) {
      return values.map(function (value, index) {
        var x = left + (points.length > 1 ? step * index : plotW / 2);
        var y = top + plotH - (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * plotH;
        return [x, y];
      });
    }
    var body = [];
    for (var g = 0; g <= 4; g++) {
      var y = top + (plotH * g) / 4;
      body.push('<line class="zrc-grid-line" x1="' + left + '" y1="' + y + '" x2="' + (W - right) + '" y2="' + y + '"></line>');
      body.push('<text class="zrc-axis-label" x="' + (left - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + (100 - g * 25) + '</text>');
    }
    function draw(values, extraClass, dots) {
      var coords = xy(values);
      body.push('<path class="zrc-line ' + (extraClass || '') + '"' + (extraClass === 'main' ? ' pathLength="1"' : '') + ' d="' + coords.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + '"></path>');
      if (dots) coords.forEach(function (p, i) {
        body.push('<circle class="zrc-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2"><title>' + esc(points[i].label + ': ' + num(values[i], 1)) + '</title></circle>');
      });
    }
    var mainVals = points.map(function (p) { return Number(p.mean) || 0; });
    var up = xy(mainVals.map(function (v) { return Math.min(100, v + 5); }));
    var lo = xy(mainVals.map(function (v) { return Math.max(0, v - 5); }));
    body.push('<path class="zrc-band" d="' + up.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + ' ' +
      lo.slice().reverse().map(function (p) { return 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + ' Z"></path>');
    if (secondary && secondary.length === points.length) draw(secondary, 'prev', false);
    draw(mainVals, 'main', true);
    points.forEach(function (p, index) {
      var x = left + (points.length > 1 ? step * index : plotW / 2);
      body.push('<text class="zrc-axis-label" x="' + x.toFixed(1) + '" y="' + (H - bottom + 18) + '" text-anchor="middle">' + esc(String(p.label).slice(0, 12)) + '</text>');
      body.push('<text class="zrc-axis-label" x="' + x.toFixed(1) + '" y="' + (H - bottom + 32) + '" text-anchor="middle" style="font-weight:700;fill:#17365d">' + num(p.mean, 1) + '</text>');
    });
    body.push('<line class="zrc-axis" x1="' + left + '" y1="' + (top + plotH) + '" x2="' + (W - right) + '" y2="' + (top + plotH) + '"></line>');
    return svg(W, H, body.join(''), label);
  }

  var DONUT_COLORS = ['#17365d', '#2e5f96', '#b8860b', '#0f7a52', '#a45a0b', '#a51f1f', '#8a94a3', '#6b4f9e'];

  function donut(items, label, colorFor) {
    function sliceColor(item, index) {
      return colorFor ? colorFor(item.label) : DONUT_COLORS[index % DONUT_COLORS.length];
    }
    var total = items.reduce(function (sum, item) { return sum + Number(item.count || 0); }, 0);
    if (!total) return '<div class="zrc-empty">No graded learners yet.</div>';
    var W = 300, H = 220, cx = 110, cy = 110, r = 78, inner = 48;
    var body = [];
    var angle = -Math.PI / 2;
    items.forEach(function (item, index) {
      var slice = (Number(item.count) / total) * Math.PI * 2;
      var end = angle + slice;
      var large = slice > Math.PI ? 1 : 0;
      var x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      var x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      var x3 = cx + inner * Math.cos(end), y3 = cy + inner * Math.sin(end);
      var x4 = cx + inner * Math.cos(angle), y4 = cy + inner * Math.sin(angle);
      body.push('<path class="zrc-donut-seg" style="animation-delay:' + (index * 90) + 'ms" fill="' + sliceColor(item, index) + '" d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
        ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) +
        ' L' + x3.toFixed(1) + ' ' + y3.toFixed(1) +
        ' A' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + x4.toFixed(1) + ' ' + y4.toFixed(1) + ' Z"><title>' + esc(item.label + ': ' + item.count) + '</title></path>');
      var frac = Number(item.count) / total;
      if (frac >= 0.05) {
        var mid = angle + slice / 2, lr = (r + inner) / 2;
        body.push('<text class="zrc-donut-pct" x="' + (cx + lr * Math.cos(mid)).toFixed(1) + '" y="' + (cy + lr * Math.sin(mid) + 3).toFixed(1) + '">' + Math.round(frac * 100) + '%</text>');
      }
      angle = end;
    });
    body.push('<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" style="font:700 24px Georgia,serif;fill:#0f2745">' + total + '</text>');
    body.push('<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" style="font:600 10px Segoe UI,sans-serif;fill:#7b8695;letter-spacing:.08em">LEARNERS</text>');
    var legend = items.map(function (item, index) {
      return '<span><i style="background:' + sliceColor(item, index) + '"></i>' + esc(item.label) + ' · <b>' + item.count + '</b> (' + Math.round((Number(item.count) / total) * 100) + '%)</span>';
    }).join('');
    return svg(W, H, body.join(''), label) + '<div class="zrc-legend-row">' + legend + '</div>';
  }

  function hbars(items, label) {
    if (!items.length) return '<div class="zrc-empty">No subject data yet.</div>';
    var W = 430, rowH = 26, top = 6, left = 118, right = 40;
    var H = top + items.length * rowH + 6;
    var plotW = W - left - right;
    var gidN = uid('zrcHbN'), gidG = uid('zrcHbG');
    var body = [grad(gidN, '#2e5f96', '#17365d', true), grad(gidG, '#e3b74e', '#b8860b', true)];
    items.forEach(function (item, index) {
      var y = top + index * rowH;
      var width = Math.max(2, (Math.max(0, Math.min(100, Number(item.mean) || 0)) / 100) * plotW);
      var gold = index % 2 === 1;
      body.push('<text class="zrc-axis-label" x="' + (left - 8) + '" y="' + (y + 17) + '" text-anchor="end" style="fill:#354051;font-weight:600">' + esc(String(item.name).slice(0, 18)) + '</text>');
      body.push('<rect x="' + left + '" y="' + (y + 6) + '" width="' + plotW + '" height="14" rx="4" fill="#eef1f6"></rect>');
      body.push('<rect class="zrc-bar h' + (gold ? ' gold' : '') + '" style="animation-delay:' + (index * 70) + 'ms" fill="url(#' + (gold ? gidG : gidN) + ')" x="' + left + '" y="' + (y + 6) + '" width="' + width.toFixed(1) + '" height="14" rx="4"><title>' + esc(item.name + ': ' + num(item.mean, 1)) + '</title></rect>');
      body.push('<text class="zrc-axis-label" x="' + (W - right + 6) + '" y="' + (y + 17) + '" style="font-weight:700;fill:#0f2745">' + num(item.mean, 1) + '</text>');
    });
    return svg(W, H, body.join(''), label);
  }

  function heatColor(value) {
    if (value == null) return '#f4f6f9';
    if (value >= 80) return '#0f7a52';
    if (value >= 70) return '#3f8f63';
    if (value >= 60) return '#b8860b';
    if (value >= 50) return '#c98a1e';
    if (value >= 40) return '#c2622b';
    return '#a83a32';
  }

  function heatmap(rows, cols, values, label) {
    if (!rows.length || !cols.length) return '<div class="zrc-empty">No subject mastery data yet.</div>';
    var W = 1120, left = 150, top = 64, cellH = 34, cellW = Math.max(24, (W - left - 8) / cols.length);
    var H = top + rows.length * cellH + 8;
    var body = [];
    cols.forEach(function (col, index) {
      var x = left + index * cellW + cellW / 2;
      body.push('<text class="zrc-heat col-label" x="' + x.toFixed(1) + '" y="' + (top - 8) + '">' + esc(String(col.name).slice(0, 9)) + '</text>');
    });
    rows.forEach(function (row, rowIndex) {
      var y = top + rowIndex * cellH;
      body.push('<text class="zrc-heat row-label" x="' + (left - 8) + '" y="' + (y + cellH / 2) + '">' + esc(String(row).slice(0, 16)) + '</text>');
      cols.forEach(function (col, colIndex) {
        var value = values[rowIndex] ? values[rowIndex][colIndex] : null;
        body.push('<rect x="' + (left + colIndex * cellW + 1) + '" y="' + (y + 1) + '" width="' + (cellW - 2) + '" height="' + (cellH - 2) + '" rx="3" fill="' + heatColor(value) + '"><title>' + esc(row + ' · ' + col.name + ': ' + (value == null ? 'no data' : num(value, 1))) + '</title></rect>');
        if (value != null) body.push('<text x="' + (left + colIndex * cellW + cellW / 2) + '" y="' + (y + cellH / 2) + '">' + num(value, 0) + '</text>');
      });
    });
    return '<div class="zrc-chart-scroll"><svg class="zrc-chart zrc-heat" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label || 'chart') + '" preserveAspectRatio="xMidYMid meet">' + body.join('') + '</svg></div>';
  }

  function sparkline(values) {
    if (!values || values.length < 2) return '';
    var W = 120, H = 34, pad = 2;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = max - min || 1;
    var points = values.map(function (value, index) {
      return [pad + (index * (W - pad * 2)) / (values.length - 1), H - pad - ((value - min) / span) * (H - pad * 2)];
    });
    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + (W - pad) + ' ' + (H - pad) + ' L' + pad + ' ' + (H - pad) + ' Z';
    return '<svg class="zrc-sparkline" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><path class="area" d="' + area + '"></path><path d="' + line + '"></path></svg>';
  }

  function deltaChip(value, suffix) {
    if (value == null) return '<span class="zrc-delta flat">no prior term</span>';
    var n = Number(value);
    var cls = n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';
    var arrow = n > 0.05 ? '▲' : n < -0.05 ? '▼' : '■';
    return '<span class="zrc-delta ' + cls + '">' + arrow + ' ' + (n > 0 ? '+' : '') + num(n, 1) + (suffix || '') + '</span>';
  }

  function analyticsKpi(label, value, small, foot, sparkValues) {
    return [
      '<div class="zrc-kpi">',
      '<div class="zrc-kpi-label">' + esc(label) + '</div>',
      '<div class="zrc-kpi-value zrc-num">' + value + (small ? ' <small>' + small + '</small>' : '') + '</div>',
      '<div class="zrc-kpi-foot">' + foot + '</div>',
      sparkValues ? sparkline(sparkValues) : '',
      '</div>'
    ].join('');
  }

  function renderAnalytics(data) {
    state.analytics = data;
    var k = data.kpis || {};
    var trend = data.trend || [];
    var spark = trend.map(function (t) { return Number(t.mean) || 0; });
    var labels = data.band_labels || [];
    var html = [contextBar(state.analyticsSel)];
    if (data.context && data.context.year_state === 'HISTORICAL') {
      html.push('<div class="zrc-notice warn"><b>Historical year selected.</b> Charts compare terms inside ' + esc(data.context.year_label) + '. The current year is not substituted.</div>');
    }
    html.push('<div class="zrc-downloads"><div class="zrc-downloads-txt"><b>Official performance analysis</b><span>The same numbers as this screen — subject grades, band counts, the full register and movement — ready for the staffroom file.</span></div><div class="zrc-downloads-actions">' +
      '<button class="zrc-btn primary" type="button" data-zrc-action="analysis-pdf">Analysis PDF</button>' +
      '<button class="zrc-btn gold" type="button" data-zrc-action="analysis-csv">Excel / CSV</button>' +
      '<button class="zrc-btn" type="button" data-zrc-action="analysis-copy">Copy analysis</button>' +
      '</div></div>');
    html.push('<div class="zrc-analytics-kpis">');
    html.push(analyticsKpi('Mean score', num(k.mean, 2), '', deltaChip(k.mean_delta) + ' <span class="zrc-sub">vs ' + esc(data.by_class.series.length > 1 ? data.by_class.series[1].name : 'previous term') + '</span>', spark));
    html.push(analyticsKpi('Mean grade', esc(k.mean_grade || '—'), '', 'Admin-saved grading bands', null));
    html.push(analyticsKpi('Pass rate', pct(k.pass_rate), '', deltaChip(k.pass_delta) + ' <span class="zrc-sub">at ' + num(k.pass_mark, 0) + '%+</span>', null));
    html.push(analyticsKpi('Ranked learners', String(k.learners || 0), '', 'Learners with usable marks', null));
    if (k.mean_points != null) {
      html.push(analyticsKpi('Mean Points (GPA)', num(k.mean_points, 2), '', deltaChip(k.points_delta) + ' <span class="zrc-sub">pts movement</span>', null));
    }
    if (k.quality_pass_rate != null) {
      html.push(analyticsKpi('Quality Pass (ME+EE)', pct(k.quality_pass_rate), '', 'Junior School progression standard', null));
      html.push(analyticsKpi('High Mastery (EE)', pct(k.high_mastery_rate), '', 'Levels 7 & 8 advanced mastery', null));
      html.push(analyticsKpi('Remedial Support', pct(k.remediation_rate), '', 'Levels 1–4 needing clinic intervention', null));
    }
    html.push(analyticsKpi('Deviation (σ)', num(k.deviation, 1), '', 'Spread of averages — lower is tighter', null));
    html.push(analyticsKpi('Value addition', k.value_addition == null ? '—' : (Number(k.value_addition) > 0 ? '+' : '') + num(k.value_addition, 2), '', 'Mean movement vs previous term', null));
    html.push('</div>');

    html.push('<div class="zrc-chart-grid">');
    html.push('<div class="zrc-chart-card wide"><h3>Mean score by class</h3><div class="zrc-sub">Current term against the previous term, on a fixed 0–100 scale.</div>' +
      barChart(data.by_class.categories, data.by_class.series, 'Mean score by class') +
      '<div class="zrc-legend-row">' + data.by_class.series.map(function (s, index) {
        return '<span><i style="background:' + (index ? '#c9d3e2' : '#17365d') + '"></i>' + esc(s.name) + '</span>';
      }).join('') + '</div></div>');

    html.push('<div class="zrc-chart-card"><h3>Grade distribution</h3><div class="zrc-sub">Every graded learner in this context, on the admin-saved bands.</div>' +
      donut(data.grade_distribution || [], 'Grade distribution', bandColor) + '</div>');

    html.push('<div class="zrc-chart-card"><h3>Term mean trend</h3><div class="zrc-sub">Every term in ' + esc(data.context.year_label) + ', computed on the same path.</div>' +
      lineChart(trend, 'Term mean trend') + '</div>');

    html.push('<div class="zrc-chart-card"><h3>Top subjects by mean</h3><div class="zrc-sub">Strongest six subjects in this scope.</div>' +
      hbars((data.subjects || []).slice(0, 6), 'Top subjects') + '</div>');

    html.push('<div class="zrc-chart-card wide"><h3>Subject mastery by class</h3><div class="zrc-sub">Mean score per class and subject — darker red is support needed, green is secure.</div>' +
      heatmap(data.heatmap.rows, data.heatmap.cols, data.heatmap.values, 'Subject mastery by class') +
      '<div class="zrc-heat-scale"><i></i><div class="zrc-heat-ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div></div></div>');

    // Zeraki 1: Stream & Class Comparative League Table
    if ((data.stream_comparison || []).length > 1 || (data.stream_comparison || []).length === 1 && !state.analyticsSel.class) {
      html.push('<div class="zrc-chart-card wide"><h3>Stream &amp; Class Comparative League</h3><div class="zrc-sub">Inter-stream league table comparing mean percentage, GPA points, trajectory deviation and gender split.</div><div class="zrc-table-wrap"><table class="zrc-table"><thead><tr><th class="center">Rank</th><th>Stream / Class</th><th class="num">Enrolled</th><th class="num">Scored</th><th class="num">Mean</th><th class="num">Mean Pts</th><th class="center">Grade</th><th class="num">Δ prev</th><th class="num">Quality (ME+EE)</th><th class="center">Boys vs Girls</th></tr></thead><tbody>');
      data.stream_comparison.forEach(function (s) {
        var bM = s.gender && s.gender.boys && s.gender.boys.mean != null ? num(s.gender.boys.mean, 1) + '%' : '—';
        var gM = s.gender && s.gender.girls && s.gender.girls.mean != null ? num(s.gender.girls.mean, 1) + '%' : '—';
        html.push('<tr><td class="center font-bold"><b>#' + (s.rank || '—') + '</b></td><td class="name"><b>' + esc(s.stream_name) + '</b></td><td class="num">' + (s.enrolled || 0) + '</td><td class="num">' + (s.scored || 0) + '</td><td class="num total">' + num(s.mean, 2) + '%</td><td class="num">' + num(s.mean_points, 2) + '</td><td class="center">' + gradeChip(s.grade) + '</td><td class="num">' + deltaChip(s.delta) + '</td><td class="num"><b>' + pct(s.quality_pass_pct) + '</b></td><td class="center"><span class="zrc-sub">B: ' + bM + ' · G: ' + gM + '</span></td></tr>');
      });
      html.push('</tbody></table></div></div>');
    }

    // Zeraki 2: Gender Disaggregated Performance & Learning Area Gap
    if (data.gender_analysis && data.gender_analysis.summary) {
      var ga = data.gender_analysis;
      var sum = ga.summary;
      html.push('<div class="zrc-chart-card wide"><h3>Gender Disaggregated Performance &amp; Learning Area Gap</h3><div class="zrc-sub">Boys vs Girls parity index across overall performance, GPA, and individual subjects.</div>');
      html.push('<div class="zrc-analytics-kpis" style="margin-bottom:12px">');
      html.push(analyticsKpi('Boys Average', sum.boys.mean != null ? num(sum.boys.mean, 2) + '%' : '—', '', (sum.boys.count || 0) + ' boys · ' + num(sum.boys.mean_points, 2) + ' GPA', null));
      html.push(analyticsKpi('Girls Average', sum.girls.mean != null ? num(sum.girls.mean, 2) + '%' : '—', '', (sum.girls.count || 0) + ' girls · ' + num(sum.girls.mean_points, 2) + ' GPA', null));
      var gapText = sum.gap == null ? '—' : (Number(sum.gap) > 0 ? '+Boys by ' + num(sum.gap, 2) + '%' : (Number(sum.gap) < 0 ? '+Girls by ' + num(Math.abs(sum.gap), 2) + '%' : 'Parity (0.00%)'));
      html.push(analyticsKpi('Gender Gap', gapText, '', 'Deviation between boys and girls', null));
      html.push('</div>');

      if ((ga.subjects || []).length) {
        html.push('<div class="zrc-table-wrap"><table class="zrc-table"><thead><tr><th>Learning Area</th><th class="num">Boys Scored</th><th class="num">Boys Mean</th><th class="num">Girls Scored</th><th class="num">Girls Mean</th><th class="center">Gender Gap</th></tr></thead><tbody>');
        ga.subjects.forEach(function (sub) {
          var bM = sub.boys_mean != null ? num(sub.boys_mean, 1) + '%' : '—';
          var gM = sub.girls_mean != null ? num(sub.girls_mean, 1) + '%' : '—';
          var gDiff = sub.gap == null ? '—' : (Number(sub.gap) > 0 ? '<span style="color:#2563eb;font-weight:700">+Boys ' + num(sub.gap, 1) + '%</span>' : (Number(sub.gap) < 0 ? '<span style="color:#db2777;font-weight:700">+Girls ' + num(Math.abs(sub.gap), 1) + '%</span>' : 'Parity'));
          html.push('<tr><td class="name">' + esc(sub.subject_name) + '</td><td class="num">' + sub.boys_count + '</td><td class="num">' + bM + '</td><td class="num">' + sub.girls_count + '</td><td class="num">' + gM + '</td><td class="center">' + gDiff + '</td></tr>');
        });
        html.push('</tbody></table></div>');
      }
      html.push('</div>');
    }

    // Zeraki 3: Learner Remediation & Intervention Quadrants
    if (data.intervention_quadrants) {
      var iq = data.intervention_quadrants;
      var counts = iq.counts || {};
      html.push('<div class="zrc-chart-card wide"><h3>Academic Intervention &amp; Remediation Command</h3><div class="zrc-sub">Learner segmentation for targeted academic clinics, enrichment, and urgent support.</div>');
      html.push('<div class="zrc-analytics-kpis" style="margin-bottom:14px">');
      html.push(analyticsKpi('High Flyers', String(counts.high_flyers || 0), '', 'Exceeding expectations (EE1/EE2)', null));
      html.push(analyticsKpi('Solid Core', String(counts.solid_core || 0), '', 'Meeting expectations (ME1/ME2)', null));
      html.push(analyticsKpi('Bottleneck Strugglers', String(counts.bottleneck_strugglers || 0), '', 'Passing overall but failing 1–2 subjects', null));
      html.push(analyticsKpi('Urgent Intervention', String(counts.urgent_intervention || 0), '', 'At-risk candidates failing 3+ areas', null));
      html.push('</div>');

      if ((iq.bottleneck_strugglers || []).length) {
        html.push('<details class="zrc-panel" style="margin-bottom:10px;border:1px solid #f59e0b;border-radius:8px;padding:10px"><summary style="cursor:pointer;font-weight:700;color:#b45309">⚠️ Bottleneck Strugglers (' + (counts.bottleneck_strugglers || 0) + ' learners) — Needs Targeted Subject Clinic</summary><div class="zrc-table-wrap" style="margin-top:10px"><table class="zrc-table"><thead><tr><th>Learner</th><th>Class</th><th class="num">Overall Mean</th><th>Bottleneck Learning Area(s)</th></tr></thead><tbody>');
        iq.bottleneck_strugglers.forEach(function (l) {
          var tags = (l.bottlenecks || []).map(function (b) { return '<span class="zrc-chip" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:2px 7px;border-radius:4px;margin-right:4px;font-size:11px">' + esc(b.subject_name) + ' (' + num(b.average, 0) + '%)</span>'; }).join('');
          html.push('<tr><td class="name"><b>' + esc(l.name) + '</b> <span class="zrc-sub">' + esc(l.admission_no || '') + '</span></td><td>' + esc(l.class_name || '—') + '</td><td class="num total">' + num(l.average, 1) + '%</td><td>' + tags + '</td></tr>');
        });
        html.push('</tbody></table></div></details>');
      }

      if ((iq.urgent_intervention || []).length) {
        html.push('<details class="zrc-panel" style="border:1px solid #ef4444;border-radius:8px;padding:10px"><summary style="cursor:pointer;font-weight:700;color:#b91c1c">🚨 Urgent Academic Intervention List (' + (counts.urgent_intervention || 0) + ' learners)</summary><div class="zrc-table-wrap" style="margin-top:10px"><table class="zrc-table"><thead><tr><th>Learner</th><th>Class</th><th class="num">Average</th><th class="center">Grade</th><th>Failing Subject Count</th></tr></thead><tbody>');
        iq.urgent_intervention.forEach(function (l) {
          html.push('<tr><td class="name"><b>' + esc(l.name) + '</b> <span class="zrc-sub">' + esc(l.admission_no || '') + '</span></td><td>' + esc(l.class_name || '—') + '</td><td class="num total" style="color:#dc2626">' + num(l.average, 1) + '%</td><td class="center">' + gradeChip(l.grade) + '</td><td class="center font-bold" style="color:#dc2626">' + (l.failed_subjects_count || (l.failing_subjects || []).length) + ' subject(s) below pass</td></tr>');
        });
        html.push('</tbody></table></div></details>');
      }
      html.push('</div>');
    }

    if ((data.subject_analysis || []).length) {
      html.push('<div class="zrc-chart-card wide"><h3>Subject performance &amp; teacher analysis</h3><div class="zrc-sub">Mean, grade, spread and movement per subject — grades come from the grading system the admin saved for this scope.</div><div class="zrc-table-wrap"><table class="zrc-table"><thead><tr><th>Subject</th><th>Teacher</th><th class="num">Mean</th><th class="center">Grade</th><th class="num">High</th><th class="num">Low</th><th class="num">Pass %</th><th class="num">σ</th><th class="num">Δ prev</th><th class="num">Scored</th></tr></thead><tbody>');
      data.subject_analysis.forEach(function (s) {
        html.push('<tr><td class="name">' + esc(s.subject_name) + '</td><td>' + esc(s.teacher || '—') + '</td><td class="num total">' + num(s.mean, 2) + '</td><td class="center">' + gradeChip(s.grade) + '</td><td class="num">' + num(s.high, 1) + '</td><td class="num">' + num(s.low, 1) + '</td><td class="num">' + num(s.pass, 1) + '%</td><td class="num">' + num(s.dev, 1) + '</td><td class="num">' + deltaChip(s.delta) + '</td><td class="num">' + s.scored + '</td></tr>');
      });
      html.push('</tbody></table></div></div>');
    }

    if ((data.subject_analysis || []).length && labels.length) {
      html.push('<div class="zrc-chart-card wide"><h3>Grade bands per subject</h3><div class="zrc-sub">How many learners landed in each admin-saved band, per subject — the footer repeats the counts on learner averages.</div><div class="zrc-table-wrap"><table class="zrc-table zrc-bands"><thead><tr><th>Subject</th>' + bandHeadCells(labels) + '<th class="num">Scored</th><th class="num">Mean</th><th class="center">Grade</th></tr></thead><tbody>');
      data.subject_analysis.forEach(function (s) {
        html.push('<tr><td class="name">' + esc(s.subject_name) + '</td>' + bandCountCells(s.counts, labels) + '<td class="num">' + s.scored + '</td><td class="num total">' + num(s.mean, 1) + '</td><td class="center">' + gradeChip(s.grade) + '</td></tr>');
      });
      var dist = {};
      (data.grade_distribution || []).forEach(function (d) { dist[d.label] = d.count; });
      html.push('</tbody><tfoot><tr><td class="name">LEARNER AVERAGE</td>' + bandCountCells(dist, labels) + '<td class="num">' + (k.learners || 0) + '</td><td class="num total">' + num(k.mean, 1) + '</td><td class="center">' + gradeChip(k.mean_grade) + '</td></tr></tfoot></table></div></div>');
    }

    if ((data.class_bands || []).length && labels.length) {
      html.push('<div class="zrc-chart-card wide"><h3>Grade bands per class &amp; subject</h3><div class="zrc-sub">Every class broken down by subject, with the class-average row in gold. Scroll inside the sheet — the headers stay put.</div><div class="zrc-vscroll"><table class="zrc-table zrc-bands"><thead><tr><th>Class / Subject</th>' + bandHeadCells(labels) + '<th class="num">Scored</th><th class="num">Mean</th><th class="center">Grade</th></tr></thead><tbody>');
      data.class_bands.forEach(function (c) {
        html.push('<tr class="zrc-classrow"><td colspan="' + (labels.length + 4) + '">' + esc(c.class_name) + '</td></tr>');
        (c.subjects || []).forEach(function (s) {
          html.push('<tr><td class="subj">' + esc(s.subject_name) + '</td>' + bandCountCells(s.counts, labels) + '<td class="num">' + s.scored + '</td><td class="num">' + num(s.mean, 1) + '</td><td class="center">' + gradeChip(s.grade) + '</td></tr>');
        });
        html.push('<tr class="zrc-avgrow"><td class="name">Class average</td>' + bandCountCells(c.average_counts, labels) + '<td class="num">' + c.scored + '</td><td class="num total">' + num(c.mean, 1) + '</td><td class="center">' + gradeChip(c.grade) + '</td></tr>');
      });
      html.push('</tbody></table></div></div>');
    }

    if ((data.teachers || []).length) {
      html.push('<div class="zrc-chart-card"><h3>Teacher performance</h3><div class="zrc-sub">Mean across each teacher’s assigned subjects in this scope.</div>' +
        hbars(data.teachers.slice(0, 8).map(function (t) { return { name: t.teacher, mean: t.mean }; }), 'Teacher performance') + '</div>');
    }

    if ((data.top_performers || []).length) {
      html.push('<div class="zrc-chart-card"><h3>Top performers</h3><div class="zrc-sub">Highest averages in this scope, graded on the same bands.</div><div class="zrc-toplist">');
      data.top_performers.forEach(function (p, index) {
        html.push('<div class="zrc-toprow"><span class="pos">' + (index + 1) + '</span><span class="who"><b>' + esc(p.name) + '</b><em>' + esc(p.class_name || '') + '</em></span><span class="score zrc-num">' + num(p.average, 1) + '</span>' + gradeChip(p.grade) + '</div>');
      });
      html.push('</div></div>');
    }

    if (data.progression && data.progression.length) {
      html.push('<div class="zrc-chart-card"><h3>Assessment-type progression</h3><div class="zrc-sub">How the cohort performed in each assessment form this term.</div>' +
        hbars(data.progression.map(function (p) { return { name: String(p.type || 'Other').replace(/_/g, ' '), mean: p.mean }; }), 'Assessment progression') + '</div>');
    }

    if (data.multi_year && data.multi_year.length > 1) {
      html.push('<div class="zrc-chart-card"><h3>Multi-year mean</h3><div class="zrc-sub">School mean across academic years with recorded marks.</div>' +
        lineChart(data.multi_year.map(function (y) { return { label: y.year_label, mean: y.mean }; }), 'Multi-year mean') + '</div>');
    }

    var movement = data.movement || {};
    html.push('<div class="zrc-chart-card wide"><h3>Movement &amp; support register</h3><div class="zrc-sub">Change against the previous term — support first, then the sharpest declines and the strongest gains.</div><div class="zrc-chips" style="margin:0 0 12px">');
    html.push('<div class="zrc-chip"><span>Improved</span><strong>' + (movement.improved || 0) + '</strong><em>+0.5 or more</em></div>');
    html.push('<div class="zrc-chip"><span>Stable</span><strong>' + (movement.stable || 0) + '</strong><em>within ±0.5</em></div>');
    html.push('<div class="zrc-chip"><span>Declined</span><strong>' + (movement.declined || 0) + '</strong><em>−0.5 or worse</em></div>');
    html.push('</div>');
    if ((data.movement_rows || []).length) {
      html.push('<div class="zrc-table-wrap" style="max-height:360px"><table class="zrc-table"><thead><tr><th>Learner</th><th>Class</th><th class="num">Current</th><th class="num">Previous</th><th class="num">Change</th><th class="center">Grade</th><th class="center">Status</th></tr></thead><tbody>');
      data.movement_rows.forEach(function (row) {
        var status = String(row.status || '').toLowerCase();
        html.push('<tr><td class="name">' + esc(row.name) + '</td><td>' + esc(row.class_name || '—') + '</td><td class="num">' + num(row.average, 1) + '</td><td class="num">' + num(row.previous, 1) + '</td><td class="num">' + deltaChip(row.delta) + '</td><td class="center">' + gradeChip(row.grade) + '</td><td class="center"><span class="zrc-status ' + status + '">' + esc(row.status || '') + '</span></td></tr>');
      });
      html.push('</tbody></table></div>');
    } else {
      html.push('<div class="zrc-notice ok">No movement to report yet — it appears once a previous term has marks to compare against.</div>');
    }
    html.push('</div>');

    html.push('</div>');
    panel('analytics').innerHTML = html.join('');
  }

  function analysisPdfHtml() {
    var a = state.analytics || {};
    var k = a.kpis || {};
    var ctx = a.context || {};
    var id = state.identity || {};
    var labels = a.band_labels || [];
    var subjects = a.subject_columns || [];
    function nCell(value, digits) { return '<td class="n">' + (value == null ? '—' : num(value, digits)) + '</td>'; }
    function bandHead() {
      return labels.map(function (l) { return '<th class="n" style="color:' + bandColor(l) + '">' + esc(l) + '</th>'; }).join('');
    }
    function bandCells(counts) {
      return labels.map(function (l) {
        var count = (counts || {})[l] || 0;
        return '<td class="n" style="color:' + (count ? bandColor(l) : '#9aa4b2') + ';font-weight:' + (count ? 800 : 400) + '">' + count + '</td>';
      }).join('');
    }
    var html = [];
    html.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Official performance analysis — ' + esc(ctx.year_label || '') + ' · ' + esc(ctx.term_name || '') + '</title><style>');
    html.push('*{box-sizing:border-box}body{margin:0;background:#e9edf3;font-family:"Segoe UI",system-ui,Arial,sans-serif;color:#1c2430}');
    html.push('.toolbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;background:#0f2745;color:#fff;padding:12px 20px;border-bottom:3px solid #b8860b}');
    html.push('.toolbar b{font-family:Georgia,serif;font-size:15px}.toolbar span{font-size:12px;color:#c9d5e6;flex:1}');
    html.push('.toolbar button{appearance:none;border:0;border-radius:8px;padding:9px 18px;font-weight:800;font-size:13px;cursor:pointer;background:linear-gradient(180deg,#f0c465,#b8860b);color:#fff;box-shadow:0 2px 10px rgba(184,134,11,.5)}');
    html.push('.sheet{max-width:1080px;margin:18px auto;background:#fff;padding:26px 30px;box-shadow:0 8px 30px rgba(16,35,60,.18);border-top:4px double #b8860b}');
    html.push('header{display:flex;align-items:center;gap:14px;border-bottom:2px solid #17365d;padding-bottom:12px;margin-bottom:14px}');
    html.push('header img{width:52px;height:52px;object-fit:contain}header h1{font-family:Georgia,serif;font-size:21px;margin:0;color:#0f2745}header p{margin:2px 0 0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#b8860b;font-weight:700}');
    html.push('header .ref{margin-left:auto;text-align:right}header .ref b{display:block;font-size:11px;letter-spacing:.14em;color:#17365d}header .ref span{display:block;font-size:11px;color:#66707d;margin-top:3px}');
    html.push('.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:16px}');
    html.push('.summary div{border:1px solid #e3e7ee;border-left:3px solid #b8860b;border-radius:8px;padding:8px 10px;background:#fbfcfd}');
    html.push('.summary span{display:block;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#66707d}.summary b{display:block;font-family:Georgia,serif;font-size:18px;color:#0f2745;margin-top:2px}');
    html.push('h2{font-family:Georgia,serif;font-size:15px;color:#0f2745;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid #e3e7ee}');
    html.push('table{border-collapse:collapse;width:100%;font-size:9.5px;margin-bottom:6px}');
    html.push('th{background:#17365d;color:#ecd6a4;font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;padding:5px 6px;text-align:left;border:1px solid #24466f}');
    html.push('td{padding:4px 6px;border:1px solid #e3e7ee}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}');
    html.push('tbody tr:nth-child(even) td{background:#f7f9fc}.grp td{background:#17365d!important;color:#f0c465;font-weight:800;letter-spacing:.06em}');
    html.push('.avg td{background:#fbf3dd!important;font-weight:800}.grade{font-weight:800}');
    html.push('.status{font-weight:800;font-size:8.5px;letter-spacing:.05em}.status.support{color:#b42318}.status.declining{color:#b4690e}.status.improved{color:#0f7a52}');
    html.push('footer{margin-top:18px;padding-top:10px;border-top:2px solid #17365d;font-size:10px;color:#66707d;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}');
    html.push('@media print{body{background:#fff}.toolbar{display:none}.sheet{margin:0;max-width:none;box-shadow:none;padding:6mm}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}');
    html.push('@page{size:A4;margin:10mm}</style></head><body>');
    html.push('<div class="toolbar"><b>Official performance analysis</b><span>Review the document, then print or save it as PDF.</span><button type="button" onclick="window.print()">Print / Save PDF</button></div>');
    html.push('<div class="sheet">');
    html.push('<header>' + (id.logo_url ? '<img src="' + esc(id.logo_url) + '" alt="School logo">' : '') +
      '<div><h1>' + esc(id.name || 'ZELIMU CBC SCHOOL') + '</h1><p>' + esc(id.motto || 'Official academic analysis') + '</p></div>' +
      '<div class="ref"><b>OFFICIAL PERFORMANCE ANALYSIS</b><span>' + esc(ctx.year_label || '') + ' · ' + esc(ctx.term_name || '') + ' · ' + esc(ctx.class_name || 'All classes') + '</span></div></header>');
    html.push('<div class="summary">' +
      '<div><span>Mean score</span><b>' + num(k.mean, 2) + '</b></div>' +
      '<div><span>Mean grade</span><b>' + esc(k.mean_grade || '—') + '</b></div>' +
      '<div><span>Deviation σ</span><b>' + num(k.deviation, 1) + '</b></div>' +
      '<div><span>Value addition</span><b>' + (k.value_addition == null ? '—' : (Number(k.value_addition) > 0 ? '+' : '') + num(k.value_addition, 2)) + '</b></div>' +
      '<div><span>Pass rate</span><b>' + pct(k.pass_rate) + '</b></div>' +
      '<div><span>Ranked</span><b>' + (k.learners || 0) + '</b></div></div>');

    html.push('<h2>Subject analysis — grades from the admin-saved grading system</h2>');
    html.push('<table><thead><tr><th>Subject</th><th>Teacher</th><th class="n">Mean</th><th>Grade</th><th class="n">High</th><th class="n">Low</th><th class="n">Pass %</th><th class="n">σ</th><th class="n">Δ prev</th>' + bandHead() + '<th class="n">Scored</th></tr></thead><tbody>');
    (a.subject_analysis || []).forEach(function (s) {
      html.push('<tr><td><b>' + esc(s.subject_name) + '</b></td><td>' + esc(s.teacher || '—') + '</td>' + nCell(s.mean, 2) +
        '<td class="grade" style="color:' + bandColor(s.grade) + '">' + esc(s.grade || '—') + '</td>' + nCell(s.high, 1) + nCell(s.low, 1) +
        '<td class="n">' + num(s.pass, 1) + '%</td>' + nCell(s.dev, 1) +
        '<td class="n">' + (s.delta == null ? '—' : (Number(s.delta) > 0 ? '+' : '') + num(s.delta, 2)) + '</td>' + bandCells(s.counts) + nCell(s.scored, 0) + '</tr>');
    });
    html.push('</tbody></table>');

    html.push('<h2>Grade bands per class &amp; subject</h2>');
    html.push('<table><thead><tr><th>Class / Subject</th>' + bandHead() + '<th class="n">Scored</th><th class="n">Mean</th><th>Grade</th></tr></thead><tbody>');
    (a.class_bands || []).forEach(function (c) {
      html.push('<tr class="grp"><td colspan="' + (labels.length + 4) + '">' + esc(c.class_name) + '</td></tr>');
      (c.subjects || []).forEach(function (s) {
        html.push('<tr><td>' + esc(s.subject_name) + '</td>' + bandCells(s.counts) + nCell(s.scored, 0) + nCell(s.mean, 1) +
          '<td class="grade" style="color:' + bandColor(s.grade) + '">' + esc(s.grade || '—') + '</td></tr>');
      });
      html.push('<tr class="avg"><td>Class average</td>' + bandCells(c.average_counts) + nCell(c.scored, 0) + nCell(c.mean, 1) +
        '<td class="grade" style="color:' + bandColor(c.grade) + '">' + esc(c.grade || '—') + '</td></tr>');
    });
    html.push('</tbody></table>');

    html.push('<h2>Learner register — mark and grade for every subject</h2>');
    html.push('<table><thead><tr><th class="n">#</th><th>Learner</th><th>ADM</th><th>Class</th>' +
      subjects.map(function (s) { return '<th class="n">' + esc(s.subject_code || s.subject_name) + '</th><th>Gr</th>'; }).join('') +
      '<th class="n">Average</th><th>Grade</th></tr></thead><tbody>');
    (a.register || []).forEach(function (row, index) {
      var byId = {};
      (row.subjects || []).forEach(function (s) { byId[String(s.subject_id)] = s; });
      html.push('<tr><td class="n">' + (row.stream_rank != null ? row.stream_rank : (row.average == null ? '—' : index + 1)) + '</td><td><b>' + esc(row.name) + '</b></td><td>' + esc(row.admission_no || '—') + '</td><td>' + esc(row.class_name || '—') + '</td>');
      subjects.forEach(function (s) {
        var found = byId[String(s.subject_id)];
        if (found && found.average != null) {
          html.push(nCell(found.average, 1) + '<td class="grade" style="color:' + bandColor(found.grade) + '">' + esc(found.grade || '—') + '</td>');
        } else {
          html.push('<td class="n">—</td><td>—</td>');
        }
      });
      html.push(nCell(row.average, 1) + '<td class="grade" style="color:' + bandColor(row.grade) + '">' + esc(row.grade || '—') + '</td></tr>');
    });
    html.push('</tbody></table>');

    html.push('<h2>Movement &amp; support</h2>');
    html.push('<table><thead><tr><th>Learner</th><th>Class</th><th class="n">Current</th><th class="n">Previous</th><th class="n">Change</th><th>Grade</th><th>Status</th></tr></thead><tbody>');
    (a.movement_rows || []).forEach(function (row) {
      html.push('<tr><td><b>' + esc(row.name) + '</b></td><td>' + esc(row.class_name || '—') + '</td>' + nCell(row.average, 1) + nCell(row.previous, 1) +
        '<td class="n">' + (row.delta == null ? '—' : (Number(row.delta) > 0 ? '+' : '') + num(row.delta, 2)) + '</td>' +
        '<td class="grade" style="color:' + bandColor(row.grade) + '">' + esc(row.grade || '—') + '</td>' +
        '<td class="status ' + String(row.status || '').toLowerCase() + '">' + esc(row.status || '') + '</td></tr>');
    });
    html.push('</tbody></table>');
    html.push('<footer><span>Generated by ZELIMU Results Command Centre · ' + esc(new Date().toLocaleDateString()) + '</span><span>Grading follows the system saved by the school administrator.</span></footer>');
    html.push('</div></body></html>');
    return html.join('');
  }

  function openAnalysisPdf() {
    if (!state.analytics) { toast('Analytics are still loading.', 'warn'); return; }
    var win = window.open('', '_blank');
    if (!win) { toast('Allow pop-ups for this site to open the analysis PDF.', 'error'); return; }
    win.document.open();
    win.document.write(analysisPdfHtml());
    win.document.close();
    toast('Analysis opened in a new tab — print it or save it as PDF.');
  }

  function copyAnalysis() {
    var a = state.analytics;
    if (!a || !(a.subject_analysis || []).length) { toast('Nothing to copy yet.', 'warn'); return; }
    var labels = a.band_labels || [];
    function bandValues(counts) {
      return labels.map(function (l) { return (counts || {})[l] || 0; });
    }
    var lines = [];
    lines.push(['SUBJECT', 'TEACHER', 'MEAN', 'GRADE', 'HIGH', 'LOW', 'PASS %', 'DEVIATION', 'DELTA PREV'].concat(labels, ['SCORED']).join('\t'));
    (a.subject_analysis || []).forEach(function (s) {
      lines.push([s.subject_name, s.teacher || '', s.mean, s.grade || '', s.high, s.low, s.pass, s.dev, s.delta == null ? '' : s.delta].concat(bandValues(s.counts), [s.scored]).join('\t'));
    });
    lines.push('');
    lines.push(['CLASS', 'SUBJECT'].concat(labels, ['SCORED', 'MEAN', 'GRADE']).join('\t'));
    (a.class_bands || []).forEach(function (c) {
      (c.subjects || []).forEach(function (s) {
        lines.push([c.class_name, s.subject_name].concat(bandValues(s.counts), [s.scored, s.mean, s.grade || '']).join('\t'));
      });
      lines.push([c.class_name, 'AVERAGE'].concat(bandValues(c.average_counts), [c.scored, c.mean, c.grade || '']).join('\t'));
    });
    lines.push('');
    lines.push(['LEARNER', 'CLASS', 'CURRENT', 'PREVIOUS', 'CHANGE', 'GRADE', 'STATUS'].join('\t'));
    (a.movement_rows || []).forEach(function (m) {
      lines.push([m.name, m.class_name || '', m.average, m.previous == null ? '' : m.previous, m.delta == null ? '' : m.delta, m.grade || '', m.status || ''].join('\t'));
    });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines.join('\n')).then(function () { toast('Analysis copied — paste it straight into Excel.'); }, function () { toast('Copy failed. Use Excel / CSV instead.', 'error'); });
    } else {
      toast('Copy is not available in this browser. Use Excel / CSV.', 'warn');
    }
  }

  function loadAnalytics() {
    var scope = state.analyticsSel;
    panel('analytics').innerHTML = '<div class="zrc-loading">Building analytics…</div>';
    return api('/api/results-centre/' + sid + '/analytics?' + qs({
      academic_year_id: scope.year, term_id: scope.term, class_id: scope.class
    })).then(renderAnalytics).catch(function (error) {
      panel('analytics').innerHTML = contextBar(scope) + '<div class="zrc-notice error">' + esc(error.message) + '</div>';
    });
  }

  function loadTab(tab) {
    if (tab === 'command') return loadCommand();
    if (tab === 'merit') return loadMerit();
    return loadAnalytics();
  }

  function switchTab(tab) {
    state.tab = tab;
    root.querySelectorAll('[data-zrc-tab]').forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-zrc-tab') === tab);
    });
    root.querySelectorAll('[data-zrc-panel]').forEach(function (target) {
      target.classList.toggle('is-active', target.getAttribute('data-zrc-panel') === tab);
    });
    if (tab === 'command' && !state.cmd) loadCommand();
    if (tab === 'merit' && !state.merit) loadMerit();
    if (tab === 'analytics' && !state.analytics) loadAnalytics();
  }

  function scopeFor(name) {
    return name === 'merit' ? state.meritSel : name === 'analytics' ? state.analyticsSel : state.cmdSel;
  }

  function meritParams() {
    var scope = state.meritSel;
    var params = { academic_year_id: scope.year, term_id: scope.term, class_id: scope.class, pass_mark: scope.pass };
    if (scope.assessment === 'CAT') params.assessment_type = 'CAT';
    else if (scope.assessment) params.assessment_id = scope.assessment;
    return params;
  }

  function toast(message, tone) {
    state.status = message;
    var existing = root.querySelector('[data-zrc-status]');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.setAttribute('data-zrc-status', '');
    el.className = 'zrc-notice ' + (tone || 'ok');
    el.textContent = message;
    el.style.position = 'fixed';
    el.style.right = '22px';
    el.style.bottom = '22px';
    el.style.zIndex = '9999';
    el.style.maxWidth = '360px';
    el.style.boxShadow = '0 8px 24px rgba(16,35,60,.18)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  function onChanged(input) {
    var scopeName = input.getAttribute('data-zrc-scope');
    var key = input.getAttribute('data-zrc-key');
    var scope = scopeFor(scopeName);
    scope[key] = input.value;
    if (key === 'assessment') scope.assessment = input.value;
    if (key === 'year') {
      var year = (state.options.years || []).filter(function (y) { return String(y.id) === String(input.value); })[0];
      var terms = year ? year.terms : [];
      scope.term = terms.filter(function (t) { return t.state === 'CURRENT'; }).map(function (t) { return String(t.id); })[0] ||
        (terms[0] ? String(terms[0].id) : '');
      if (scopeName === 'merit') scope.assessment = '';
    }
    if (scopeName === 'merit' && key === 'term') scope.assessment = '';
    if (scopeName === 'merit') {
      loadOptions({ academic_year_id: scope.year, term_id: scope.term }).then(loadMerit).catch(function (error) { toast(error.message, 'error'); });
      return;
    }
    if (scopeName === 'analytics') { loadAnalytics(); return; }
    loadCommand();
  }

  function bind() {
    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-zrc-action],[data-zrc-tab],[data-zrc-type]');
      if (!button) return;
      var tab = button.getAttribute('data-zrc-tab');
      if (tab) { switchTab(tab); return; }
      var type = button.getAttribute('data-zrc-type');
      if (type !== null) {
        state.cmdSel.type = type;
        loadCommand();
        return;
      }
      var action = button.getAttribute('data-zrc-action');
      if (!action) return;
      if (action === 'refresh') {
        button.disabled = true;
        api('/api/results-centre/' + sid + '/refresh', { method: 'POST' }).then(function () {
          state.merit = null; state.analytics = null;
          return loadOptions({ academic_year_id: state.cmdSel.year, term_id: state.cmdSel.term });
        }).then(function () {
          return loadTab(state.tab);
        }).then(function () {
          toast('Results data refreshed.');
        }).catch(function (error) { toast(error.message, 'error'); }).then(function () { button.disabled = false; });
        return;
      }
      if (action === 'pack' || action === 'merit-pdf') {
        var packParams;
        if (action === 'pack' && state.tab === 'command') {
          packParams = { academic_year_id: state.cmdSel.year, term_id: state.cmdSel.term, class_id: state.cmdSel.class };
          if (state.cmdSel.type) packParams.assessment_type = state.cmdSel.type;
        } else {
          packParams = meritParams();
        }
        toast('Building the official merit PDF…');
        download('/api/results-centre/' + sid + '/merit.pdf?' + qs(packParams)).catch(function (error) { toast(error.message, 'error'); });
        return;
      }
      if (action === 'merit-csv') {
        download('/api/results-centre/' + sid + '/merit.csv?' + qs(meritParams())).catch(function (error) { toast(error.message, 'error'); });
        return;
      }
      if (action === 'merit-load') { loadMerit(); return; }
      if (action === 'merit-print') { window.print(); return; }
      if (action === 'merit-copy') {
        var data = state.merit;
        if (!data || !data.rows || !data.rows.length) { toast('Nothing to copy yet.', 'warn'); return; }
        var subjects = data.subjects || [];
        var lines = [['Rank', 'Learner', 'ADM NO', ...subjects.map(function (s) { return s.subject_name; }), 'Total', 'Average', 'Grade', 'Position'].join('\t')];
        data.rows.forEach(function (row, index) {
          var byId = {};
          (row.subjects || []).forEach(function (s) { byId[String(s.subject_id)] = s; });
          lines.push([
            row.stream_rank != null ? row.stream_rank : index + 1,
            row.name, row.admission_no || '',
            ...subjects.map(function (s) { return byId[String(s.subject_id)] ? byId[String(s.subject_id)].average : ''; }),
            row.total, row.average, row.grade, row.overall_rank || ''
          ].join('\t'));
        });
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(lines.join('\n')).then(function () { toast('Merit table copied to the clipboard.'); }, function () { toast('Copy failed. Use Excel / CSV instead.', 'error'); });
        } else {
          toast('Copy is not available in this browser. Use Excel / CSV.', 'warn');
        }
        return;
      }
      if (action === 'analysis-pdf') { openAnalysisPdf(); return; }
      if (action === 'analysis-copy') { copyAnalysis(); return; }
      if (action === 'analysis-csv') {
        var analyticsScope = state.analyticsSel;
        download('/api/results-centre/' + sid + '/analysis.csv?' + qs({
          academic_year_id: analyticsScope.year, term_id: analyticsScope.term, class_id: analyticsScope.class
        })).catch(function (error) { toast(error.message, 'error'); });
        return;
      }
    });

    root.addEventListener('change', function (event) {
      var target = event.target;
      if (target.matches('[data-zrc-scope]')) { onChanged(target); return; }
      if (target.matches('[data-zrc-merit-input="strict"]')) {
        state.meritSel.strict = target.checked;
        if (state.merit) renderMerit(state.merit);
      }
    });

    root.addEventListener('input', function (event) {
      var target = event.target;
      if (target.matches('[data-zrc-merit-input="pass"]')) {
        state.meritSel.pass = target.value === '' ? 50 : Number(target.value);
      }
    });
  }

  var bootPromise = null;
  function boot() {
    if (bootPromise) return bootPromise;
    state.booted = true;
    shell();
    bind();
    bootPromise = Promise.all([
      loadOptions(),
      api('/api/settings/' + sid + '/identity').then(function (id) { state.identity = id || null; }).catch(function () { state.identity = null; })
    ]).then(function (results) {
      var options = results[0];
      var yearId = String(options.current_year_id || (options.years[0] ? options.years[0].id : ''));
      var termId = String(options.current_term_id || '');
      if (!termId) {
        var year = (options.years || []).filter(function (y) { return String(y.id) === yearId; })[0];
        termId = year && year.terms[0] ? String(year.terms[0].id) : '';
      }
      state.cmdSel.year = yearId;
      state.cmdSel.term = termId;
      state.meritSel.year = yearId;
      state.meritSel.term = termId;
      state.analyticsSel.year = yearId;
      state.analyticsSel.term = termId;
      return loadCommand();
    }).catch(function (error) {
      panel('command').innerHTML = '<div class="zrc-notice error">' + esc(error.message) + '</div>';
    });
    return bootPromise;
  }

  window.ZRC = {
    activate: function () { boot(); },
    open: function (tab) {
      return boot().then(function () {
        if (tab === 'command' || tab === 'merit' || tab === 'analytics') switchTab(tab);
      });
    },
    refresh: function () { return boot().then(function () { state.merit = null; state.analytics = null; return loadTab(state.tab); }); }
  };

  if (root.classList.contains('nav-active')) boot();
})();
