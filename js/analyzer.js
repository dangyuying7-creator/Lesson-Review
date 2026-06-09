// ============================================================
// analyzer.js — 评论文本分析模块
// 负责：过滤灌水 → 关键词匹配 → 分类统计
// ============================================================

const Analyzer = (() => {

  // ── 工具：检测是否为助教/场控消息 ───────────────────────
  // 规则1：引用回复格式 "回复xxx>>>"
  function isAssistantReply(text) {
    if (!text) return false;
    return /回复.{1,30}[>＞]{2,}/.test(text);
  }

  // 规则2：话术关键词（模板消息）
  function isAssistantContent(text) {
    if (!text) return false;
    const patterns = CONFIG.ASSISTANT.contentPatterns;
    return patterns.some(p => p.test(text));
  }

  // 规则3：高频发言者（统计后传入 assistantIds Set）
  // 综合判断入口
  function isAssistantMsg(text, userId, assistantIds) {
    return isAssistantReply(text)
        || isAssistantContent(text)
        || (userId && assistantIds.has(userId));
  }

  // ── 工具：检测是否为课堂秩序类评论（学员互怼/劝退）──────
  // 该类评论针对其他学员，不反映对老师的评价，应排除统计
  function isOrderComment(text) {
    if (!text) return false;
    const patterns = CONFIG.ORDER_PATTERNS || [];
    return patterns.some(p => p.test(text));
  }

  // ── 工具：检测是否为无效/灌水评论 ────────────────────────
  function isNoise(text) {
    if (!text || typeof text !== 'string') return true;
    const t = text.trim();
    if (t.length < CONFIG.NOISE.minLength) return true;

    // 纯标点/数字/英文
    for (const pattern of CONFIG.NOISE.purePatterns) {
      if (pattern.test(t)) return true;
    }

    // 重复字符比例过高（如"哈哈哈哈"）
    const maxChar = [...t].sort((a, b) =>
      t.split(b).length - t.split(a).length
    )[0];
    const repeatRatio = (t.split(maxChar).length - 1) / t.length;
    if (repeatRatio > CONFIG.NOISE.maxRepeatRatio) return true;

    return false;
  }

  // ── 工具：关键词匹配，返回命中的词列表 ───────────────────
  function matchKeywords(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.filter(kw => lower.includes(kw.toLowerCase()));
  }

  // ── 工具：检测是否为疑问句 ────────────────────────────────
  // 末尾带"吗/呢/？/?"（可带标点）视为疑问，如"听懂了吗？"→不计为好评
  function isQuestion(text) {
    return /[吗呢][，。？?！!]*$/.test(text.trim()) ||
           /[？?]$/.test(text.trim());
  }

  // ── 工具：正面关键词是否被否定前缀抵消 ──────────────────
  // 在命中位置前2个字符内若有"不/没/别/未"，则该正面词无效
  // 例："看不懂了" 中 "懂了" 前两字为"不懂"，含"不"→抵消
  //     "不太明白了" 中 "明白了" 前两字为"不太"，含"不"→抵消
  function isPosNegated(text, kw) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx <= 0) return false;
    const prefix = lower.slice(Math.max(0, idx - 2), idx);
    return /[不没别未]/.test(prefix);
  }

  // ── 单条评论分类 ──────────────────────────────────────────
  // 返回 { type: 'positive'|'negative'|'neutral', hitPos: [], hitNeg: [] }
  function categorize(text) {
    // 1. 疑问句 → 直接中性（提问不代表正面情绪）
    if (isQuestion(text)) {
      return { type: 'neutral', hitPos: [], hitNeg: [] };
    }

    // 2. 正面关键词命中，但排除被否定前缀抵消的
    //    例："不错" 本身是正面词，前面没有否定；"没听懂了" 中"懂了"前有"没"→抵消
    const rawPos = matchKeywords(text, CONFIG.KEYWORDS.positive);
    const hitPos = rawPos.filter(kw => !isPosNegated(text, kw));

    // 3. 宽泛正面词过滤：仅靠通用感叹词（太好了/棒/赞…）命中，
    //    若文本中没有课程相关锚词，则不计为好评（避免"广东没有真是太好了"误判）
    const weakSet  = new Set(CONFIG.KEYWORDS.positiveWeak || []);
    const anchors  = CONFIG.KEYWORDS.positiveAnchors || [];
    const hasAnchor = anchors.some(a => text.includes(a));
    const strongHits = hitPos.filter(kw => !weakSet.has(kw));   // 明确课程类词
    const effectivePos = (strongHits.length > 0 || hasAnchor) ? hitPos : [];

    // 4. 负面关键词正常匹配
    const hitNeg = matchKeywords(text, CONFIG.KEYWORDS.negative);

    let type = 'neutral';
    if (effectivePos.length > 0 && hitNeg.length === 0) {
      type = 'positive';
    } else if (hitNeg.length > 0 && effectivePos.length === 0) {
      type = 'negative';
    } else if (effectivePos.length > 0 && hitNeg.length > 0) {
      // 同时命中：正面数量严格多于负面才算正面，否则负面优先
      type = effectivePos.length > hitNeg.length ? 'positive' : 'negative';
    }

    return { type, hitPos: effectivePos, hitNeg };
  }

  // ── 批量分析评论列表 ──────────────────────────────────────
  // rows: Array<{ content: string, ... }>
  // 返回完整分析结果对象
  function analyzeComments(rows) {
    if (!rows || rows.length === 0) {
      return _emptyResult();
    }

    // ── 先统计每个用户发言总数，超过阈值的为助教/场控 ────
    const threshold = (CONFIG.ASSISTANT && CONFIG.ASSISTANT.msgThreshold) || 15;
    const userCount = {};
    for (const row of rows) {
      const uid = String(row.userId || row.nick || row.nickName || '');
      if (uid) userCount[uid] = (userCount[uid] || 0) + 1;
    }
    // 高频用户 ID 集合
    const assistantIds = new Set(
      Object.entries(userCount).filter(([, c]) => c >= threshold).map(([id]) => id)
    );

    const result = {
      total: rows.length,
      noise: 0,
      effective: 0,
      positive: 0,
      negative: 0,
      neutral: 0,
      positiveComments: [],
      negativeComments: [],
      neutralComments: [],
      allPositiveKeywords: {},  // keyword → count
      allNegativeKeywords: {},  // keyword → count
    };

    for (const row of rows) {
      const text = String(row.content || '').trim();
      const uid  = String(row.userId || row.nick || row.nickName || '');

      // 助教/场控消息不计入学员评论统计
      if (isAssistantMsg(text, uid, assistantIds)) continue;

      // 课堂秩序类（学员互怼/劝退其他学员）不计入评价统计
      if (isOrderComment(text)) continue;

      if (isNoise(text)) {
        result.noise++;
        continue;
      }

      result.effective++;
      const { type, hitPos, hitNeg } = categorize(text);

      if (type === 'positive') {
        result.positive++;
        result.positiveComments.push({
          time:    String(row.time    || ''),
          content: text,
          nick:    String(row.nick   || row.nickName || ''),
          userId:  String(row.userId || ''),
        });
        hitPos.forEach(kw => {
          result.allPositiveKeywords[kw] = (result.allPositiveKeywords[kw] || 0) + 1;
        });
      } else if (type === 'negative') {
        result.negative++;
        result.negativeComments.push({
          time:    String(row.time    || ''),
          content: text,
          nick:    String(row.nick   || row.nickName || ''),
          userId:  String(row.userId || ''),
        });
        hitNeg.forEach(kw => {
          result.allNegativeKeywords[kw] = (result.allNegativeKeywords[kw] || 0) + 1;
        });
      } else {
        result.neutral++;
        result.neutralComments.push(text);
      }
    }

    // 正面占比（基于有效评论，用于展示）
    result.positiveRatio = result.effective > 0
      ? Math.round((result.positive / result.effective) * 100)
      : 0;

    // 正面占比（仅计正面+负面，用于评分）
    const posneg = result.positive + result.negative;
    result.posNegRatio = posneg > 0
      ? Math.round((result.positive / posneg) * 10000) / 100
      : 0;

    // 排序后的高频关键词（取前5）
    result.topPositiveKeywords = _topN(result.allPositiveKeywords, 5);
    result.topNegativeKeywords = _topN(result.allNegativeKeywords, 5);

    return result;
  }

  function _emptyResult() {
    return {
      total: 0, noise: 0, effective: 0,
      positive: 0, negative: 0, neutral: 0,
      positiveComments: [], negativeComments: [], neutralComments: [],
      allPositiveKeywords: {}, allNegativeKeywords: {},
      positiveRatio: 0,
      topPositiveKeywords: [], topNegativeKeywords: [],
    };
  }

  function _topN(obj, n) {
    return Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([kw, count]) => ({ kw, count }));
  }

  // ── 解析时间戳 ────────────────────────────────────────────
  function parseTs(t) {
    if (!t) return null;
    const d = new Date(String(t).replace(/\//g, '-').replace(/(\d{4}-\d{2}-\d{2})\s/, '$1T'));
    return isNaN(d.getTime()) ? null : d;
  }

  // ── 按时间分桶分析 ────────────────────────────────────────
  // 以最早一条评论为课程起点，按相对分钟数分桶
  function analyzeByTimeSlots(rows) {
    const timed = rows
      .map(r => ({ content: String(r.content || ''), ts: parseTs(r.time) }))
      .filter(r => r.ts !== null);

    if (timed.length < 3) return [];   // 时间戳太少，不做分析

    const origin = Math.min(...timed.map(r => r.ts.getTime()));

    const SLOTS = [
      { label: '0~5分钟',   min: 0,  max: 5  },
      { label: '5~10分钟',  min: 5,  max: 10 },
      { label: '10~20分钟', min: 10, max: 20 },
      { label: '20~30分钟', min: 20, max: 30 },
      { label: '30分钟以上', min: 30, max: Infinity },
    ];

    const buckets = SLOTS.map(s => ({ ...s, rows: [] }));

    for (const r of timed) {
      const mins = (r.ts.getTime() - origin) / 60000;
      const b = buckets.find(s => mins >= s.min && mins < s.max);
      if (b) b.rows.push(r);
    }

    const result = [];
    for (const b of buckets) {
      if (b.rows.length === 0) continue;

      let pos = 0, neg = 0, neu = 0;
      const posKws = {}, negKws = {};

      for (const r of b.rows) {
        const text = r.content.trim();
        if (isNoise(text)) continue;
        const { type, hitPos, hitNeg } = categorize(text);
        if (type === 'positive') {
          pos++;
          hitPos.forEach(k => { posKws[k] = (posKws[k] || 0) + 1; });
        } else if (type === 'negative') {
          neg++;
          hitNeg.forEach(k => { negKws[k] = (negKws[k] || 0) + 1; });
        } else {
          neu++;
        }
      }

      const effective = pos + neg + neu;
      result.push({
        label:         b.label,
        min:           b.min,
        total:         b.rows.length,
        effective,
        positive:      pos,
        negative:      neg,
        neutral:       neu,
        positiveRatio: effective > 0 ? Math.round(pos / effective * 100) : 0,
        negativeRatio: effective > 0 ? Math.round(neg / effective * 100) : 0,
        topPosKws:     _topN(posKws, 3),
        topNegKws:     _topN(negKws, 4),
      });
    }

    return result;
  }

  // ── 主入口：在 analyzeComments 末尾附加时段分析 ──────────
  // 时段分析使用与 analyzeComments 完全相同的过滤规则，确保数字口径一致
  const _origAnalyze = analyzeComments;
  function analyzeCommentsWithSlots(rows) {
    const result = _origAnalyze(rows);

    // 重建助教 ID 集合（与 analyzeComments 内部逻辑一致）
    const threshold = (CONFIG.ASSISTANT && CONFIG.ASSISTANT.msgThreshold) || 15;
    const userCount = {};
    for (const row of (rows || [])) {
      const uid = String(row.userId || row.nick || row.nickName || '');
      if (uid) userCount[uid] = (userCount[uid] || 0) + 1;
    }
    const assistantIds = new Set(
      Object.entries(userCount).filter(([, c]) => c >= threshold).map(([id]) => id)
    );

    // 用与主循环完全相同的过滤条件筛选行，再传给时段分析
    const filteredRows = (rows || []).filter(row => {
      const text = String(row.content || '').trim();
      const uid  = String(row.userId || row.nick || row.nickName || '');
      if (isAssistantMsg(text, uid, assistantIds)) return false;
      if (isOrderComment(text)) return false;
      if (isNoise(text)) return false;
      return true;
    });

    result.timeSlots = analyzeByTimeSlots(filteredRows);
    return result;
  }

  // ── 公开接口 ──────────────────────────────────────────────
  return { analyzeComments: analyzeCommentsWithSlots, isNoise, categorize };
})();
