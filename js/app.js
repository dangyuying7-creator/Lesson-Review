// ============================================================
// app.js — 主应用逻辑
// 负责：文件上传 / 解析 / UI更新 / 图表渲染 / 报告生成
// ============================================================

// ── 全局状态 ──────────────────────────────────────────────
const State = {
  commentRows:    null,   // 解析后的评论数据行
  attendanceData: null,   // 解析后的出勤数据对象
  analysis:       null,   // 评论分析结果
  scoreData:      null,   // 评分结果
  reportText:     '',     // 最终报告文本
  feedbackCounts:  null,   // 转化反馈各档人数 [n①,n②,n③,n④,n⑤]，null=未填写
  sameTeacher:     null,   // 同主讲转化数据 {same, total}，null=未填写
  charts: {
    attendance:   null,
    comment:      null,
  },
};

// ── Tab 切换：文件上传 / JSON 粘贴 ───────────────────────
function switchCommentTab(tab) {
  const isFile = tab === 'file';
  document.getElementById('commentFilePanel').classList.toggle('hidden', !isFile);
  document.getElementById('commentJsonPanel').classList.toggle('hidden', isFile);

  const tabFile = document.getElementById('tabFile');
  const tabJson = document.getElementById('tabJson');
  if (isFile) {
    tabFile.classList.add('bg-white', 'text-gray-700', 'shadow-sm');
    tabFile.classList.remove('text-gray-500');
    tabJson.classList.remove('bg-white', 'text-gray-700', 'shadow-sm');
    tabJson.classList.add('text-gray-500');
  } else {
    tabJson.classList.add('bg-white', 'text-gray-700', 'shadow-sm');
    tabJson.classList.remove('text-gray-500');
    tabFile.classList.remove('bg-white', 'text-gray-700', 'shadow-sm');
    tabFile.classList.add('text-gray-500');
  }
}

// ── JSON 容错预处理 ────────────────────────────────────────
function sanitizeJsonStr(s) {
  // 全角字符 → 半角
  s = s.replace(/“|”/g, '"');   // " " → "
  s = s.replace(/：/g, ':');           // ： → :
  s = s.replace(/，/g, ',');           // ， → ,

  // 未加引号的 [鼓掌] [好的] 等表情值 → 加引号
  s = s.replace(/:\s*(\[[^\[\]"{}0-9][^\[\]"{}]*\])/g, ': "$1"');

  // 裸 空 → null
  s = s.replace(/:\s*空\s*([,\n\r}])/g, ': null$1');

  // 属性之间缺逗号：  "value"\n   "nextKey": → "value",\n   "nextKey":
  s = s.replace(/"(\s*\n\s*)"([^"\n]+?)":/g, '",\n"$2":');

  // 尾随逗号
  s = s.replace(/,(\s*[}\]])/g, '$1');

  return s;
}

// 从损坏 JSON 中按花括号深度提取对象块
function extractAtDepth(raw, targetDepth) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') { depth++; if (depth === targetDepth) start = i; }
    else if (ch === '}') {
      if (depth === targetDepth && start >= 0) { results.push(raw.slice(start, i + 1)); start = -1; }
      depth--;
    }
  }
  return results;
}

// 从单个对象块里用正则提取字段（兼容中英文键名、有无引号）
function extractFieldFromBlock(block, ...names) {
  for (const name of names) {
    // "name": "value"
    const re1 = new RegExp(`[""]?${name}[""]?\\s*[：:]\\s*[""]([^""\n\\\\]*)[""]`);
    const m1 = re1.exec(block);
    if (m1) return m1[1];
    // "name": unquoted_value (到逗号/换行/}为止)
    const re2 = new RegExp(`[""]?${name}[""]?\\s*[：:]\\s*([^"",\\n\\r}\\]]+)`);
    const m2 = re2.exec(block);
    if (m2) { const v = m2[1].trim(); if (v && v !== 'null') return v; }
  }
  return '';
}

// 提取评论数组（兜底：逐块解析）
function extractItemsFromMalformedJson(raw) {
  for (const depth of [3, 2, 1]) {
    const blocks = extractAtDepth(raw, depth);
    const contentRe = /[""]?(content|内容|msg)[""]?\s*[：:]/i;
    const filtered = blocks.filter(b => contentRe.test(b));
    if (filtered.length > 0) return filtered;
  }
  return [];
}

// 从解析好的对象中提取评论数组（兼容中英文结构键名）
function extractItemArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  // 中文结构：{ "数据": { "价值": [...] } }
  const d = parsed?.['数据'] || parsed?.['data'] || parsed;
  const v = d?.['价值'] || d?.['value'] || d?.['data'] || d?.['list'];
  if (Array.isArray(v)) return v;
  return null;
}

// ── 公共：从 JSON 字符串解析评论条目数组 ─────────────────
// 返回 { items, usedFallback } 或 null（解析失败）
function parseJsonToCommentItems(raw) {
  let items = null;
  let usedFallback = false;

  // 方案一：标准 JSON.parse（先预处理）
  try {
    const parsed = JSON.parse(sanitizeJsonStr(raw));
    items = extractItemArray(parsed);
  } catch (e) { /* 继续走兜底 */ }

  // 方案二：逐块提取（JSON 格式存在语法错误时）
  if (!items || items.length === 0) {
    try {
      const blocks = extractItemsFromMalformedJson(raw);
      if (blocks.length > 0) {
        usedFallback = true;
        items = blocks.map(block => {
          try { return JSON.parse(sanitizeJsonStr(block)); }
          catch (e) {
            return {
              userId:   extractFieldFromBlock(block, 'userId', '用户ID', 'user_id', 'id'),
              nickName: extractFieldFromBlock(block, 'nickName', 'nick', 'name'),
              content:  extractFieldFromBlock(block, 'content', '内容', 'msg', 'text'),
              sendTime: extractFieldFromBlock(block, 'sendTime', '发送时间', 'time', 'createTime'),
            };
          }
        });
      }
    } catch (e2) { /* ignore */ }
  }

  if (!items || items.length === 0) return null;
  return { items, usedFallback };
}

// ── 公共：将解析好的 items 应用到 State 并更新 UI ─────────
function applyCommentItems(items, usedFallback, sourceLabel) {
  const normalized = items.map(row => ({
    userId:  row.userId  || row['用户ID'] || row.user_id || row.id || '',
    time:    row['发送时间'] || row.sendTime || row.time || row.createTime || '',
    content: row.content  || row['内容'] || row['评论内容'] || row.msg || row.text || '',
    nick:    row.nickName || row.nick || row.name || '',
  }));

  const valid = normalized.filter(r => String(r.content).trim().length > 0);
  if (valid.length === 0) {
    showToast('⚠️ 未找到有效评论内容字段（content / 内容 / msg）');
    return false;
  }

  State.commentRows = valid;
  document.getElementById('commentStatus').textContent =
    `✓ 已解析 ${valid.length} 条评论（过滤空行 ${items.length - valid.length} 条）`;
  document.getElementById('commentPreview').classList.remove('hidden');

  const previewRows = valid.slice(0, 10).map(r => ({
    用户: r.nick || r.userId,
    时间: r.time ? r.time.slice(0, 16) : '',
    评论内容: r.content,
  }));
  renderPreviewTable(document.getElementById('commentPreviewTable'), previewRows);

  const label = sourceLabel || 'JSON';
  showToast(usedFallback
    ? `✅ ${label}兼容解析成功：${valid.length} 条评论（已自动修复格式问题）`
    : `✅ ${label}解析成功：${valid.length} 条评论`);
  return true;
}

// ── 解析粘贴的 JSON 评论数据 ──────────────────────────────
function parseCommentJson() {
  const raw = document.getElementById('commentJsonInput').value.trim();
  if (!raw) { showToast('⚠️ 请先粘贴 JSON 数据'); return; }

  const result = parseJsonToCommentItems(raw);
  if (!result) { showToast('❌ JSON 格式有误，无法识别评论数据结构'); return; }
  applyCommentItems(result.items, result.usedFallback, 'JSON ');
}

// ── 工具函数 ──────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function setLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('hidden', !show);
}

function fmt(val, unit = '') {
  if (val === null || val === undefined || val === '' || isNaN(Number(val))) return '—';
  return Number(val).toLocaleString() + unit;
}

// ── 字段名匹配（模糊查找表头列名）────────────────────────
function detectField(headers, candidates) {
  const lh = headers.map(h => String(h).trim().toLowerCase());
  for (const cand of candidates) {
    const idx = lh.indexOf(cand.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  // 包含匹配（容错）
  for (const cand of candidates) {
    const idx = lh.findIndex(h => h.includes(cand.toLowerCase()) || cand.toLowerCase().includes(h));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// ── 解析上传文件（CSV / Excel → JSON数组）────────────────
function parseFile(file, callback) {
  const reader = new FileReader();
  const ext = file.name.split('.').pop().toLowerCase();

  reader.onload = (e) => {
    try {
      let rows = [];
      if (ext === 'csv') {
        const text = e.target.result;
        rows = csvToRows(text);
      } else {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      }
      callback(null, rows);
    } catch (err) {
      callback(err, null);
    }
  };

  if (ext === 'csv') {
    reader.readAsText(file, 'UTF-8');
  } else {
    reader.readAsArrayBuffer(file);
  }
}

function csvToRows(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

// ── 渲染表格预览（前10行）────────────────────────────────
function renderPreviewTable(tableEl, rows) {
  if (!rows || rows.length === 0) {
    tableEl.innerHTML = '<tr><td class="p-2 text-gray-400 text-xs">无数据</td></tr>';
    return;
  }
  const headers = Object.keys(rows[0]);
  const preview = rows.slice(0, 10);
  let html = '<thead><tr>' +
    headers.map(h => `<th>${escHtml(h)}</th>`).join('') +
    '</tr></thead><tbody>';
  preview.forEach(row => {
    html += '<tr>' + headers.map(h => `<td title="${escHtml(String(row[h]))}">${escHtml(String(row[h]).slice(0, 20))}</td>`).join('') + '</tr>';
  });
  html += '</tbody>';
  tableEl.innerHTML = html;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 处理评论文件上传 ─────────────────────────────────────
function handleCommentFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  processCommentFile(file);
}

function processCommentFile(file) {
  // 先用 header:1 模式读原始行数组（每行 = 单元格数组），用于检测 JSON-as-spreadsheet
  const reader = new FileReader();
  const ext = file.name.split('.').pop().toLowerCase();

  reader.onload = (e) => {
    try {
      let rawLines = null;

      if (ext !== 'csv') {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // header:1 → 每行是数组
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        // 检测 JSON-as-spreadsheet：单列 且 第一行是 "{" 或 "["
        const firstCell = String(arr[0]?.[0] || '').trim();
        const isJsonText = arr.every(r => r.length <= 1) &&
                           (firstCell === '{' || firstCell === '[');

        if (isJsonText) {
          // 把所有行的第0列拼成 JSON 字符串
          const jsonText = arr.map(r => String(r[0] || '')).join('\n');
          const result = parseJsonToCommentItems(jsonText);
          if (!result) {
            showToast('❌ 文件内 JSON 格式有误，无法解析评论数据');
          } else {
            document.getElementById('commentUploadHint')?.classList.add('hidden');
            applyCommentItems(result.items, result.usedFallback, '文件 JSON ');
          }
          return;
        }

        // 正常表格模式
        rawLines = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } else {
        const text = e.target.result;
        rawLines = csvToRows(text);
      }

      // ── 正常表格解析 ──
      const rows = rawLines || [];
      if (rows.length === 0) { showToast('❌ 文件内容为空'); return; }

      const headers = Object.keys(rows[0]);
      const fm = CONFIG.FIELD_MAP.comment;
      const contentField = detectField(headers, fm.content);

      if (!contentField) {
        showToast('⚠️ 未找到评论内容字段，请确认表格包含：评论内容、内容、content 等列名');
        return;
      }

      const normalized = rows.map(r => ({
        userId:  r[detectField(headers, fm.userId)] || '',
        time:    r[detectField(headers, fm.time)]   || '',
        content: r[contentField] || '',
        nick:    r[detectField(headers, ['昵称', 'nickName', 'nick', '用户名'])] || '',
      }));

      const valid = normalized.filter(r => String(r.content).trim().length > 0);
      State.commentRows = valid;
      document.getElementById('commentStatus').textContent =
        `✓ 已载入 ${valid.length} 条评论，内容列："${contentField}"`;
      document.getElementById('commentPreview').classList.remove('hidden');
      document.getElementById('commentUploadHint')?.classList.add('hidden');
      renderPreviewTable(document.getElementById('commentPreviewTable'), rows);
      showToast(`✅ 评论数据加载成功：${valid.length} 条`);

    } catch (err) {
      console.error(err);
      showToast('❌ 文件解析失败：' + err.message);
    }
  };

  if (ext === 'csv') {
    reader.readAsText(file, 'UTF-8');
  } else {
    reader.readAsArrayBuffer(file);
  }
}

// ── 处理出勤文件上传 ─────────────────────────────────────
function handleAttendanceFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  parseFile(file, (err, rows) => {
    if (err || !rows || rows.length === 0) {
      showToast('❌ 文件解析失败，请检查格式是否正确');
      return;
    }

    const headers = Object.keys(rows[0]);
    const fm = CONFIG.FIELD_MAP.attendance;

    // 优先尝试行数据（表格第一数据行）
    const row = rows[0];
    const getValue = (candidates) => {
      const f = detectField(headers, candidates);
      return f ? row[f] : '';
    };

    const data = {
      subject:    String(getValue(fm.subject) || '').trim(),
      min5Count:  getValue(fm.min5Count),
      min5Rate:   cleanRate(getValue(fm.min5Rate)),
      min10Count: getValue(fm.min10Count),
      min10Rate:  cleanRate(getValue(fm.min10Rate)),
      min30Count: getValue(fm.min30Count),
      min30Rate:  cleanRate(getValue(fm.min30Rate)),
    };

    // 自动填充顶部基础信息栏
    fillHeaderInfo({
      teacher: getValue(fm.teacher),
      subject: getValue(fm.subject),
      week:    getValue(fm.week),
      grade:   getValue(fm.grade),
    });

    // 回填到手动输入框
    fillManualInputs(data);
    State.attendanceData = data;
    updateRetentionCalcRow();

    document.getElementById('attendanceStatus').textContent =
      `✓ 已识别出勤数据（第一行），请核实下方数值`;
    document.getElementById('attendancePreview').classList.remove('hidden');
    document.getElementById('attendanceUploadHint').classList.add('hidden');
    renderPreviewTable(document.getElementById('attendancePreviewTable'), rows);
    showToast(`✅ 出勤数据加载成功，已自动填入下方表单`);
  });
}

function cleanRate(val) {
  if (!val && val !== 0) return '';
  const s = String(val).replace('%', '').trim();
  const n = parseFloat(s);
  if (isNaN(n)) return '';
  // Excel 百分比单元格原始值为小数（如 0.0093 → 0.93%）
  const pct = (n > 0 && n <= 1) ? n * 100 : n;
  // 截断到两位小数，不四舍五入
  return Math.trunc(pct * 100) / 100;
}

// 格式化转化率：固定两位小数，截断不四舍五入
function fmtRate(val) {
  if (val === null || val === undefined || val === '' || isNaN(Number(val))) return '—';
  const n = Math.trunc(Number(val) * 100) / 100;
  const [int, dec = ''] = n.toString().split('.');
  return int + '.' + dec.padEnd(2, '0').slice(0, 2) + '%';
}

// ── 填充顶部基础信息（由 Excel 读取）────────────────────────
function fillHeaderInfo({ teacher, subject, week, grade }) {
  const map = {
    headerTeacher: teacher,
    headerSubject: subject,
    headerWeek:    week,
    headerGrade:   grade,
  };
  for (const [id, val] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = String(val || '').trim();
    if (v) {
      el.textContent = v;
      el.classList.add('filled');
    }
  }
  // 同步主讲名到"同主讲转化率"卡片
  syncSameTeacherName();
}

function fillManualInputs(data) {
  const map = {
    min5Count:  'min5Count',
    min5Rate:   'min5Rate',
    min10Count: 'min10Count',
    min10Rate:  'min10Rate',
    min30Count: 'min30Count',
    min30Rate:  'min30Rate',
  };
  for (const [key, id] of Object.entries(map)) {
    if (data[key] !== '' && data[key] !== undefined) {
      const el = document.getElementById(id);
      if (el) el.value = data[key];
    }
  }
}

// ── 读取手动输入的出勤数据 ────────────────────────────────
function readManualAttendance() {
  return {
    subject:    (State.attendanceData && State.attendanceData.subject) || '',
    min5Count:  document.getElementById('min5Count').value,
    min5Rate:   document.getElementById('min5Rate').value,
    min10Count: document.getElementById('min10Count').value,
    min10Rate:  document.getElementById('min10Rate').value,
    min30Count: document.getElementById('min30Count').value,
    min30Rate:  document.getElementById('min30Rate').value,
  };
}

// ── 清除数据 ──────────────────────────────────────────────
function clearCommentData() {
  State.commentRows = null;
  document.getElementById('commentPreview').classList.add('hidden');
  document.getElementById('commentUploadHint').classList.remove('hidden');
  document.getElementById('commentFile').value = '';
  showToast('已清除评论数据');
}

function clearAttendanceData() {
  State.attendanceData = null;
  document.getElementById('attendancePreview').classList.add('hidden');
  document.getElementById('attendanceUploadHint').classList.remove('hidden');
  document.getElementById('attendanceFile').value = '';
  showToast('已清除出勤数据');
}

// ── 拖拽上传支持 ──────────────────────────────────────────
function initDragDrop() {
  setupDropZone('commentDropZone', (file) => {
    document.getElementById('commentFile').value = '';
    processCommentFile(file);
  });
  setupDropZone('attendanceDropZone', (file) => {
    const fakeEvent = { target: { files: [file] } };
    handleAttendanceFile(fakeEvent);
  });
}

function setupDropZone(id, onDrop) {
  const zone = document.getElementById(id);
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) onDrop(file);
  });
}

// ── 生成报告（主流程）────────────────────────────────────
function generateReport() {
  const attendance = readManualAttendance();
  const hasAttendance = attendance.min5Rate || attendance.min30Rate;
  const hasComments   = State.commentRows && State.commentRows.length > 0;

  if (!hasAttendance && !hasComments) {
    showToast('⚠️ 请至少上传出勤数据或评论数据后再生成报告', 3000);
    return;
  }

  const btn = document.getElementById('btnGenerate');
  btn.disabled = true;
  document.getElementById('btnText').textContent = '分析中...';
  setLoading(true);

  // 用 setTimeout 让 UI 有机会更新（避免同步阻塞）
  setTimeout(() => {
    try {
      // 1. 分析评论
      const analysis = hasComments
        ? Analyzer.analyzeComments(State.commentRows)
        : Analyzer.analyzeComments([]);

      // 2. 打分（含转化反馈 + 同主讲，可为 null）
      const scoreData = Scorer.calcScore(attendance, analysis, State.feedbackCounts, State.sameTeacher);

      // 3. 生成报告
      const get = (id) => {
        const el = document.getElementById(id);
        const t = el ? el.textContent.trim() : '';
        return t === '—' ? '' : t;
      };
      const teacherInfo = {
        name:    get('headerTeacher'),
        subject: get('headerSubject'),
        week:    get('headerWeek'),
        grade:   get('headerGrade'),
      };
      const reportResult = Report.generateFullReport(teacherInfo, attendance, analysis, scoreData);

      // 保存状态
      State.analysis  = analysis;
      State.scoreData = scoreData;
      State.reportText = reportResult.text;

      // 4. 更新所有 UI
      updateMetricCards(attendance);
      updateAttendanceChart(attendance);
      updateCommentDistribution(analysis);
      updateScorePanel(scoreData);
      updateAnalysisContent(reportResult);
      updateReportOutput(reportResult.text);

      showToast(`✅ 报告生成完成！综合评分 ${scoreData.total} 分（${scoreData.rating.label}）`, 3500);
    } catch (e) {
      console.error(e);
      showToast('❌ 生成报告时出现错误，请检查数据格式', 3000);
    } finally {
      setLoading(false);
      btn.disabled = false;
      document.getElementById('btnText').textContent = '生成评价报告';
    }
  }, 50);
}

// ── 更新：出勤指标卡片（仅 Excel 表格字段）──────────────
function updateMetricCards(a) {
  const count5  = parseFloat(a.min5Count)  || 0;
  const count10 = parseFloat(a.min10Count) || 0;
  const count30 = parseFloat(a.min30Count) || 0;
  const t10 = CONFIG.RETENTION_THRESHOLDS.min10;
  const t30 = CONFIG.RETENTION_THRESHOLDS.min30;
  // 留存率：由人数自动计算
  const ret10 = (count5 > 0 && count10 > 0) ? Math.round(count10 / count5 * 100 * 100) / 100 : null;
  const ret30 = (count10 > 0 && count30 > 0) ? Math.round(count30 / count10 * 100 * 100) / 100 : null;

  function cell(bg, tc, sc, value, label, tip) {
    const tipAttr = tip ? ` class="has-tip" data-tip="${escHtml(tip)}"` : '';
    return `<div${tipAttr} style="background:${bg};border-radius:10px;padding:12px;cursor:default">
      <div style="font-size:18px;font-weight:700;color:${tc}">${value}</div>
      <div style="font-size:11px;color:${sc};margin-top:2px">${label}</div>
    </div>`;
  }

  function retCell(rate, threshold, label, tip) {
    if (rate === null) return cell('#F9FAFB','#9CA3AF','#D1D5DB','—', label, tip);
    const pass  = rate >= threshold;
    const bg    = pass ? '#F0FDF4' : '#FEF2F2';
    const tc    = pass ? '#166534' : '#B91C1C';
    const sc    = pass ? '#86EFAC' : '#FCA5A5';
    const badge = pass
      ? `<span style="font-size:10px;background:#DCFCE7;color:#166534;border-radius:4px;padding:1px 5px;margin-left:4px">合格</span>`
      : `<span style="font-size:10px;background:#FEE2E2;color:#B91C1C;border-radius:4px;padding:1px 5px;margin-left:4px">不合格</span>`;
    const tipAttr = tip ? ` class="has-tip" data-tip="${escHtml(tip)}"` : '';
    return `<div${tipAttr} style="background:${bg};border-radius:10px;padding:12px;cursor:default">
      <div style="font-size:18px;font-weight:700;color:${tc}">${rate}%${badge}</div>
      <div style="font-size:11px;color:${sc};margin-top:2px">${label}（合格线≥${threshold}%）</div>
    </div>`;
  }

  const subj = (a.subject || '') ? `${a.subject}学科` : '本学科';
  document.getElementById('metricCards').innerHTML =
    cell('#EFF6FF','#1D4ED8','#93C5FD', fmt(a.min5Count,' 人'),  '直播出勤5分钟',
      '定义：直播出勤时长 ≥ 5分钟的用户数\n转化率、留存率均以此人数为分母') +
    cell('#EFF6FF','#1D4ED8','#93C5FD', fmtRate(a.min5Rate),     '直播出勤5分钟转化率',
      `定义：出勤 ≥ 5分钟 且 当天转化的用户数 ÷ 出勤 ≥ 5分钟的用户数\n转化 = 低价课结束后当天下单正价课\n与${subj}历史数据对比打分，满分5分`) +
    cell('#F5F3FF','#5B21B6','#C4B5FD', fmt(a.min10Count,' 人'), '直播出勤10分钟',
      '定义：直播出勤时长 ≥ 10分钟的用户数\n用于计算5分钟留存率（10min ÷ 5min）') +
    cell('#F5F3FF','#5B21B6','#C4B5FD', fmtRate(a.min10Rate),    '直播出勤10分钟转化率',
      `定义：出勤 ≥ 10分钟 且 当天转化的用户数 ÷ 出勤 ≥ 10分钟的用户数\n转化 = 低价课结束后当天下单正价课\n仅展示参考，不参与评分`) +
    cell('#FFF7ED','#C2410C','#FCA5A5', fmt(a.min30Count,' 人'), '直播出勤30分钟',
      '定义：直播出勤时长 ≥ 30分钟的用户数\n用于计算30分钟留存率（30min ÷ 10min）') +
    cell('#FFF7ED','#C2410C','#FCA5A5', fmtRate(a.min30Rate),    '直播出勤30分钟转化率',
      `定义：出勤 ≥ 30分钟 且 当天转化的用户数 ÷ 出勤 ≥ 30分钟的用户数\n转化 = 低价课结束后当天下单正价课\n与${subj}历史数据对比打分，满分10分`) +
    retCell(ret10, t10, '5分钟留存率',
      `公式：出勤 ≥ 10分钟人数 ÷ 出勤 ≥ 5分钟人数\n反映开场后学员是否持续在线，衡量课程吸引力\n合格线 ≥ ${t10}%，满分20分`) +
    retCell(ret30, t30, '30分钟留存率',
      `公式：出勤 ≥ 30分钟人数 ÷ 出勤 ≥ 10分钟人数\n反映课程中段留课情况，衡量内容持续吸引力\n合格线 ≥ ${t30}%，满分25分`);
}

// ── 更新：出勤留存漏斗（柱状图 + 折线图）────────────────
function updateAttendanceChart(a) {
  const placeholder = document.getElementById('chartPlaceholder');
  const count5  = parseFloat(a.min5Count)  || 0;
  const count10 = parseFloat(a.min10Count) || 0;
  const count30 = parseFloat(a.min30Count) || 0;
  const rate5   = Math.trunc((parseFloat(a.min5Rate)  || 0) * 100) / 100;
  const rate10  = Math.trunc((parseFloat(a.min10Rate) || 0) * 100) / 100;
  const rate30  = Math.trunc((parseFloat(a.min30Rate) || 0) * 100) / 100;

  const hasCounts = count5 > 0 || count10 > 0 || count30 > 0;
  const hasRates  = rate5 > 0 || rate10 > 0 || rate30 > 0;
  if (!hasCounts && !hasRates) return;
  placeholder.style.display = 'none';

  const t10 = CONFIG.RETENTION_THRESHOLDS.min10;
  const t30 = CONFIG.RETENTION_THRESHOLDS.min30;
  const ret10 = (count5 > 0 && count10 > 0)
    ? Math.trunc(count10 / count5 * 10000) / 100 : null;
  const ret30 = (count10 > 0 && count30 > 0)
    ? Math.trunc(count30 / count10 * 10000) / 100 : null;

  const labels = ['直播出勤5分钟', '直播出勤10分钟', '直播出勤30分钟'];

  const barColors = [
    'rgba(59,130,246,0.75)',
    ret10 !== null
      ? (ret10 >= t10 ? 'rgba(22,163,74,0.75)' : 'rgba(220,38,38,0.75)')
      : 'rgba(139,92,246,0.75)',
    ret30 !== null
      ? (ret30 >= t30 ? 'rgba(22,163,74,0.75)' : 'rgba(220,38,38,0.75)')
      : 'rgba(249,115,22,0.75)',
  ];

  const datasets = [];

  if (hasCounts) {
    datasets.push({
      type: 'bar',
      label: '出勤人数',
      data: [count5, count10, count30],
      backgroundColor: barColors,
      borderRadius: 6,
      yAxisID: 'yCount',
      order: 2,
    });
  }

  if (hasRates) {
    datasets.push({
      type: 'line',
      label: '转化率(%)',
      data: [rate5, rate10, rate30],
      borderColor: 'rgba(245,158,11,1)',
      backgroundColor: 'rgba(245,158,11,0.12)',
      pointBackgroundColor: 'rgba(245,158,11,1)',
      pointRadius: 5,
      pointHoverRadius: 7,
      borderWidth: 2.5,
      fill: true,
      tension: 0.35,
      yAxisID: 'yRate',
      order: 1,
    });
  }

  const ctx = document.getElementById('attendanceChart').getContext('2d');
  if (State.charts.attendance) State.charts.attendance.destroy();

  const scales = {
    x: { ticks: { font: { size: 11 } }, grid: { display: false } },
  };
  if (hasCounts) {
    scales.yCount = {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      ticks: { font: { size: 11 }, color: '#6B7280' },
      grid: { color: '#F3F4F6' },
      title: { display: true, text: '出勤人数', font: { size: 10 }, color: '#9CA3AF' },
    };
  }
  if (hasRates) {
    scales.yRate = {
      type: 'linear',
      position: 'right',
      beginAtZero: true,
      ticks: {
        font: { size: 11 }, color: '#D97706',
        callback: v => v.toFixed(2) + '%',
      },
      grid: { display: false },
      title: { display: true, text: '转化率', font: { size: 10 }, color: '#D97706' },
    };
  }

  State.charts.attendance = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { font: { size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.dataset.yAxisID === 'yRate') return ` 转化率：${c.raw.toFixed(2)}%`;
              let s = ` 出勤人数：${c.raw}`;
              if (c.dataIndex === 1 && ret10 !== null)
                s += `（10min留存率 ${ret10}%，合格线≥${t10}%）`;
              if (c.dataIndex === 2 && ret30 !== null)
                s += `（30min留存率 ${ret30}%，合格线≥${t30}%）`;
              return s;
            },
          },
        },
      },
      scales,
    },
  });
}

// ── 更新：评论分布 ────────────────────────────────────────
function updateCommentDistribution(analysis) {
  const container = document.getElementById('commentDistribution');

  if (analysis.total === 0) {
    container.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">未上传评论数据</p>';
    return;
  }

  const { effective, positive, negative, neutral, noise, positiveRatio } = analysis;
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
      <div class="has-tip" style="background:#F0FDF4;border-radius:8px;padding:10px;text-align:center;cursor:default"
        data-tip="命中正面关键词，且无否定前缀、非疑问句&#10;宽泛词（棒/赞/好等）需搭配课程锚词才生效&#10;─────────────────────&#10;高频词：讲得清楚 通俗易懂 节奏合适&#10;听懂了 收获 学到了 明白了 全懂了&#10;思路清晰 专业 耐心 干货满满&#10;─────────────────────&#10;※ 当前基于关键词匹配，后续将接入语义理解">
        <div style="font-size:20px;font-weight:700;color:#16A34A">${positive}</div>
        <div style="color:#86EFAC">好评</div>
      </div>
      <div class="has-tip" style="background:#FEF2F2;border-radius:8px;padding:10px;text-align:center;cursor:default"
        data-tip="命中负面关键词，且正面词数量不多于负面词&#10;─────────────────────&#10;高频词：听不懂 语速快 太快了 跟不上&#10;无聊 枯燥 划水 没干货 太难了&#10;听不清 声音小 看不清 逻辑乱&#10;─────────────────────&#10;※ 当前基于关键词匹配，后续将接入语义理解">
        <div style="font-size:20px;font-weight:700;color:#DC2626">${negative}</div>
        <div style="color:#FCA5A5">差评</div>
      </div>
      <div class="has-tip" style="background:#F9FAFB;border-radius:8px;padding:10px;text-align:center;cursor:default"
        data-tip="通过噪音过滤但无明确情感倾向，包括：&#10;· 疑问句（末尾含？/吗/呢）&#10;· 好差评词均未命中的普通发言&#10;· 正负词同时命中但无法判断倾向&#10;─────────────────────&#10;例：来了 / 好的 / 开始了 / 收到&#10;─────────────────────&#10;※ 不参与好评率计算">
        <div style="font-size:20px;font-weight:700;color:#6B7280">${neutral}</div>
        <div style="color:#9CA3AF">中性</div>
      </div>
      <div class="has-tip" style="background:#FFF7ED;border-radius:8px;padding:10px;text-align:center;cursor:default"
        data-tip="排除在统计之外，不影响评分，共三类：&#10;─────────────────────&#10;① 助教/场控：发言超15条的高频用户&#10;   引用回复格式（回复xxx>>>）&#10;   含话术关键词（退出重进/班级诊断师等）&#10;② 课堂秩序：针对其他学员的劝退/互怼&#10;   （听不懂的去补基础/别刷了行吗 等）&#10;③ 纯噪音：字数＜3 / 纯数字标点&#10;   重复字符超65%（哈哈哈哈哈 等）">
        <div style="font-size:20px;font-weight:700;color:#C2410C">${noise}</div>
        <div style="color:#FCA5A5">过滤灌水</div>
      </div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#6B7280;text-align:center">
      共 ${analysis.total} 条 · 有效 ${effective} 条 · 好评率 ${positiveRatio}%
    </div>`;

}

// ── 更新：评分面板 ────────────────────────────────────────
function updateScorePanel(scoreData) {
  const { total, retention, comment, rating } = scoreData;

  document.getElementById('scorePanelPlaceholder').classList.add('hidden');
  document.getElementById('scorePanel').classList.remove('hidden');

  // 总分保留1位小数
  const f1 = (n) => Number.isInteger(n) ? n.toFixed(1) : n.toFixed(1);

  document.getElementById('totalScoreDisplay').textContent = f1(total);
  document.getElementById('totalScoreDisplay').style.color = rating.color;

  const badge = document.getElementById('ratingBadge');
  badge.textContent = rating.level;
  badge.style.color = rating.color;
  badge.style.borderColor = rating.color;
  badge.style.backgroundColor = rating.bg;
  badge.title = rating.desc;

  document.getElementById('retentionScore').textContent = `${f1(retention.total)} / 60`;
  document.getElementById('commentScore').textContent   = `${f1(comment.total)} / 30`;

  // 同主讲转化率分
  const st = scoreData.sameTeacher;
  const stMax = (CONFIG.SAME_TEACHER_RATE || {}).maxScore || 10;
  const stScore = st ? st.score : 0;
  document.getElementById('sameTeacherScore').textContent = st
    ? `${f1(st.score)} / ${stMax}  （${st.rate}%，${st.same}/${st.total} 单）`
    : `0 / ${stMax}  （未填写）`;
  setTimeout(() => {
    document.getElementById('sameTeacherBar').style.width = (stScore / stMax * 100) + '%';
    document.getElementById('commentBar').style.width     = (comment.total / 30 * 100) + '%';
  }, 100);

  // 动画进度条（retention bar；comment + sameTeacher bar 在上方已处理）
  setTimeout(() => {
    document.getElementById('retentionBar').style.width = (retention.total / 60 * 100) + '%';
  }, 100);

  // 六项子分（保留1位小数）
  document.getElementById('scoreRet5').textContent        = `${f1(retention.scoreRet5)} / ${retention.maxRet5}`;
  document.getElementById('scoreRet30').textContent       = `${f1(retention.scoreRet30)} / ${retention.maxRet30}`;
  document.getElementById('scoreConv5').textContent       = `${f1(retention.scoreConv5)} / ${retention.maxConv5}`;
  document.getElementById('scoreConv30').textContent      = `${f1(retention.scoreConv30)} / ${retention.maxConv30}`;
  // 动态更新转化率卡片标签和 tooltip：显示当前学科
  const subjectLabel = retention.subject ? `${retention.subject}·` : '';
  document.getElementById('labelConv5').textContent  = `${subjectLabel}5分钟转化率得分`;
  document.getElementById('labelConv30').textContent = `${subjectLabel}30分钟转化率得分`;
  if (retention.convTiers) {
    const sTag = retention.subject ? `【${retention.subject}】` : '';
    const [a5, b5, c5]    = retention.convTiers.conv5;
    const [a30, b30, c30] = retention.convTiers.conv30;
    const tip5  = `满分：5 分 ${sTag}\n≥ ${a5}% → 5 分\n≥ ${b5}% → 4 分\n≥ ${c5}% → 3 分\n< ${c5}% → 按比例（最高 2 分）\n= 0% → 0 分`;
    const tip30 = `满分：10 分 ${sTag}\n≥ ${a30}% → 10 分\n≥ ${b30}% → 8 分\n≥ ${c30}% → 6 分\n< ${c30}% → 按比例（最高 4 分）\n= 0% → 0 分`;
    document.getElementById('scoreConv5Card').setAttribute('data-tip', tip5);
    document.getElementById('scoreConv30Card').setAttribute('data-tip', tip30);
  }
  document.getElementById('scoreCommentCount').textContent= `${f1(comment.scoreCount)} / ${comment.maxCount}`;
  document.getElementById('scoreCommentRatio').textContent= `${f1(comment.scoreRatio)} / ${comment.maxRatio}`;
  // 同主讲子分卡
  document.getElementById('scoreSameTeacher').innerHTML = st
    ? `${f1(st.score)} / ${stMax}&emsp;<span class="text-xs text-gray-400 font-normal">同主讲占比 ${st.rate}%（${st.same}/${st.total} 单）</span>`
    : `0 / ${stMax}&emsp;<span class="text-xs text-gray-400 font-normal">（未填写）</span>`;

  // 转化反馈子分（有数据时显示）
  const fbRow  = document.getElementById('feedbackScoreRow');
  const fbCard = document.getElementById('scoreFeedbackCard');
  if (scoreData.feedback) {
    const fb = scoreData.feedback;
    fbRow.classList.remove('hidden');
    fbCard.classList.remove('hidden');
    document.getElementById('feedbackScorePanel').textContent = `${f1(fb.score)} / ${fb.maxScore} 分（原始）`;
    document.getElementById('scoreFeedback').textContent       = `${f1(fb.score)} / ${fb.maxScore}  （加权均值 ${fb.avg} 档，共 ${fb.total} 人）`;
    setTimeout(() => {
      document.getElementById('feedbackBar').style.width = (fb.score / fb.maxScore * 100) + '%';
    }, 100);
  } else {
    fbRow.classList.add('hidden');
    fbCard.classList.add('hidden');
  }

  // 留存率合格状态卡片
  const hasRetData = retention.retention10Rate !== null || retention.retention30Rate !== null;
  document.getElementById('retentionStatusRow').classList.toggle('hidden', !hasRetData);

  function setRetCard(cardId, valueId, badgeId, rate, pass, threshold) {
    const card = document.getElementById(cardId);
    const valEl = document.getElementById(valueId);
    const badgeEl = document.getElementById(badgeId);
    if (rate === null) { card.style.display = 'none'; return; }
    card.style.display = '';
    if (pass) {
      card.style.background = '#F0FDF4';
      valEl.style.color = '#166534';
      valEl.textContent = rate.toFixed(2) + '%';
      badgeEl.innerHTML = '<span style="background:#DCFCE7;color:#166534;border-radius:4px;padding:1px 6px">✅ 合格</span>';
    } else {
      card.style.background = '#FEF2F2';
      valEl.style.color = '#B91C1C';
      valEl.textContent = rate.toFixed(2) + '%';
      badgeEl.innerHTML = `<span style="background:#FEE2E2;color:#B91C1C;border-radius:4px;padding:1px 6px">❌ 未达标（≥${threshold}%）</span>`;
    }
  }

  setRetCard('ret10Card','ret10Value','ret10Badge',
    retention.retention10Rate, retention.retention10Pass, retention.threshold10);
  setRetCard('ret30Card','ret30Value','ret30Badge',
    retention.retention30Rate, retention.retention30Pass, retention.threshold30);

}

// ── 更新：分析结果（优缺点/建议）────────────────────────
function updateAnalysisContent(reportResult) {
  document.getElementById('analysisPlaceholder').classList.add('hidden');
  document.getElementById('analysisContent').classList.remove('hidden');

  // 渲染单条文本，将开头的【时段】渲染为有色徽章
  function renderItem(item, dotColor) {
    const m = item.match(/^(【[^】]+】)([\s\S]*)$/);
    let inner;
    if (m) {
      // 优点用绿色徽章，不足用红色，建议用蓝色
      const badgeBg  = dotColor === '#16A34A' ? '#DCFCE7'
                     : dotColor === '#DC2626' ? '#FEE2E2' : '#DBEAFE';
      const badgeTc  = dotColor === '#16A34A' ? '#166534'
                     : dotColor === '#DC2626' ? '#B91C1C' : '#1E40AF';
      inner =
        `<span style="display:inline-block;background:${badgeBg};color:${badgeTc};` +
        `border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;` +
        `margin-right:4px;white-space:nowrap">${escHtml(m[1])}</span>` +
        escHtml(m[2]);
    } else {
      inner = escHtml(item);
    }
    return `<li style="display:flex;gap:6px;align-items:flex-start;font-size:12px;` +
           `color:#374151;padding:4px 0;line-height:1.6">` +
           `<span style="color:${dotColor};flex-shrink:0;margin-top:2px">●</span>` +
           `<span style="flex:1">${inner}</span></li>`;
  }

  const renderList = (ulId, items, dotColor) => {
    document.getElementById(ulId).innerHTML =
      items.map(item => renderItem(item, dotColor)).join('');
  };

  renderList('strengthsList',  reportResult.strengths,  '#16A34A');
  renderList('weaknessesList', reportResult.weaknesses, '#DC2626');
  renderSuggestionCards('suggestionsList', reportResult.suggestionGroups || []);
}

// ── 渲染"请老师自查"结构化卡片 ──────────────────────────
function renderSuggestionCards(containerId, groups) {
  const LEVEL = {
    red:    { border: '#DC2626', bg: '#FEF2F2',  badgeBg: '#FEE2E2',  badgeText: '#B91C1C' },
    orange: { border: '#EA580C', bg: '#FFF7ED',  badgeBg: '#FFEDD5',  badgeText: '#C2410C' },
    yellow: { border: '#CA8A04', bg: '#FEFCE8',  badgeBg: '#FEF9C3',  badgeText: '#854D0E' },
    green:  { border: '#16A34A', bg: '#F0FDF4',  badgeBg: '#DCFCE7',  badgeText: '#166534' },
  };
  const NUMS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'];

  const html = groups.map(g => {
    const s = LEVEL[g.level] || LEVEL.orange;

    const scoreHtml = g.score !== null
      ? `<span style="background:${s.badgeBg};color:${s.badgeText};border-radius:4px;` +
        `padding:1px 7px;font-size:11px;font-weight:700;white-space:nowrap;flex-shrink:0">` +
        `${g.score} / ${g.maxScore} 分</span>`
      : '';

    // 判断是否为信号标题行（格式：【xxx】），渲染为小分组标题；否则为普通问题行
    let qIdx = 0;  // 问题序号计数器（跨标题行保持连续）
    const itemsHtml = g.items.map(item => {
      const isTitle = /^【[^】]+】$/.test(item.trim());
      if (isTitle) {
        return `<li style="font-size:11px;font-weight:700;color:${s.border};` +
          `padding:6px 0 2px;margin-top:2px;list-style:none;border-top:1px dashed #e5e7eb;` +
          `first-of-type:border-top:none">${escHtml(item)}</li>`;
      }
      // 去掉拍平时加的全角空格缩进，还原原始文字
      const text = item.replace(/^　　/, '');
      const num = NUMS[qIdx++] || `${qIdx}.`;
      return `<li style="display:flex;gap:6px;align-items:flex-start;font-size:12px;color:#374151;` +
        `padding:3px 0 3px 8px;line-height:1.65;list-style:none">` +
        `<span style="color:${s.border};flex-shrink:0;font-size:11px;font-weight:600;` +
        `margin-top:1px;min-width:14px">${num}</span>` +
        `<span>${escHtml(text)}</span></li>`;
    }).join('');

    return `<div style="border:1px solid #e5e7eb;border-left:3px solid ${s.border};` +
      `border-radius:6px;margin-bottom:8px;overflow:hidden">` +
      `<div style="background:${s.bg};padding:7px 10px;display:flex;align-items:center;gap:6px">` +
      `<span style="font-size:13px;flex-shrink:0">${escHtml(g.icon)}</span>` +
      `<span style="font-weight:600;font-size:12px;color:#111827;flex:1">${escHtml(g.label)}</span>` +
      `<span style="font-size:11px;color:#6b7280;margin-right:4px;text-align:right">` +
      `${escHtml(g.metricText)}</span>` +
      `${scoreHtml}</div>` +
      `<ul style="padding:6px 10px 8px;margin:0;list-style:none">${itemsHtml}</ul>` +
      `</div>`;
  }).join('');

  document.getElementById(containerId).innerHTML = html;
}

// ── 更新：报告文本框 ──────────────────────────────────────
function updateReportOutput(text) {
  document.getElementById('reportOutput').textContent = text;
  document.getElementById('btnCopy').disabled   = false;
  document.getElementById('btnExport').disabled = false;
}

// ── 复制报告 ──────────────────────────────────────────────
function copyReport() {
  if (!State.reportText) return;
  navigator.clipboard.writeText(State.reportText)
    .then(() => showToast('✅ 报告已复制到剪贴板'))
    .catch(() => {
      // 降级方案
      const ta = document.createElement('textarea');
      ta.value = State.reportText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✅ 报告已复制');
    });
}

// ── 导出 TXT ──────────────────────────────────────────────
function exportTXT() {
  if (!State.reportText) return;
  const headerTeacher = document.getElementById('headerTeacher');
  const name = (headerTeacher && headerTeacher.textContent.trim() !== '—')
    ? headerTeacher.textContent.trim() : '老师';
  const now = new Date();
  const filename = `课堂评价报告_${name}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.txt`;

  const blob = new Blob(['﻿' + State.reportText], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`✅ 已导出：${filename}`);
}

// ── 留存率实时计算展示 ────────────────────────────────────
function updateRetentionCalcRow() {
  const count5  = parseFloat(document.getElementById('min5Count').value)  || 0;
  const count10 = parseFloat(document.getElementById('min10Count').value) || 0;
  const count30 = parseFloat(document.getElementById('min30Count').value) || 0;
  const t10 = CONFIG.RETENTION_THRESHOLDS.min10;
  const t30 = CONFIG.RETENTION_THRESHOLDS.min30;

  const ret10 = (count5 > 0 && count10 > 0) ? Math.round(count10 / count5 * 10000) / 100 : null;
  const ret30 = (count10 > 0 && count30 > 0) ? Math.round(count30 / count10 * 10000) / 100 : null;

  const row = document.getElementById('retentionCalcRow');
  const d10 = document.getElementById('ret10Display'); // 5分钟留存率
  const d30 = document.getElementById('ret30Display');

  if (ret10 === null && ret30 === null) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');

  function badge(rate, threshold) {
    if (rate === null) return '<span style="color:#9CA3AF">—</span>';
    const pass = rate >= threshold;
    const color = pass ? '#166534' : '#B91C1C';
    const tag   = pass
      ? `<span style="font-size:10px;background:#DCFCE7;color:#166534;border-radius:4px;padding:1px 5px;margin-left:5px">合格</span>`
      : `<span style="font-size:10px;background:#FEE2E2;color:#B91C1C;border-radius:4px;padding:1px 5px;margin-left:5px">不合格</span>`;
    return `<span style="color:${color}">${rate}%</span>${tag}`;
  }

  d10.innerHTML = badge(ret10, t10);
  d30.innerHTML = badge(ret30, t30);
}

// ── 转化反馈：初始化输入行（从 config 动态渲染）──────────
function initFeedbackTiers() {
  const container = document.getElementById('feedbackTierInputs');
  if (!container) return;
  const tiers = (CONFIG.CONVERSION_FEEDBACK && CONFIG.CONVERSION_FEEDBACK.tiers) || [];
  const nums  = ['①','②','③','④','⑤'];
  container.innerHTML = tiers.map((t, i) => `
    <div class="flex items-center gap-2">
      <span class="inline-flex w-5 h-5 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style="background:${t.bg};color:${t.color}">${nums[i]}</span>
      <span class="flex-1 text-xs text-gray-600 leading-tight">${t.label}</span>
      <input id="fb${i+1}" type="number" min="0" placeholder="0"
             class="manual-input w-14 text-center flex-shrink-0"
             oninput="updateFeedbackPreview()" />
      <span class="text-xs text-gray-400 w-4 flex-shrink-0">人</span>
    </div>`).join('');
}

// ── 转化反馈：读取各档人数 ────────────────────────────────
function readFeedbackCounts() {
  const n = (CONFIG.CONVERSION_FEEDBACK && CONFIG.CONVERSION_FEEDBACK.tiers
            ? CONFIG.CONVERSION_FEEDBACK.tiers.length : 5);
  const counts = [];
  for (let i = 1; i <= n; i++) {
    const el = document.getElementById(`fb${i}`);
    counts.push(el ? (parseInt(el.value) || 0) : 0);
  }
  return counts;
}

// ── 转化反馈：实时预览得分 ───────────────────────────────
function updateFeedbackPreview() {
  const counts  = readFeedbackCounts();
  const result  = Scorer.calcConversionFeedback
    ? Scorer.calcConversionFeedback(counts)
    : null;
  const preview = document.getElementById('feedbackPreview');
  if (!preview) return;

  if (!result) {
    preview.classList.add('hidden');
    State.feedbackCounts = null;
    return;
  }

  State.feedbackCounts = counts;
  preview.classList.remove('hidden');
  document.getElementById('feedbackScoreDisplay').textContent = `${result.score} / ${result.maxScore}`;
  document.getElementById('feedbackAvgDisplay').textContent   = `${result.avg} 分（五档加权均值）`;
  document.getElementById('feedbackTotalDisplay').textContent = `${result.total} 人`;
}

// ── 转化反馈：清除 ───────────────────────────────────────
function clearFeedbackData() {
  const n = (CONFIG.CONVERSION_FEEDBACK && CONFIG.CONVERSION_FEEDBACK.tiers
            ? CONFIG.CONVERSION_FEEDBACK.tiers.length : 5);
  for (let i = 1; i <= n; i++) {
    const el = document.getElementById(`fb${i}`);
    if (el) el.value = '';
  }
  State.feedbackCounts = null;
  const preview = document.getElementById('feedbackPreview');
  if (preview) preview.classList.add('hidden');
}

// ── 同主讲转化率：实时预览 ───────────────────────────────
function updateSameTeacherPreview() {
  const same  = parseInt(document.getElementById('stSame')?.value)  || 0;
  const other = parseInt(document.getElementById('stOther')?.value) || 0;
  const total = same + other;
  const preview = document.getElementById('sameTeacherPreview');
  if (!preview) return;

  if (total === 0) {
    preview.classList.add('hidden');
    State.sameTeacher = null;
    return;
  }

  const result = Scorer.calcSameTeacherRate(same, total);
  State.sameTeacher = { same, total };
  preview.classList.remove('hidden');

  const rate = result ? result.rate : 0;
  document.getElementById('stRateDisplay').textContent  = `${same} / ${total} = ${rate}%`;
  document.getElementById('stScoreDisplay').textContent = `${result ? result.score : 0} / ${(CONFIG.SAME_TEACHER_RATE||{}).maxScore||10} 分`;
}

// ── 同主讲转化率：清除 ───────────────────────────────────
function clearSameTeacherData() {
  const stSame  = document.getElementById('stSame');
  const stOther = document.getElementById('stOther');
  if (stSame)  stSame.value  = '';
  if (stOther) stOther.value = '';
  State.sameTeacher = null;
  const preview = document.getElementById('sameTeacherPreview');
  if (preview) preview.classList.add('hidden');
}

// ── 同主讲转化率：图片上传预览 ──────────────────────────
function handleSameTeacherImg(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img  = document.getElementById('stImgPreview');
    const hint = document.getElementById('stImgHint');
    if (img && hint) {
      img.src = e.target.result;
      img.classList.remove('hidden');
      hint.classList.add('hidden');
    }
  };
  reader.readAsDataURL(file);
}

// ── 同主讲转化率：同步出勤数据中的主讲老师名 ────────────
function syncSameTeacherName() {
  const el = document.getElementById('sameTeacherName');
  if (!el) return;
  const teacher = document.getElementById('headerTeacher');
  const name = teacher ? teacher.textContent.trim() : '';
  el.textContent = (name && name !== '—') ? name : '—（请先上传出勤数据）';
}

// ── 初始化 ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDragDrop();
  initFeedbackTiers();
  const manualIds = ['min5Count','min5Rate','min10Count','min10Rate','min30Count','min30Rate'];
  manualIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      State.attendanceData = readManualAttendance();
      updateRetentionCalcRow();
    });
  });
});
