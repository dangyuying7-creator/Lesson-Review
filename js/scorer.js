// ============================================================
// scorer.js — 综合打分模块（新计分规则）
// 留存转化分60分（4项）+ 互动评论分40分（2项）= 总分100分
// ============================================================

const Scorer = (() => {

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // ── 工具：按学科阶梯计算转化率得分（5档）────────────────────
  // tiers = [满分线%, 良好线%, 合格线%]；maxScore = 满分值
  // 档位：≥P75→100% / ≥P50→80% / ≥P25→60% / >0→线性折算最高40% / =0→0分
  function calcConvByTier(rate, maxScore, tiers) {
    const [t1, t2, t3] = tiers;
    if (rate <= 0) return 0;
    if (rate >= t1) return maxScore;
    if (rate >= t2) return round1(maxScore * 0.8);
    if (rate >= t3) return round1(maxScore * 0.6);
    // 低于合格线但 > 0：线性折算，最高 40% 满分
    return Math.max(round1(maxScore * 0.4 * rate / t3), 0.1);
  }

  // ── 留存转化分（60分，4项）───────────────────────────────
  function calcRetentionScore(attendance) {
    const rate5   = parseFloat(attendance.min5Rate)   || 0;
    const rate10  = parseFloat(attendance.min10Rate)  || 0;
    const rate30  = parseFloat(attendance.min30Rate)  || 0;
    const count5  = parseFloat(attendance.min5Count)  || 0;
    const count10 = parseFloat(attendance.min10Count) || 0;
    const count30 = parseFloat(attendance.min30Count) || 0;

    // 5分钟留存率 = count10 / count5（原"10分钟留存率"，改名）
    const ret5Rate  = (count5  > 0 && count10 > 0) ? count10 / count5  * 100 : null;
    // 30分钟留存率 = count30 / count10
    const ret30Rate = (count10 > 0 && count30 > 0) ? count30 / count10 * 100 : null;

    // 1. 5分钟留存率得分（满20分）
    let scoreRet5 = 0;
    if (ret5Rate !== null) {
      scoreRet5 = ret5Rate >= 90 ? 20 : Math.max(0, round1(20 * ret5Rate / 100));
    }

    // 2. 30分钟留存率得分（满25分）
    let scoreRet30 = 0;
    if (ret30Rate !== null) {
      scoreRet30 = ret30Rate >= 60 ? 25 : Math.max(0, round1(25 * ret30Rate / 60));
    }

    // 3 & 4. 转化率得分：按学科使用对应阶梯，找不到学科时用 _default
    const subjectMap = CONFIG.SUBJECT_CONV_TIERS || {};
    const subject    = String(attendance.subject || '').trim();
    const tiers      = subjectMap[subject] || subjectMap['_default'] || null;

    // 3. 5分钟转化率得分（满5分）
    let scoreConv5 = 0;
    if (tiers) {
      scoreConv5 = calcConvByTier(rate5, 5, tiers.conv5);
    } else {
      // 无配置时保底逻辑（兼容旧数据）
      if      (rate5 >= 5) scoreConv5 = 5;
      else if (rate5 >= 3) scoreConv5 = round1(5 * 0.8);
      else if (rate5 >= 1) scoreConv5 = round1(5 * 0.5);
    }

    // 4. 30分钟转化率得分（满10分）
    let scoreConv30 = 0;
    if (tiers) {
      scoreConv30 = calcConvByTier(rate30, 10, tiers.conv30);
    } else {
      if      (rate30 >= 5) scoreConv30 = 10;
      else if (rate30 >= 3) scoreConv30 = round1(10 * 0.8);
      else if (rate30 >= 1) scoreConv30 = round1(10 * 0.5);
    }

    const t5  = CONFIG.RETENTION_THRESHOLDS.min10;  // 90
    const t30 = CONFIG.RETENTION_THRESHOLDS.min30;  // 60

    // 把实际使用的阶梯标准也带出去，供 tooltip / 报告展示
    const usedTiers = tiers || null;

    return {
      total:      round1(scoreRet5 + scoreRet30 + scoreConv5 + scoreConv30),
      scoreRet5,  maxRet5:  20,
      scoreRet30, maxRet30: 25,
      scoreConv5, maxConv5: 5,
      scoreConv30,maxConv30: 10,
      rate5, rate10, rate30,
      subject,
      convTiers: usedTiers,
      count5, count10, count30,
      ret5Rate,  ret30Rate,
      ret5Pass:  ret5Rate  !== null ? ret5Rate  >= t5  : null,
      ret30Pass: ret30Rate !== null ? ret30Rate >= t30 : null,
      threshold5:  t5,
      threshold30: t30,
      // 兼容旧字段名（供 report.js / updateMetricCards 使用）
      retention10Rate: ret5Rate  !== null ? Math.round(ret5Rate  * 100) / 100 : null,
      retention30Rate: ret30Rate !== null ? Math.round(ret30Rate * 100) / 100 : null,
      retention10Pass: ret5Rate  !== null ? ret5Rate  >= t5  : null,
      retention30Pass: ret30Rate !== null ? ret30Rate >= t30 : null,
      threshold10: t5,
    };
  }

  // ── 转化反馈得分（可选，20分）────────────────────────────
  // counts: [n①, n②, n③, n④, n⑤]，各档人数（①=5分最高，⑤=1分最低）
  // 返回 null 表示未填写，该项不参与计算
  function calcConversionFeedback(counts) {
    if (!counts || !Array.isArray(counts)) return null;
    const total = counts.reduce((s, c) => s + (c || 0), 0);
    if (total === 0) return null;  // 全空 → 不参与

    const cfg = CONFIG.CONVERSION_FEEDBACK || {};
    const maxScore = cfg.maxScore || 20;
    const tierScores = (cfg.tiers || []).map(t => t.score);   // [5,4,3,2,1]

    // 加权平均 avg ∈ [1,5]
    const weightedSum = counts.reduce((s, c, i) => s + (c || 0) * (tierScores[i] || 0), 0);
    const avg = weightedSum / total;

    // 映射：(avg-1)/4 × maxScore → [0, maxScore]
    const score = round1((avg - 1) / 4 * maxScore);
    return { score, maxScore, total, avg: round1(avg * 10) / 10, counts };
  }

  // ── 互动评论分（40分，2项）───────────────────────────────
  function calcCommentScore(analysis, attendance) {
    const effectiveCount = analysis.effective    || 0;
    const positiveRatio  = analysis.positiveRatio || 0;
    const count5 = parseFloat(attendance ? attendance.min5Count : 0) || 0;

    // 5. 有效评论数得分（满10分）：满分线 = count5 × 1.0（1人1条即满分）
    const fullMarkCount = count5 > 0 ? count5 * 1.0 : null;
    let scoreCount = 0;
    if (fullMarkCount !== null && fullMarkCount > 0) {
      scoreCount = effectiveCount >= fullMarkCount
        ? 10
        : Math.max(0, round1(10 * effectiveCount / fullMarkCount));
    }

    // 6. 好差评比得分（满20分）
    // 规则：负面 ≥ 正面 → 0分；正面 > 负面 → 按正面占比同比例折算，≥90%→满分
    const posNegRatio = analysis.posNegRatio || 0;
    const positiveCount = analysis.positive || 0;
    const negativeCount = analysis.negative || 0;
    const scoreRatio = (negativeCount >= positiveCount && (positiveCount + negativeCount) > 0)
      ? 0
      : posNegRatio >= 90
        ? 20
        : Math.max(0, round1(20 * posNegRatio / 100));

    return {
      total:       round1(scoreCount + scoreRatio),
      scoreCount,  maxCount: 10,
      scoreRatio,  maxRatio: 20,
      effectiveCount,
      positiveRatio,
      posNegRatio,
      positive: positiveCount,
      negative: negativeCount,
      fullMarkCount,
    };
  }

  // ── 同主讲转化率得分（满10分，不归一化）────────────────────
  // sameCount: 转化到上课主讲的单数；totalCount: 该科目总转化单数
  // 返回 null 表示未填写（直接得 0 分，无需特殊处理）
  function calcSameTeacherRate(sameCount, totalCount) {
    const same  = parseInt(sameCount)  || 0;
    const total = parseInt(totalCount) || 0;
    if (total === 0) return null;  // 未填或全0 → null

    const rate = round1(same / total * 100);  // 百分比，如 93.02

    const cfg   = CONFIG.SAME_TEACHER_RATE || {};
    const max   = cfg.maxScore || 10;
    const tiers = cfg.tiers    || [];

    let score = 0;
    for (const t of tiers) {
      if (rate >= t.minRate) { score = t.score; break; }
    }

    return { score, maxScore: max, rate, same, total };
  }

  // ── 获取评级 ──────────────────────────────────────────────
  function getRating(totalScore) {
    for (const r of CONFIG.RATINGS) {
      if (totalScore >= r.minScore) return r;
    }
    return CONFIG.RATINGS[CONFIG.RATINGS.length - 1];
  }

  // ── 主入口 ────────────────────────────────────────────────
  // feedbackCounts（可选）: [n①~n⑤] 转化反馈，有则归一化
  // sameTeacher（可选）: { same, total } 同主讲，直接计入10分（不归一）
  function calcScore(attendance, analysis, feedbackCounts, sameTeacher) {
    const retention   = calcRetentionScore(attendance);
    const comment     = calcCommentScore(analysis, attendance);
    const feedback    = calcConversionFeedback(feedbackCounts || null);
    const sameTeacherResult = sameTeacher
      ? calcSameTeacherRate(sameTeacher.same, sameTeacher.total)
      : null;

    // 同主讲得分直接加入（不归一化；未填则0分，但总分基准不变）
    const sameScore = sameTeacherResult ? sameTeacherResult.score : 0;

    // 互动评论分已包含同主讲满分空间（comment.total 最高30，同主讲最高10，合计40）
    // 但两者独立计算，不在 comment 对象里，需单独累加
    let total;
    if (feedback) {
      // 有转化反馈：以 (留存60 + 评论30 + 同主讲10 + 反馈20) = 120 为基数归一
      const base   = 60 + 30 + 10 + feedback.maxScore;         // 120
      const rawSum = retention.total + comment.total + sameScore + feedback.score;
      total = round1(rawSum * 100 / base);
    } else {
      // 无转化反馈：留存(60) + 评论(30) + 同主讲(0~10) = 100
      total = round1(retention.total + comment.total + sameScore);
    }

    const rating = getRating(total);
    return { total, retention, comment, feedback, sameTeacher: sameTeacherResult, rating, maxTotal: 100 };
  }

  return { calcScore, getRating, calcConversionFeedback, calcSameTeacherRate };
})();
