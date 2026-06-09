// ============================================================
// report.js — 评价报告文案生成模块
// 根据分析结果和评分自动生成中文评价文案
// ============================================================

const Report = (() => {

  // ── 生成优点清单 ──────────────────────────────────────────
  function buildStrengths(analysis, scoreData) {
    const strengths = [];
    const { retention, comment } = scoreData;
    const slots = analysis.timeSlots || [];

    if (retention.ret5Rate !== null && retention.ret5Rate >= 75) {
      strengths.push(`课堂吸引力较强，5分钟留存率达 ${retention.ret5Rate.toFixed(1)}%，开场效果良好`);
    }
    if (retention.ret30Rate !== null && retention.ret30Rate >= 40) {
      strengths.push(`内容持续吸引力高，30分钟留存率达 ${retention.ret30Rate.toFixed(1)}%，学员黏性较好`);
    }
    if (comment.positiveRatio >= 65) {
      strengths.push(`学员评价整体正面，好评占比 ${comment.positiveRatio}%，课堂满意度较高`);
    }
    if (comment.effectiveCount >= 50) {
      strengths.push(`课堂互动活跃，有效评论 ${comment.effectiveCount} 条，学员参与感强`);
    }

    // 时段好评分布：找好评率高、且有实际好评关键词的时段
    const goodSlots = slots
      .filter(s => s.effective >= 3 && s.positiveRatio >= 55 && s.topPosKws.length > 0)
      .sort((a, b) => b.positiveRatio - a.positiveRatio)
      .slice(0, 3);

    for (const s of goodSlots) {
      const kwStr = s.topPosKws.map(k => `「${k.kw}」×${k.count}`).join('、');
      strengths.push(`【${s.label}】好评集中（好评率 ${s.positiveRatio}%），学员反馈：${kwStr}`);
    }

    // 从全局高频好评关键词补充
    const kwMap = {
      '讲得清楚': '讲解表达清晰，学员容易理解',
      '通俗易懂': '语言通俗，知识点讲解深入浅出',
      '节奏合适': '授课节奏把控得当，松弛有度',
      '例题易懂': '例题选取贴近学员认知，有效辅助理解',
      '知识点细致': '知识点覆盖细致，内容完整度高',
      '有趣': '课堂内容生动有趣，学员学习兴趣高',
      '专业': '专业度高，获得学员认可',
    };

    const hitKws = analysis.topPositiveKeywords.map(k => k.kw);
    for (const [kw, desc] of Object.entries(kwMap)) {
      if (hitKws.some(h => h.includes(kw) || kw.includes(h))) {
        if (!strengths.some(s => s.includes(desc.slice(0, 5)))) {
          strengths.push(desc);
        }
      }
    }

    if (strengths.length === 0) {
      strengths.push('本节课数据暂未显示明显优势，建议增加数据量后再次评估');
    }

    // 好评原文（同差评逻辑，按人合并）
    const posComments = analysis.positiveComments || [];
    if (posComments.length > 0) {
      const { lines, groupCount } = formatCommentGroup(posComments);
      strengths.push(`── 好评原文（共 ${groupCount} 人头，${posComments.length} 条）──`);
      lines.forEach(l => strengths.push(l));
    }

    return strengths;
  }

  // ── 公共：将评论列表按 nick 分组，生成显示行数组 ──────────
  // comments: [{time, content, nick, userId}]
  // 返回格式化字符串数组（与 buildWeaknesses / buildStrengths 相同格式）
  function formatCommentGroup(comments) {
    const lines = [];
    const groups = [];
    const nickIndex = {};

    for (const c of comments) {
      const nick = c.nick || c.userId || '';
      if (nick && nickIndex[nick] !== undefined) {
        groups[nickIndex[nick]].items.push(c);
      } else {
        nickIndex[nick] = groups.length;
        groups.push({ nick, items: [c] });
      }
    }

    groups.forEach(g => {
      const nameTag = g.nick ? `${g.nick}：` : '';
      if (g.items.length === 1) {
        const c = g.items[0];
        const t = fmtCommentTime(c.time);
        lines.push(`${t ? `【${t}】` : ''}${nameTag}${c.content}`);
      } else {
        const first = g.items[0];
        const t0 = fmtCommentTime(first.time);
        const countTag = g.nick ? `${g.nick}（${g.items.length}条）：` : `（${g.items.length}条）：`;
        const rest = g.items.slice(1).map(c => {
          const t = fmtCommentTime(c.time);
          return t ? `【${t}】${c.content}` : c.content;
        });
        lines.push(`${t0 ? `【${t0}】` : ''}${countTag}${first.content} / ${rest.join(' / ')}`);
      }
    });

    return { lines, groupCount: groups.length };
  }

  // ── 格式化评论时间戳 → HH:MM ─────────────────────────────
  function fmtCommentTime(t) {
    if (!t) return '';
    const d = new Date(String(t).replace(/\//g, '-').replace(/(\d{4}-\d{2}-\d{2})\s/, '$1T'));
    if (isNaN(d.getTime())) return String(t).slice(0, 16);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  // ── 分析评论中高负面密度时段（按时间戳分桶）────────────
  function detectCommentDropZone(analysis) {
    // 将负面评论关键词归类到课程阶段
    const negKws = (analysis.topNegativeKeywords || []).map(k => k.kw);
    const phases = [];

    const earlyNeg  = ['听不懂','跟不上','听不清','语速快','太快了','无聊','枯燥'];
    const midNeg    = ['例题太难','题目太难','重难点不讲','难点没讲','重点没讲','没干货','划水'];
    const lateNeg   = ['语速慢','讲太慢','太慢了','乱','逻辑乱','没逻辑'];

    const hitEarly = negKws.some(k => earlyNeg.some(e => k.includes(e) || e.includes(k)));
    const hitMid   = negKws.some(k => midNeg.some(e => k.includes(e) || e.includes(k)));
    const hitLate  = negKws.some(k => lateNeg.some(e => k.includes(e) || e.includes(k)));

    if (hitEarly) phases.push('课程开场阶段（前10分钟）');
    if (hitMid)   phases.push('课程中段（10~30分钟）');
    if (hitLate)  phases.push('课程后段');

    return phases;
  }

  // ── 生成不足清单 ──────────────────────────────────────────
  function buildWeaknesses(analysis, scoreData) {
    const weaknesses = [];
    const { retention, comment } = scoreData;
    const slots = analysis.timeSlots || [];

    // 留存率合格线检查（优先显示）
    if (retention.retention10Rate !== null && !retention.retention10Pass) {
      weaknesses.push(
        `10分钟留存率不达标（${retention.retention10Rate}%，合格线≥${retention.threshold10}%），` +
        `课程开场至10分钟内学员流失过多`
      );
    }
    if (retention.retention30Rate !== null && !retention.retention30Pass) {
      weaknesses.push(
        `30分钟留存率不达标（${retention.retention30Rate}%，合格线≥${retention.threshold30}%），` +
        `10~30分钟段学员流失明显`
      );
    }

    if (retention.scoreConv5 === 0 && retention.rate5 > 0) {
      weaknesses.push(`5分钟转化率偏低（${retention.rate5}%，低于${retention.subject || ''}合格线），开场转化吸引力不足`);
    }
    if (retention.scoreConv30 === 0 && retention.rate30 > 0) {
      weaknesses.push(`30分钟转化率偏低（${retention.rate30}%，低于${retention.subject || ''}合格线），课程整体转化意愿有待提升`);
    }
    if (comment.positiveRatio < 40 && analysis.effective > 5) {
      weaknesses.push(`学员满意度偏低，好评占比仅 ${comment.positiveRatio}%，差评反馈较多`);
    }

    // 时段差评集中分析：找差评率高且有关键词的时段
    const badSlots = slots
      .filter(s => s.effective >= 3 && s.negative >= 2 && s.topNegKws.length > 0)
      .sort((a, b) => b.negativeRatio - a.negativeRatio)
      .slice(0, 3);

    for (const s of badSlots) {
      const kwStr = s.topNegKws.map(k => `「${k.kw}」×${k.count}`).join('、');
      weaknesses.push(
        `【${s.label}】差评集中（差评率 ${s.negativeRatio}%，共 ${s.negative} 条），` +
        `高频问题：${kwStr}`
      );
    }

    // 从全局高频差评关键词补充共性问题
    const negKwMap = {
      '语速快': '语速偏快，部分学员反映跟不上节奏',
      '听不懂': '知识点讲解有难度，部分学员表示听不明白',
      '例题太难': '例题难度偏高，与学员能力匹配度有待调整',
      '重难点不讲': '重难点讲解不足，学员对核心内容掌握存在困难',
      '无聊': '课堂氛围不够活跃，部分学员注意力难以集中',
      '听不清': '音频质量或讲话清晰度有待改善',
      '划水': '有学员认为课程含金量偏低，内容深度有待加强',
    };

    const negKws = analysis.topNegativeKeywords.map(k => k.kw);
    for (const [kw, desc] of Object.entries(negKwMap)) {
      if (negKws.some(h => h.includes(kw) || kw.includes(h))) {
        if (!weaknesses.some(s => s.includes(desc.slice(0, 5)))) {
          weaknesses.push(desc);
        }
      }
    }

    // 列出全部差评原文（同一人合并显示）
    const negComments = analysis.negativeComments || [];
    if (negComments.length > 0) {
      const { lines, groupCount } = formatCommentGroup(negComments);
      weaknesses.push(`── 差评原文（共 ${groupCount} 人头，${negComments.length} 条）──`);
      lines.forEach(l => weaknesses.push(l));
    }

    if (weaknesses.length === 0 && scoreData.total >= 80) {
      weaknesses.push('整体表现良好，暂无明显短板');
    } else if (weaknesses.length === 0) {
      weaknesses.push('评论数据不足，建议扩大数据采集量以更准确评估');
    }

    return weaknesses;
  }

  // ── 请老师自查 — 返回结构化分组，每组含 { id, icon, label, metricText, score, maxScore, level, items }
  // level: 'red'|'orange'|'yellow'|'green'，用于卡片左侧边框颜色
  function buildSuggestions(analysis, scoreData) {
    const groups = [];
    const { retention, comment } = scoreData;
    const negKws = analysis.topNegativeKeywords.map(k => k.kw);
    const subject = retention.subject || '';
    const tiers   = retention.convTiers;

    function scoreLevel(score, maxScore) {
      if (score === null || maxScore === null || maxScore === 0) return 'orange';
      const r = score / maxScore;
      if (r === 0)  return 'red';
      if (r < 0.6)  return 'orange';
      if (r < 0.8)  return 'yellow';
      return 'green';
    }

    // ── ① 30min转化率 ────────────────────────────────────────
    if (tiers) {
      const [t1, t2, t3] = tiers.conv30;
      const r30 = retention.rate30;

      if (r30 < t2) {
        const negSignals = [];
        if (negKws.some(kw => kw.includes('听不懂') || kw.includes('没听懂') || kw.includes('不明白'))) {
          const found = analysis.topNegativeKeywords.find(k => k.kw.includes('听不懂') || k.kw.includes('没听懂'));
          negSignals.push(`"听不懂"${found ? `（${found.count}次）` : ''}`);
        }
        if (negKws.some(kw => kw.includes('语速') || kw.includes('太快') || kw.includes('跟不上')))
          negSignals.push('"语速/跟不上"');
        if (negKws.some(kw => kw.includes('无聊') || kw.includes('枯燥')))
          negSignals.push('"无聊/枯燥"');
        if (negKws.some(kw => kw.includes('太难') || kw.includes('例题太难')))
          negSignals.push('"难度过高"');

        const items = r30 < t3 ? [
          `课程中后段（20~30分钟）内容是否有明显断层或节奏突变？`,
          `学员在哪个时间段开始批量退出（见不足之处时段）？对应讲的是什么内容？`,
          `课程结尾是否给学员留下了"下次想继续听"的动机？`,
        ] : [
          `课程中段（20~30分钟）的内容是否是本节课价值最高的部分？`,
          `收尾时学员的反馈状态是否有明显下滑？`,
        ];
        if (negSignals.length > 0)
          items.push(`结合评论区 ${negSignals.join('、')} 信号，核对这些信号出现的时段与转化率下滑节点是否吻合`);

        groups.push({
          id: 'conv30', icon: '📊',
          label:      subject ? `${subject}·30min转化率` : '30min转化率',
          metricText: r30 < t3 ? `${r30}% 低于合格线 ${t3}%` : `${r30}%（合格线 ${t3}% ~ 良好线 ${t2}%）`,
          score: retention.scoreConv30, maxScore: retention.maxConv30,
          level: scoreLevel(retention.scoreConv30, retention.maxConv30),
          items,
        });
      }
    }

    // ── ② 留存率 ─────────────────────────────────────────────
    if (retention.retention10Rate !== null && !retention.retention10Pass) {
      groups.push({
        id: 'ret5', icon: '👥',
        label:      '留存预警·5→10分钟',
        metricText: `${retention.retention10Rate}% 低于合格线 ${retention.threshold10}%`,
        score: retention.scoreRet5, maxScore: retention.maxRet5,
        level: scoreLevel(retention.scoreRet5, retention.maxRet5),
        items: [
          `前10分钟是否存在较多铺垫或非教学内容（设备调试/寒暄）？`,
          `评论区是否有学员提问"能不能快点进入正题"？`,
          `对比历史录像，前10分钟的节奏是否和往常有明显差异？`,
        ],
      });
    }
    if (retention.retention30Rate !== null && !retention.retention30Pass) {
      groups.push({
        id: 'ret30', icon: '👥',
        label:      '留存预警·10→30分钟',
        metricText: `${retention.retention30Rate}% 低于合格线 ${retention.threshold30}%`,
        score: retention.scoreRet30, maxScore: retention.maxRet30,
        level: scoreLevel(retention.scoreRet30, retention.maxRet30),
        items: [
          `这段时间内讲解的内容，是否有难度突然升高的情况？`,
          `是否有一段时间内学员评论明显减少甚至中断？`,
          `该时段是否有提问互动，学员的回应状态怎么样？`,
        ],
      });
    }

    // ── ③ 差评信号（合并为一张卡，按命中信号类型分组展示）──────
    const negSections = [];
    if (negKws.some(kw => kw.includes('语速') || kw.includes('太快') || kw.includes('跟不上'))) {
      negSections.push({
        title: '【语速过快/跟不上】',
        items: [
          `课堂中是否有学员提出"能不能慢一点"，当时是否有回应并调整？`,
          `本节课内容量是否比平时偏多，导致整体节奏压缩？`,
          `反映跟不上的评论集中在哪个时间段？那段在讲什么知识点？`,
        ],
      });
    }
    if (negKws.some(kw => kw.includes('听不懂') || kw.includes('没听懂') || kw.includes('不明白'))) {
      negSections.push({
        title: '【学员听不懂】',
        items: [
          `课堂中是否针对这些学员进行了答疑或重新讲解？讲了之后有没有学员反馈听懂了？`,
          `"听不懂"集中在哪个时间段？对应的知识点是否超出了本班学员基础？`,
          `这是个别学员基础薄弱，还是多数学员都有此反馈？两种情况处理方向不同`,
        ],
      });
    }
    if (negKws.some(kw => kw.includes('例题') || kw.includes('题目太难') || kw.includes('太复杂'))) {
      negSections.push({
        title: '【例题/题目偏难】',
        items: [
          `这道题是否超出了本节课宣传时对应的难度定位？`,
          `讲题前是否有铺垫必要前置知识？还是直接上手讲解过程？`,
          `讲完后评论区是否有"听懂了"的反馈，还是持续出现"没懂"？`,
        ],
      });
    }
    if (negKws.some(kw => kw.includes('无聊') || kw.includes('枯燥') || kw.includes('不想听'))) {
      negSections.push({
        title: '【课堂无聊/枯燥】',
        items: [
          `反映无聊的评论集中在哪个时段？那段讲的是什么内容，讲法上有何特点？`,
          `这节课和学员平时反馈较好的课，在内容形式上有什么差异？`,
          `是否有一段时间内课堂互动几乎中断，没有提问或弹幕回应？`,
        ],
      });
    }
    if (negKws.some(kw => kw.includes('听不清') || kw.includes('声音') || kw.includes('看不清') || kw.includes('ppt'))) {
      negSections.push({
        title: '【音视频不清晰】',
        items: [
          `课堂中是否有学员反映"听不清"，当时是否处理了（调音量/切线路等）？`,
          `如果是PPT看不清，是字太小还是画面模糊，两种原因处理方式不同`,
          `是课程开始就存在，还是中途突然出现？是否和网络或设备切换有关？`,
        ],
      });
    }
    // 口碑预警也作为一个信号节并入评论信号卡
    const hasRepWarn = comment.scoreRatio === 0 && (comment.positive + comment.negative) > 0;
    if (hasRepWarn) {
      negSections.push({
        title: '【口碑预警·差评≥好评】',
        items: [
          `对照上方差评原文，出现3次以上的问题是什么？这些问题在课堂中是否有处理过？`,
          `差评集中在哪个时间段？当时课堂上发生了什么？`,
          `这些差评是属于本节课特有的问题，还是历次课堂都有类似反馈？`,
        ],
      });
    }

    if (negSections.length > 0) {
      const signalLabels = negSections.map(s => s.title.replace(/【|】/g, '')).join('、');
      const flatItems = negSections.flatMap(sec => [
        sec.title,
        ...sec.items.map(item => `　　${item}`),
      ]);
      // 有口碑预警时评分显示 0/20，否则不显示分数
      const repScore    = hasRepWarn ? 0   : null;
      const repMaxScore = hasRepWarn ? 20  : null;
      const cardLevel   = hasRepWarn ? 'red' : 'orange';
      const metricExtra = hasRepWarn
        ? `好评 ${comment.positive} 条 · 差评 ${comment.negative} 条`
        : `命中：${signalLabels}`;
      groups.push({
        id: 'neg_signals', icon: '💬',
        label:      '评论区排查',
        metricText: metricExtra,
        score: repScore, maxScore: repMaxScore, level: cardLevel,
        items: flatItems,
      });
    }

    // ── 兜底 ─────────────────────────────────────────────────
    if (groups.length === 0) {
      const total = scoreData.total;
      groups.push({
        id: 'ok', icon: total >= 90 ? '🎉' : '✅',
        label:      total >= 90 ? '整体表现优秀' : '整体表现良好',
        metricText: `综合评分 ${total} 分`,
        score: null, maxScore: null, level: 'green',
        items: [total >= 90
          ? '本节课暂无明显需要排查的问题，继续保持'
          : '可结合上方不足之处，重点回顾转化率偏低时段的课程内容'],
      });
    }

    return groups;
  }

  // ── 生成完整文本报告 ─────────────────────────────────────
  function generateFullReport(teacherInfo, attendance, analysis, scoreData) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const { rating, total, retention, comment, feedback: fb, sameTeacher: st } = scoreData;
    // 报告内转化率统一截断两位小数
    const fmtR = (v) => {
      if (!v && v !== 0) return '—';
      const n = Math.trunc(Number(v) * 100) / 100;
      const [i, d = ''] = n.toString().split('.');
      return i + '.' + d.padEnd(2,'0').slice(0,2) + '%';
    };

    const strengths   = buildStrengths(analysis, scoreData);
    const weaknesses  = buildWeaknesses(analysis, scoreData);
    const suggestionGroups = buildSuggestions(analysis, scoreData);
    // 展开为文本行（供文本报告 / 旧接口使用）
    const suggestions = suggestionGroups.flatMap(g => [
      `【${g.label}】${g.metricText}${g.score !== null ? `（${g.score}/${g.maxScore}分）` : ''}`,
      ...g.items.map((item, i) => `  ${['①','②','③','④','⑤','⑥'][i] || (i+1+'.')} ${item}`),
    ]);

    const lines = [];

    lines.push('═══════════════════════════════════════════');
    lines.push('        课堂授课质量评价报告');
    lines.push('═══════════════════════════════════════════');
    lines.push(`生成时间：${dateStr}`);
    lines.push(`主讲老师：${teacherInfo.name    || '—'}`);
    lines.push(`授课学科：${teacherInfo.subject || '—'}`);
    lines.push(`年    级：${teacherInfo.grade   || '—'}`);
    lines.push(`开课星期：${teacherInfo.week    || '—'}`);
    lines.push('');

    const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

    lines.push('【综合评分】');
    lines.push(`总分：${f1(total)} / 100   评级：${rating.label}（${rating.desc}）`);
    lines.push(`  └─ 留存转化分：${f1(retention.total)} / 60`);
    lines.push(`       · 5分钟留存率   ${retention.ret5Rate  !== null ? retention.ret5Rate.toFixed(2)  + '%' : '—'}   得分 ${f1(retention.scoreRet5)}  / ${retention.maxRet5}`);
    lines.push(`       · 30分钟留存率  ${retention.ret30Rate !== null ? retention.ret30Rate.toFixed(2) + '%' : '—'}   得分 ${f1(retention.scoreRet30)} / ${retention.maxRet30}`);
    lines.push(`       · 5分钟转化率   ${fmtR(retention.rate5)}   得分 ${f1(retention.scoreConv5)}  / ${retention.maxConv5}`);
    lines.push(`       · 30分钟转化率  ${fmtR(retention.rate30)}   得分 ${f1(retention.scoreConv30)} / ${retention.maxConv30}`);
    lines.push(`  └─ 互动评论分：${f1(comment.total)} / 30`);
    lines.push(`       · 有效评论 ${comment.effectiveCount} 条  得分 ${f1(comment.scoreCount)} / ${comment.maxCount}`);
    lines.push(`       · 好差评比（正${comment.positive || 0} / 负${comment.negative || 0}）${comment.posNegRatio}%  得分 ${f1(comment.scoreRatio)} / ${comment.maxRatio}`);
    const stMax = (CONFIG.SAME_TEACHER_RATE || {}).maxScore || 10;
    if (st) {
      lines.push(`  └─ 同主讲转化率：${st.rate}%（${st.same}/${st.total} 单）  得分 ${f1(st.score)} / ${stMax}`);
    } else {
      lines.push(`  └─ 同主讲转化率：未填写  得分 0 / ${stMax}`);
    }

    if (fb) {
      lines.push(`  └─ 转化反馈分（原始）：${f1(fb.score)} / ${fb.maxScore}  [已归一化]`);
      lines.push(`       · 参与计算学员：${fb.total} 人  加权平均档次：${fb.avg}`);
      // 各档人数明细
      const tiers = (CONFIG.CONVERSION_FEEDBACK && CONFIG.CONVERSION_FEEDBACK.tiers) || [];
      const nums  = ['①','②','③','④','⑤'];
      const detail = fb.counts
        .map((c, i) => c > 0 ? `${nums[i]}${c}人` : null)
        .filter(Boolean).join('  ');
      if (detail) lines.push(`       · 各档明细：${detail}`);
    } else {
      lines.push(`  └─ 转化反馈：本场未收集，不参与评分`);
    }
    lines.push('');

    lines.push('【出勤数据汇总】');
    const a = attendance;
    const r = retention;
    if (a.min5Count)  lines.push(`直播出勤5分钟：${a.min5Count} 人`);
    if (a.min5Rate)   lines.push(`直播出勤5分钟转化率：${fmtR(a.min5Rate)}`);
    if (a.min10Count) lines.push(`直播出勤10分钟：${a.min10Count} 人`);
    if (a.min10Rate)  lines.push(`直播出勤10分钟转化率：${fmtR(a.min10Rate)}`);
    if (r.retention10Rate !== null) {
      const tag10 = r.retention10Pass ? '✅ 合格' : `❌ 不合格（合格线≥${r.threshold10}%）`;
      lines.push(`10分钟留存率：${r.retention10Rate}%  ${tag10}`);
    }
    if (a.min30Count) lines.push(`直播出勤30分钟：${a.min30Count} 人`);
    if (a.min30Rate)  lines.push(`直播出勤30分钟转化率：${fmtR(a.min30Rate)}`);
    if (r.retention30Rate !== null) {
      const tag30 = r.retention30Pass ? '✅ 合格' : `❌ 不合格（合格线≥${r.threshold30}%）`;
      lines.push(`30分钟留存率：${r.retention30Rate}%  ${tag30}`);
    }
    lines.push('');

    lines.push('【评论数据汇总】');
    lines.push(`总评论数：${analysis.total} 条`);
    lines.push(`有效评论：${analysis.effective} 条  |  过滤灌水：${analysis.noise} 条`);
    lines.push(`好评：${analysis.positive} 条  |  差评：${analysis.negative} 条  |  中性：${analysis.neutral} 条`);
    if (analysis.topPositiveKeywords.length > 0) {
      lines.push(`高频好评词：${analysis.topPositiveKeywords.map(k => `${k.kw}(${k.count})`).join('、')}`);
    }
    if (analysis.topNegativeKeywords.length > 0) {
      lines.push(`高频差评词：${analysis.topNegativeKeywords.map(k => `${k.kw}(${k.count})`).join('、')}`);
    }
    lines.push('');

    lines.push('【讲课优点】');
    strengths.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');

    lines.push('【不足之处】');
    weaknesses.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');

    lines.push('【请老师自查】');
    suggestionGroups.forEach((g, i) => {
      const scoreStr = g.score !== null ? `  得分 ${g.score}/${g.maxScore}` : '';
      lines.push(`${i + 1}. 【${g.label}】${g.metricText}${scoreStr}`);
      g.items.forEach((item, j) => {
        const num = ['①','②','③','④','⑤','⑥'][j] || `${j+1}.`;
        lines.push(`   ${num} ${item}`);
      });
      lines.push('');
    });

    // 同主讲转化率详情段落
    if (st) {
      lines.push('【同主讲转化率详情】');
      lines.push(`  上课主讲：${teacherInfo.name || '—'}`);
      lines.push(`  同主讲转化：${st.same} 单  其他主讲：${st.total - st.same} 单  合计：${st.total} 单`);
      lines.push(`  同主讲占比：${st.rate}%   得分：${f1(st.score)} / ${stMax}`);
      let stLevel = '';
      if      (st.rate >= 90) stLevel = '主讲吸引力极强，绝大多数学员认可并选择该老师';
      else if (st.rate >= 75) stLevel = '主讲吸引力较强，大多数学员愿意跟随该老师';
      else if (st.rate >= 60) stLevel = '主讲认可度一般，过半学员选择同主讲，仍有提升空间';
      else if (st.rate >= 40) stLevel = '主讲分流明显，需提升课堂影响力和个人品牌';
      else                     stLevel = '同主讲转化率偏低，建议深入分析原因';
      lines.push(`  综合评估：${stLevel}`);
      lines.push('');
    }

    // 转化反馈详情段落（有数据时生成）
    if (fb) {
      lines.push('【转化反馈详情】');
      const tiers = (CONFIG.CONVERSION_FEEDBACK && CONFIG.CONVERSION_FEEDBACK.tiers) || [];
      const nums  = ['①','②','③','④','⑤'];
      tiers.forEach((t, i) => {
        const cnt = fb.counts[i] || 0;
        const pct = fb.total > 0 ? Math.round(cnt / fb.total * 100) : 0;
        lines.push(`  ${nums[i]} ${t.label}：${cnt} 人（${pct}%）`);
      });
      lines.push(`  加权平均档次：${fb.avg} / 5.0   得分：${f1(fb.score)} / ${fb.maxScore}`);
      // 文字评级
      const avg = fb.avg;
      let fbLevel = '';
      if      (avg >= 4.5) fbLevel = '转化意愿强烈，整体口碑优秀';
      else if (avg >= 3.5) fbLevel = '转化意愿良好，多数学员认可';
      else if (avg >= 2.5) fbLevel = '转化意愿一般，需加强课程吸引力';
      else if (avg >= 1.5) fbLevel = '转化意愿偏低，课程说服力有待提升';
      else                  fbLevel = '转化效果不佳，需全面优化课程内容';
      lines.push(`  综合评估：${fbLevel}`);
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════');
    lines.push('  本报告由销转直播课数据诊断工具自动生成');
    lines.push('═══════════════════════════════════════════');

    return {
      text: lines.join('\n'),
      strengths,
      weaknesses,
      suggestions,
      suggestionGroups,
    };
  }

  return { generateFullReport, buildStrengths, buildWeaknesses, buildSuggestions };
})();
