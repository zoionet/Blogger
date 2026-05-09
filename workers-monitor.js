// =============================================================
// Workers Monitor v1.0
// Cloudflare Workers Runtime
//
// 功能概述：
//   - 定时拉取 Cloudflare Workers 运行指标（请求量、CPU 耗时、延迟、错误率）
//   - 可选集成 Blogger API v3，统计博客浏览量（今日 / 7 天 / 30 天 / 历史）
//   - 通过 Telegram Bot 推送每日报告和实时告警
//   - 支持 Telegram inline 按钮一键刷新最新数据
//   - KV 存储：OAuth 令牌缓存 / 告警冷却 / 今日 PV 基线 / 最新消息 ID
// =============================================================
"use strict";

// 外部 API 地址常量（不可修改）
const STATIC = Object.freeze({
  CF_GRAPHQL_URL:  "https://api.cloudflare.com/client/v4/graphql",
  TG_API_BASE:     "https://api.telegram.org",
  BLOGGER_API:     "https://www.googleapis.com/blogger/v3",
  OAUTH_TOKEN_URL: "https://oauth2.googleapis.com/token",
});

// Workers 免费额度（每 UTC 自然日重置）
const QUOTA = Object.freeze({
  REQUESTS_DAY: 100_000,
});

// 各项指标的告警阈值
const THRESHOLD = Object.freeze({
  REQ_NOTICE:         0.60,   // 请求量提示阈值（占免费额度比例）
  REQ_WARN:           0.70,   // 请求量预警阈值
  REQ_ALERT:          0.90,   // 请求量紧急告警阈值
  CPU_WARN_MS:        7,      // CPU 耗时预警（毫秒，P50/P99 共用）
  CPU_ALERT_MS:       10,     // CPU 耗时紧急告警（毫秒，P50/P99 共用）
  CPU_P999_WARN_MS:   50,     // CPU P999 预警（毫秒）—— P999 天然高于 P99，使用独立阈值
  CPU_P999_ALERT_MS:  100,    // CPU P999 紧急告警（毫秒）
  ERR_WARN:           0.01,   // 错误率预警（1%）
  ERR_ALERT:          0.05,   // 错误率紧急告警（5%）
  DUR_WARN_MS:        500,    // 请求延迟预警（毫秒）
  DUR_ALERT_MS:       2000,   // 请求延迟紧急告警（毫秒）
  REM_WARN_HOURS:     8,      // 剩余额度预警时长（小时）
  REM_ALERT_HOURS:    4,      // 剩余额度紧急告警时长（小时）
  SUBREQ_WARN:        30,     // 平均出站请求预警（次/请求）
  SUBREQ_ALERT:       45,     // 平均出站请求紧急告警（次/请求）
  OFFLINE_UTC_HOUR:   2,      // UTC 几点之后，0 请求才视为"疑似离线"
  TREND_PCT:          0.05,   // Blogger 流量趋势判断偏差阈值（5%）
});

// 健康评分各维度权重（总计 1.0）
const HEALTH_WEIGHT = Object.freeze({
  ERROR: 0.40,   // 错误率权重（最高，直接影响用户体验）
  CPU:   0.30,   // CPU 耗时权重
  DUR:   0.15,   // 请求延迟权重
  QUOTA: 0.15,   // 额度消耗权重
});

// 告警冷却时间（同级别告警至少间隔 2 小时，防止消息轰炸）
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// KV 存储 Key 定义（集中管理，避免散落在代码各处）
const KV_KEY = Object.freeze({
  BLOGGERDAYBASEPREFIX:  "blogger_day_base",       // 北京时间日基线，格式：blogger_day_base:YYYY-MM-DD
  BLOGGERREPORTSNAPSHOT: "blogger_report_snapshot", // 日报快照（仅记录，不参与今日 PV 计算）
  LATESTMSGID:           "latest_message_id",       // 最新日报 Telegram 消息 ID
  LASTALERT:             "last_alert",              // 最近一次告警记录（级别 + 时间戳）
  OAUTHTOKEN:            "oauth_access_token",      // Blogger OAuth 访问令牌缓存
  LASTOFFLINE:           "last_offline_alert",      // 离线告警发送时间（按 Worker 分 Key）
});

// =============================================================
// 区块 1：配置解析 / 环境校验 / 通用工具函数
// =============================================================

/**
 * 解析 WORKERS_CONFIG 环境变量（JSON 数组格式）
 *
 * 数组每项格式：
 *   { "name": "my-worker", "alias": "可选别名", "critical": true }
 *
 * - name：Worker 脚本名称（必填，需与 CF 后台一致）
 * - alias：消息中显示的友好名称（可选，默认同 name）
 * - critical：是否为关键 Worker（影响健康评分上限和离线告警触发）
 */
function parseWorkersConfig(env) {
  const raw = env.WORKERS_CONFIG ?? "[]";
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0)
      throw new Error("WORKERS_CONFIG 不能为空数组");
    const filtered = list.filter(w => w.name?.trim());
    if (filtered.length === 0)
      throw new Error("WORKERS_CONFIG 中所有条目均缺少有效的 name 字段");
    return filtered.map(w => ({
      name:     w.name.trim(),
      alias:    (w.alias ?? w.name).trim(),
      critical: w.critical === true,
    }));
  } catch (e) {
    throw new Error("WORKERS_CONFIG JSON 格式错误：" + e.message);
  }
}

/**
 * 校验必填环境变量，任意缺失时抛出异常终止执行
 *
 * 必填项说明：
 *   CF_ACCOUNT_ID       Cloudflare 账户 ID
 *   CF_API_TOKEN        CF API Token（需要 Workers:Read 权限）
 *   TG_BOT_TOKEN        Telegram Bot Token
 *   TG_CHAT_ID          Telegram 推送目标 Chat ID
 *
 * 可选项（未配置时相关功能自动降级）：
 *   MANUAL_TOKEN        手动触发鉴权 Token
 *   WORKERS_CONFIG      Worker 列表（JSON 数组）
 *   SITE_NAME           站点名称（显示在消息标题）
 *   KV                  KV 命名空间绑定（用于缓存和状态存储）
 *   TG_WEBHOOK_SECRET   Telegram Webhook 安全密钥（防止伪造回调）
 *   BLOGGER_*           Blogger OAuth 相关（四项须同时配置）
 */
function validateEnv(env) {
  const required = [
    "CF_ACCOUNT_ID",
    "CF_API_TOKEN",
    "TG_BOT_TOKEN",
    "TG_CHAT_ID",
  ];
  const missing = required.filter(k => !env[k]);
  if (missing.length > 0) throw new Error("缺少必填配置项：" + missing.join(", "));
  // Blogger / KV 属于增强能力：不强制阻止基础监控，但若启用则必须完整配置
}

/** 数字格式化：加千分位分隔符，undefined/null 视为 0 */
function fmtNum(n) {
  return String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 毫秒格式化，保留两位小数，例如：3.14ms */
function fmtMs(ms) {
  return (+(ms ?? 0)).toFixed(2) + "ms";
}

/** 计算百分比字符串，分母为 0 时返回 "0.00%" */
function pct(num, den) {
  if (!den) return "0.00%";
  return ((num / den) * 100).toFixed(2) + "%";
}

/** 微秒转毫秒（Cloudflare CPU 时间单位为 µs，需转换后展示） */
function usToMs(us) {
  return parseFloat(((us ?? 0) / 1000).toFixed(2));
}

/**
 * HTML 特殊字符转义
 * Telegram HTML 模式支持有限标签（b/i/code/pre/a），其余需转义
 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 状态图标函数 ----------

/** CPU 耗时图标（P50 / P99 使用，阈值：7ms / 10ms） */
function cpuIcon(ms) {
  if (ms >= THRESHOLD.CPU_ALERT_MS) return "🔴";
  if (ms >= THRESHOLD.CPU_WARN_MS)  return "🟡";
  return "🟢";
}

/**
 * CPU P999 图标（最坏 0.1% 情况）
 * P999 天然高于 P99，使用独立且更宽松的阈值（50ms / 100ms），
 * 避免与 P99 共用阈值导致 CPU Max 行几乎永远显示红色
 */
function cpuMaxIcon(ms) {
  if (ms >= THRESHOLD.CPU_P999_ALERT_MS) return "🔴";
  if (ms >= THRESHOLD.CPU_P999_WARN_MS)  return "🟡";
  return "🟢";
}

/** 错误率图标（阈值：1% / 5%） */
function errIcon(rate) {
  if (rate >= THRESHOLD.ERR_ALERT) return "🔴";
  if (rate >= THRESHOLD.ERR_WARN)  return "🟡";
  return "🟢";
}

/** 请求额度占比图标 */
function reqIcon(ratio) {
  if (ratio >= THRESHOLD.REQ_ALERT) return "🔴";
  if (ratio >= THRESHOLD.REQ_WARN)  return "🟡";
  return "🟢";
}

/** 剩余额度预计耗尽时长图标 */
function remIcon(hoursLeft) {
  if (hoursLeft < THRESHOLD.REM_ALERT_HOURS) return "🔴";
  if (hoursLeft < THRESHOLD.REM_WARN_HOURS)  return "🟡";
  return "🟢";
}

/** 请求延迟图标（阈值：500ms / 2000ms） */
function durIcon(ms) {
  if (ms >= THRESHOLD.DUR_ALERT_MS) return "🔴";
  if (ms >= THRESHOLD.DUR_WARN_MS)  return "🟡";
  return "🟢";
}

/** 平均出站请求数图标（阈值：30 / 45 次/请求） */
function subIcon(avg) {
  if (avg >= THRESHOLD.SUBREQ_ALERT) return "🔴";
  if (avg >= THRESHOLD.SUBREQ_WARN)  return "🟡";
  return "🟢";
}

// =============================================================
// 区块 2：时间工具函数
// =============================================================

/**
 * 将 UTC 时间对象偏移为北京时间（UTC+8）
 * 北京不实行夏令时，偏移量固定为 +8 小时，直接加毫秒数即可
 */
function getBeijingDate(now) {
  return new Date(now.getTime() + 8 * 3_600_000);
}

/** 返回北京时间日期字符串，格式：YYYY-MM-DD */
function getBeijingDateStr(now) {
  const bj = getBeijingDate(now);
  const y  = bj.getUTCFullYear();
  const mo = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const d  = String(bj.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * 返回 UTC 日期字符串，格式：YYYY-MM-DD
 * Workers 免费额度按 UTC 自然日计算，使用此函数标注额度口径
 */
function getUtcDateStr(now) {
  const y  = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d  = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * 计算给定北京时间日期的前一天日期字符串
 * 用于今日 PV 基线的"昨日顺延"策略
 *
 * @param {string} bjDateStr  格式必须为 YYYY-MM-DD
 * @throws {Error} 若输入日期格式无效（防止产生 NaN KV Key 污染命名空间）
 */
function getPreviousBeijingDateStr(bjDateStr) {
  const t = new Date(`${bjDateStr}T00:00:00+08:00`).getTime() - 86_400_000;
  if (isNaN(t)) throw new Error("无效的北京时间日期字符串：" + bjDateStr);
  return getBeijingDateStr(new Date(t));
}

/** 返回北京时间的短格式，例如：2025-01-15 23:55 (北京时间) */
function fmtBjShort(now) {
  const bj = getBeijingDate(now);
  return [
    bj.getUTCFullYear(),
    String(bj.getUTCMonth() + 1).padStart(2, "0"),
    String(bj.getUTCDate()).padStart(2, "0"),
  ].join("-") + " " +
  String(bj.getUTCHours()).padStart(2, "0")   + ":" +
  String(bj.getUTCMinutes()).padStart(2, "0") + " (北京时间)";
}

/** 返回 UTC 时间的短格式，例如：15:55 UTC */
function fmtUtcShort(now) {
  return String(now.getUTCHours()).padStart(2, "0")   + ":" +
         String(now.getUTCMinutes()).padStart(2, "0") + " UTC";
}

/**
 * 返回距下次 UTC 0:00 额度重置的倒计时文案
 * Workers 免费额度按 UTC 日重置，对应北京时间每天 08:00
 */
function fmtResetCountdown(now) {
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ));
  const totalMin = Math.floor((nextReset - now) / 60_000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return hh > 0
    ? `${hh} 小时 ${mm} 分后 (UTC 0:00 / 北京 08:00)`
    : `${mm} 分后 (UTC 0:00 / 北京 08:00)`;
}

/**
 * 构建 CloudFlare GraphQL 查询的 UTC 时间窗口（当天 00:00 ~ 次日 00:00）
 * Workers 额度统计以 UTC 为基准，查询窗口与额度重置时间对齐
 */
function buildTimeWindow(now) {
  const dayStart  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startTime = dayStart.toISOString().replace(".000Z", "Z");
  const endTime   = new Date(dayStart.getTime() + 86_400_000).toISOString().replace(".000Z", "Z");
  return { startTime, endTime };
}

/** 获取站点名称（来自环境变量 SITE_NAME，默认值 "ZOIO.NET"，全大写展示） */
function getSiteName(env) {
  return (env.SITE_NAME ?? "ZOIO.NET").trim().toUpperCase();
}

// =============================================================
// 区块 3：健康评分
// =============================================================

/**
 * 综合健康评分（0 ~ 100 分）
 *
 * 算法说明：
 *   1. 对错误率、CPU 耗时、延迟、额度消耗分别调用 segScore 计算分段得分
 *   2. 取各 Worker 与账户总量中最坏的指标值，防止个别 Worker 异常被总量稀释
 *   3. 按权重加权求和（权重总计 1.0）
 *   4. 若 critical Worker 触发红线（含 UTC 02:00 后零请求），分数上限压至 49
 *
 * 评级区间：
 *   [90, 100] 🟢 运行正常
 *   [75,  89] 🟡 轻微波动
 *   [50,  74] 🟠 性能退化
 *   [ 0,  49] 🔴 服务异常
 *
 * @param {object} total    账户级汇总数据
 * @param {Array}  workers  各 Worker 明细数据
 * @param {Date}   now      当前时间（用于 UTC 早晨保护判断）
 */
function calcHealthScore(total, workers, now) {
  // 取账户总量与所有 Worker 中最差的各项指标
  const worstCpuP99  = workers.reduce((m, w) => Math.max(m, w.cpuP99    ?? 0), total.cpuP99    ?? 0);
  const worstErrRate = workers.reduce((m, w) => Math.max(m, w.errorRate ?? 0), total.errorRate ?? 0);
  const worstDurP99  = workers.reduce((m, w) => Math.max(m, w.durP99    ?? 0), total.durP99    ?? 0);
  const ratio = total.ratio ?? 0;

  /**
   * 分段线性评分函数
   *   value < warn ：从 100 线性降至 80（轻微劣化）
   *   warn ≤ value < alert：从 80 线性降至 0（快速恶化）
   *   value ≥ alert：固定 0 分
   */
  function segScore(value, warn, alert) {
    if (value >= alert) return 0;
    if (value >= warn)  return Math.max(0, Math.round(80 * (1 - (value - warn) / (alert - warn))));
    return Math.round(100 - 20 * (value / warn));
  }

  const sErr   = segScore(worstErrRate, THRESHOLD.ERR_WARN,  THRESHOLD.ERR_ALERT);
  const sCpu   = segScore(worstCpuP99,  THRESHOLD.CPU_WARN_MS, THRESHOLD.CPU_ALERT_MS);
  const sDur   = segScore(worstDurP99,  THRESHOLD.DUR_WARN_MS, THRESHOLD.DUR_ALERT_MS);
  const sQuota = segScore(ratio,        THRESHOLD.REQ_WARN,   THRESHOLD.REQ_ALERT);

  let score = Math.round(
    sErr   * HEALTH_WEIGHT.ERROR +
    sCpu   * HEALTH_WEIGHT.CPU   +
    sDur   * HEALTH_WEIGHT.DUR   +
    sQuota * HEALTH_WEIGHT.QUOTA
  );

  // critical Worker 触发红线时，强制将健康分压制到 49（触发"服务异常"评级）
  // 注意：UTC 0 ~ OFFLINEUTCHOUR 为额度重置后的保护窗口，此段内 0 请求属正常现象，不视为离线
  const utcHour = now.getUTCHours();
  const hasCriticalDown = workers.some(w =>
    w.critical && (
      w.cpuP99    >= THRESHOLD.CPU_ALERT_MS  ||
      w.errorRate >= THRESHOLD.ERR_ALERT    ||
      w.durP99    >= THRESHOLD.DUR_ALERT_MS  ||
      // 保护窗口结束后请求数仍为 0，才视为离线
      (w.requests === 0 && utcHour >= THRESHOLD.OFFLINE_UTC_HOUR)
    )
  );
  if (hasCriticalDown) score = Math.min(score, 49);

  let level, icon;
  if      (score >= 90) { level = "运行正常"; icon = "🟢"; }
  else if (score >= 75) { level = "轻微波动"; icon = "🟡"; }
  else if (score >= 50) { level = "性能退化"; icon = "🟠"; }
  else                  { level = "服务异常"; icon = "🔴"; }

  return { score, level, icon };
}

// =============================================================
// 区块 4：网络请求工具（带指数退避重试）
// =============================================================

/**
 * 带指数退避重试的 fetch 封装
 *
 * 重试策略：
 *   - 5xx 服务端错误 和 网络异常（如超时）：触发重试
 *   - 4xx 客户端错误：不重试（配置问题，重试无意义，直接返回交由上层处理）
 *   - 延迟规则：第 1 次重试等待 delayMs，第 2 次等待 2×delayMs（指数退避）
 *
 * @param {string}      url
 * @param {RequestInit} options
 * @param {number}      maxRetries  最大重试次数，默认 2
 * @param {number}      delayMs     首次重试延迟（毫秒），默认 600
 */
async function fetchWithRetry(url, options, maxRetries = 2, delayMs = 600) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(url, options);
      // 4xx 不重试，直接返回
      if (resp.ok || (resp.status >= 400 && resp.status < 500)) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < maxRetries) {
      // 指数退避：第 i+1 次重试前等待 (i+1) × delayMs 毫秒
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// =============================================================
// 区块 5：Cloudflare GraphQL 数据拉取与解析
// =============================================================

/**
 * 构建 Cloudflare Workers Analytics GraphQL 查询体
 *
 * 查询说明：
 *   totalStats  - 账户级汇总（limit:1 即可，聚合统计不受条数约束）
 *   workerStats - 逐 Worker 明细（limit:10000 避免账户 Worker 数超 100 时漏报）
 *
 * 时间窗口：UTC 自然日（与 Workers 免费额度重置周期一致）
 */
function buildCFQuery(accountId, startTime, endTime) {
  const query = `
    query WorkersMonitor($accountTag: String!, $start: String!, $end: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          totalStats: workersInvocationsAdaptive(
            limit: 1
            filter: { datetime_geq: $start, datetime_lt: $end }
          ) {
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 durationP50 durationP99 }
          }
          workerStats: workersInvocationsAdaptive(
            limit: 10000
            filter: { datetime_geq: $start, datetime_lt: $end }
          ) {
            dimensions { scriptName }
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 durationP50 durationP99 }
          }
        }
      }
    }
  `;
  return { query, variables: { accountTag: accountId, start: startTime, end: endTime } };
}

/**
 * 调用 Cloudflare GraphQL API 获取账户级 Workers 统计数据
 *
 * @returns {object} rawAccount - GraphQL accounts[0] 原始数据
 * @throws  拉取失败或响应含 errors 时抛出异常
 */
async function fetchCFAnalytics(accountId, apiToken, startTime, endTime) {
  const resp = await fetchWithRetry(STATIC.CF_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiToken,
      "User-Agent": "Workers-Monitor/1.0",
    },
    body: JSON.stringify(buildCFQuery(accountId, startTime, endTime)),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CF GraphQL HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.errors?.length) {
    throw new Error("CF GraphQL 错误: " + data.errors.map(e => e.message).join("; "));
  }
  const account = data?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("CF GraphQL 未返回账户数据");
  return account;
}

/**
 * 将单个 Worker 的原始 GraphQL 数据解析为标准化统计对象
 *
 * 单位说明：
 *   cpuTimeP50/P99/P999 - 微秒（µs），经 usToMs 转换为毫秒
 *   durationP50/P99      - 毫秒（ms），直接使用
 */
function parseWorkerStats(raw, name) {
  const s        = raw?.sum ?? {};
  const q        = raw?.quantiles ?? {};
  const requests = s.requests ?? 0;
  const errors   = s.errors   ?? 0;
  return {
    name,
    requests,
    errors,
    subrequests: s.subrequests ?? 0,
    // requests 为 0 时错误率视为 0（避免 0/0 产生 NaN）
    errorRate:   requests > 0 ? errors / requests : 0,
    cpuP50:      usToMs(q.cpuTimeP50),
    cpuP99:      usToMs(q.cpuTimeP99),
    cpuP999:     usToMs(q.cpuTimeP999),
    durP50:      parseFloat((q.durationP50 ?? 0).toFixed(2)),
    durP99:      parseFloat((q.durationP99 ?? 0).toFixed(2)),
  };
}

/**
 * 将 GraphQL 原始账户数据转为结构化统计对象
 *
 * 输出结构：
 *   total   - 账户级汇总，附加 ratio（已用额度占比）
 *   workers - 各 Worker 明细，附加 alias/critical/shareRatio/quotaRatio
 */
function processCFData(rawAccount, workerConfigs) {
  // 解析账户总量
  const totalRaw  = rawAccount.totalStats?.[0];
  const baseTotal = parseWorkerStats(totalRaw, "account");
  const total     = { ...baseTotal, ratio: baseTotal.requests / QUOTA.REQUESTS_DAY };

  // 将 GraphQL 返回的 workerStats 转为 Map 便于按 scriptName 查找
  const rawMap = new Map();
  for (const item of rawAccount.workerStats ?? []) {
    const n = item.dimensions?.scriptName;
    if (n) rawMap.set(n, item);
  }

  // 按配置中声明的 Worker 列表逐一解析，未出现在 GraphQL 返回中的 Worker 请求量视为 0
  const workers = workerConfigs.map(cfg => {
    const w = parseWorkerStats(rawMap.get(cfg.name), cfg.name);
    return {
      ...w,
      alias:      cfg.alias,
      critical:   cfg.critical,
      // 该 Worker 占账户总请求的比例
      shareRatio: total.requests > 0 ? w.requests / total.requests : 0,
      // 该 Worker 消耗的免费额度比例
      quotaRatio: w.requests / QUOTA.REQUESTS_DAY,
    };
  });

  return { total, workers };
}

// =============================================================
// 区块 6：OAuth 2.0 令牌管理
// =============================================================

/**
 * 检查是否配置了完整的 Blogger OAuth 信息
 * 四项必须同时存在，缺一不可
 */
function hasBloggerOAuth(env) {
  return !!(
    env.BLOGGER_BLOG_ID       &&
    env.BLOGGER_CLIENT_ID     &&
    env.BLOGGER_CLIENT_SECRET &&
    env.BLOGGER_REFRESH_TOKEN
  );
}

/**
 * 获取 Blogger OAuth 2.0 访问令牌
 *
 * 缓存策略：
 *   优先从 KV 读取已缓存的令牌，在过期前 120 秒即视为过期并提前刷新，
 *   避免令牌在 API 调用途中恰好失效。
 *   KV 不可用时，每次执行均重新向 Google 换取新令牌。
 */
async function getOAuthAccessToken(env) {
  const kv = env.KV;

  // 优先读取 KV 缓存
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY.OAUTHTOKEN);
      if (cached) {
        const { token, expiry } = JSON.parse(cached);
        // 提前 120 秒判定为过期
        if (token && Date.now() < expiry - 120_000) return token;
      }
    } catch {
      // KV 读取失败时静默降级，继续刷新令牌
    }
  }

  // 使用 Refresh Token 向 Google OAuth 换取新的 Access Token
  const resp = await fetchWithRetry(STATIC.OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     env.BLOGGER_CLIENT_ID,
      client_secret: env.BLOGGER_CLIENT_SECRET,
      refresh_token: env.BLOGGER_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Blogger OAuth Token 获取失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (data.error) {
    throw new Error(`Blogger OAuth Token 错误：${data.error} - ${data.error_description ?? ""}`);
  }
  if (!data.access_token) {
    throw new Error("Blogger OAuth 返回数据异常：缺少 access_token");
  }

  // 将新令牌写入 KV，TTL 与令牌实际有效期保持一致
  if (kv) {
    const expiresIn = data.expires_in ?? 3600;
    const expiry    = Date.now() + expiresIn * 1000;
    await kv.put(
      KV_KEY.OAUTHTOKEN,
      JSON.stringify({ token: data.access_token, expiry }),
      { expirationTtl: expiresIn }
    ).catch(() => {});
  }
  return data.access_token;
}

// =============================================================
// 区块 7：Blogger API 数据拉取
// =============================================================

/**
 * 调用 Blogger Pageviews API 获取指定时间范围的 PV 总量
 *
 * @param {string} range  时间范围参数：all / 7DAYS / 30DAYS
 * @returns {number} 该范围内的 PV 总计
 */
async function fetchBloggerPV(blogId, accessToken, range) {
  const url  = `${STATIC.BLOGGER_API}/blogs/${blogId}/pageviews?range=${range}`;
  const resp = await fetchWithRetry(url, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "Workers-Monitor/1.0",
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Blogger API HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  // counts 数组中每项包含 { count: string, timeRange: object }
  return (data.counts ?? []).reduce((sum, item) => sum + parseInt(item.count ?? 0, 10), 0);
}

/**
 * 并行拉取 Blogger 全量、7 天、30 天 PV 数据
 * 同时计算 7 天和 30 天日均值，供报表展示和趋势判断使用
 */
async function fetchBloggerStats(blogId, env) {
  const accessToken = await getOAuthAccessToken(env);
  const [total, pv7, pv30] = await Promise.all([
    fetchBloggerPV(blogId, accessToken, "all"),
    fetchBloggerPV(blogId, accessToken, "7DAYS"),
    fetchBloggerPV(blogId, accessToken, "30DAYS"),
  ]);
  return {
    total,
    pv7,
    pv30,
    avg7:  Math.round(pv7  / 7),
    avg30: Math.round(pv30 / 30),
  };
}

// =============================================================
// 区块 8：Blogger 今日浏览量（北京时间日基线模型）
// =============================================================

/**
 * 今日浏览量计算原理
 * ─────────────────────────────────────────────────────────
 * 在 KV 中存储当天北京时间 00:00 的 PV 总量基线。
 * 今日 PV = 当前 Blogger 总量 - 当天基线
 *
 * 基线建立策略（优先级从高到低）：
 *   ① 当天基线已存在          → 直接使用（正常情况）
 *   ② 昨天基线存在            → 以昨天基线"顺延"到今天（跨日首次执行）
 *   ③ 两者均无（冷启动）       → 以当前总量为基线（首次今日 PV 显示 0，次次起正常）
 *
 * 日报快照（blogger_report_snapshot）与此基线完全分离，互不干扰，
 * 从根本上避免了旧版日报发送后今日 PV 接近 0 的问题。
 */

/** 生成日基线的 KV Key，例如：blogger_day_base:2025-01-15 */
function buildBloggerDayBaseKVKey(bjDate) {
  return `${KV_KEY.BLOGGERDAYBASEPREFIX}:${bjDate}`;
}

/** 从 KV 读取指定日期的基线快照，Key 不存在或读取失败时返回 null */
async function getBloggerDayBaseSnapshot(kv, bjDate) {
  try {
    const raw = await kv.get(buildBloggerDayBaseKVKey(bjDate));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 将基线快照写入 KV
 * @param {string} source  基线来源标记：seed / carry-forward / cold-start
 * 保留 14 天，覆盖足够的回溯需求
 */
async function saveBloggerDayBaseSnapshot(kv, bjDate, total, source = "seed") {
  await kv.put(
    buildBloggerDayBaseKVKey(bjDate),
    JSON.stringify({ date: bjDate, total, source, savedAt: new Date().toISOString() }),
    { expirationTtl: 14 * 24 * 3600 }
  );
}

/**
 * 将日报发送时的 PV 快照写入 KV
 * 仅用于留档记录，不参与今日 PV 计算
 */
async function savePVSnapshot(kv, bjDate, total) {
  await kv.put(
    KV_KEY.BLOGGERREPORTSNAPSHOT,
    JSON.stringify({ date: bjDate, total, savedAt: new Date().toISOString() }),
    { expirationTtl: 14 * 24 * 3600 }
  );
}

/**
 * 确保当天北京时间日基线存在
 * 若不存在则按优先级尝试创建（顺延 → 冷启动）
 */
async function ensureBloggerDayBase(kv, bloggerTotal, bjDate) {
  // 当天基线已存在，直接返回
  const existed = await getBloggerDayBaseSnapshot(kv, bjDate);
  if (existed) return existed;

  // 尝试从昨天基线顺延
  const prevDate = getPreviousBeijingDateStr(bjDate);
  const prevBase = await getBloggerDayBaseSnapshot(kv, prevDate);
  if (prevBase && typeof prevBase.total === "number") {
    await saveBloggerDayBaseSnapshot(kv, bjDate, prevBase.total, "carry-forward");
    return { date: bjDate, total: prevBase.total, source: "carry-forward" };
  }

  // 冷启动：以当前总量为基线，本次今日 PV 将显示 0，下次起正常
  await saveBloggerDayBaseSnapshot(kv, bjDate, bloggerTotal, "cold-start");
  return { date: bjDate, total: bloggerTotal, source: "cold-start" };
}

/**
 * 计算今日（北京时间自然日）新增 PV
 *
 * @returns {{ todayPV: number|null, status: string, baseDate: string }}
 *
 * status 说明：
 *   ok       - 计算正常，todayPV 有效
 *   cold     - 冷启动，基线刚建立，todayPV 为 null
 *   anomaly  - 异常，当前总量小于基线（如 API 数据回退），todayPV 为 null
 *   error    - 计算过程异常，todayPV 为 null
 *   nokv     - 未绑定 KV，无法计算
 */
async function calcTodayPV(kv, todayTotal, bjDate) {
  try {
    const base = await ensureBloggerDayBase(kv, todayTotal, bjDate);
    if (!base || typeof base.total !== "number") {
      return { todayPV: null, status: "cold", baseDate: bjDate };
    }
    const diff = todayTotal - base.total;
    // diff 为负表示数据异常（Blogger API 统计值回退），不展示负数
    if (diff < 0) return { todayPV: null, status: "anomaly", baseDate: bjDate };
    return {
      todayPV:  diff,
      // cold-start：基线刚以当前总量建立，diff=0 是真实值，直接显示。
      // 下次执行时基线已存在，计算结果即为真实今日增量。
      status:   "ok",
      baseDate: bjDate,
    };
  } catch {
    return { todayPV: null, status: "error", baseDate: bjDate };
  }
}

// =============================================================
// 区块 9：统一数据拉取
// =============================================================

/**
 * 并行拉取所有监控数据（CF + Blogger），计算健康评分和今日 PV
 *
 * 时间口径说明：
 *   reportDateBj  - 北京时间自然日（用于消息标题、今日 PV 基线、日报快照 Key）
 *   quotaDateUtc  - UTC 自然日（用于 Workers 免费额度统计标注）
 *   GraphQL 窗口  - UTC 00:00 ~ 24:00（与额度重置周期对齐）
 *
 * Blogger 拉取失败时自动降级为 null，不影响 CF 监控主流程
 *
 * @returns {{ cfData, blogger, todayPVResult, health, startTime, endTime, reportDateBj, quotaDateUtc }}
 */
async function fetchAllData(env, workerConfigs, now) {
  const kv           = env.KV;
  const reportDateBj = getBeijingDateStr(now);
  const quotaDateUtc = getUtcDateStr(now);
  const { startTime, endTime } = buildTimeWindow(now);

  // CF 与 Blogger 并行发起，互不阻塞
  const [rawAccount, bloggerResult] = await Promise.allSettled([
    fetchCFAnalytics(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, startTime, endTime),
    hasBloggerOAuth(env) ? fetchBloggerStats(env.BLOGGER_BLOG_ID, env) : Promise.resolve(null),
  ]);

  // CF 数据是核心依赖，失败时整体抛出（触发错误通知）
  if (rawAccount.status === "rejected") {
    throw new Error(rawAccount.reason?.message ?? String(rawAccount.reason));
  }

  const cfData  = processCFData(rawAccount.value, workerConfigs);
  // Blogger 失败时降级为 null，报表中相关模块自动隐藏
  const blogger = bloggerResult.status === "fulfilled" ? bloggerResult.value : null;

  // 今日 PV 需要 Blogger 数据 + KV 双重支持，两者缺一则标记为 nokv 或不计算
  let todayPVResult = { todayPV: null, status: kv ? "cold" : "nokv", baseDate: reportDateBj };
  if (blogger && kv) {
    todayPVResult = await calcTodayPV(kv, blogger.total, reportDateBj);
  }

  // 健康评分需要传入 now，以区分 UTC 早晨保护时段
  const health = calcHealthScore(cfData.total, cfData.workers, now);

  return { cfData, blogger, todayPVResult, health, startTime, endTime, reportDateBj, quotaDateUtc };
}

// =============================================================
// 区块 10：消息模板渲染
// =============================================================

/**
 * Worker 序号圈数字（支持 10 个，超出后自动回退为 #N 格式）
 * 例如：❶ ❷ ... ❿ #11 #12 ...
 */
const CIRCLED_NUM = ["❶","❷","❸","❹","❺","❻","❼","❽","❾","❿"];

/**
 * 构建单个 Worker 的详细数据块
 * 包含：请求量 / CPU P50-P99-P999 / 延迟 P50-P99 / 错误率 / 出站请求
 *
 * 注意：CPU Max（P999）使用独立的 cpuMaxIcon，阈值更宽松（50ms / 100ms）
 */
function buildWorkerBlock(w, idx) {
  const num     = CIRCLED_NUM[idx] ?? `#${idx + 1}`;
  const critTag = w.critical ? " 🔸" : "";
  // 平均每次请求产生的出站子请求数
  const avgSub  = w.requests > 0 ? (w.subrequests / w.requests).toFixed(1) : "0.0";
  return [
    `${num} ${esc(w.alias)}${critTag} · ${esc(w.name)}`,
    `[${reqIcon(w.quotaRatio)}] 请求： ${fmtNum(w.requests)} 次  (账户占比 ${(w.shareRatio * 100).toFixed(1)}%)`,
    `[${cpuIcon(w.cpuP50)}] CPU P50： ${fmtMs(w.cpuP50)}`,
    `[${cpuIcon(w.cpuP99)}] CPU P99： ${fmtMs(w.cpuP99)}`,
    `[${cpuMaxIcon(w.cpuP999)}] CPU Max： ${fmtMs(w.cpuP999)}`,
    `[${durIcon(w.durP50)}] 延迟 P50： ${fmtMs(w.durP50)}`,
    `[${durIcon(w.durP99)}] 延迟 P99： ${fmtMs(w.durP99)}`,
    `[${errIcon(w.errorRate)}] 错误： ${fmtNum(w.errors)} 次  (${pct(w.errors, w.requests)})`,
    `[${subIcon(parseFloat(avgSub))}] 外链： ${fmtNum(w.subrequests)} 次  (均 ${avgSub}/次)`,
  ].join("\n");
}

/**
 * 构建 Blogger 浏览量统计块
 *
 * 今日浏览量根据计算 status 展示不同文案：
 *   ok      - 显示实际数值
 *   cold    - 提示基线刚建立
 *   nokv    - 提示 KV 未绑定
 *   anomaly - 提示数据异常
 *   其他    - 提示暂不可用
 *
 * 流量趋势：7 天日均与 30 天日均对比，偏差超过 TRENDPCT（5%）时显示涨跌图标
 */
function buildBloggerBlock(blogger, todayPV, todayStatus, siteName, reportDateBj) {
  const todayVal =
    todayStatus === "ok"      ? fmtNum(todayPV) :
    todayStatus === "cold"    ? "基线刚建立，下次刷新后稳定显示" :
    todayStatus === "nokv"    ? "未绑定 KV，无法计算" :
    todayStatus === "anomaly" ? "数据异常 [🔴]" :
                                "暂不可用 [🔴]";

  const trendPct  = blogger.avg30 > 0
    ? (((blogger.avg7 / blogger.avg30) - 1) * 100).toFixed(1)
    : "0.0";
  const trendStr  = parseFloat(trendPct) >= 0 ? `+${trendPct}%` : `${trendPct}%`;
  const trendIcon = blogger.avg7 > blogger.avg30 * (1 + THRESHOLD.TREND_PCT) ? "📈"
                  : blogger.avg7 < blogger.avg30 * (1 - THRESHOLD.TREND_PCT) ? "📉" : "➡️";

  return [
    `─────────────────`,
    ``,
    `🖥️ <b>${siteName} 浏览量统计</b>`,
    ``,
    `今日浏览量： ${todayVal}`,
    `过去 7 天： ${fmtNum(blogger.pv7)}  (日均：${fmtNum(blogger.avg7)})`,
    `过去 30 天： ${fmtNum(blogger.pv30)}  (日均：${fmtNum(blogger.avg30)})`,
    `历史总浏览： ${fmtNum(blogger.total)}`,
    `流量趋势： ${trendStr}  [${trendIcon}]`,
  ].join("\n");
}

/**
 * 构建每日运营报告消息
 *
 * 内容结构：
 *   1. 报告头部（生成时间 / 报表日期 / CF 统计窗口）
 *   2. Workers 用量总览（健康评分 / 额度消耗 / 全局性能）
 *   3. 各 Worker 详细数据
 *   4. Blogger 浏览量统计（若已配置）
 *   5. 状态摘要 + 额度重置倒计时 + 图例
 */
function buildDailyReport(cfData, blogger, todayPVResult, health, now, env, reportDateBj, quotaDateUtc) {
  const { total, workers } = cfData;
  const siteName  = getSiteName(env);
  const remaining = QUOTA.REQUESTS_DAY - total.requests;

  // 基于 UTC 已过时长预测全天请求量，最少按 2 小时计（避免日初预测值失真）
  const elapsedUtcHours = Math.max(now.getUTCHours() + now.getUTCMinutes() / 60, 2);
  const rate    = total.requests / elapsedUtcHours;
  const predDay = Math.round(rate * 24);
  // 剩余额度在当前速率下预计还能撑多少小时
  const hoursLeft = rate > 0 ? remaining / rate : Infinity;
  const safeTag   = reqIcon(predDay / QUOTA.REQUESTS_DAY);

  const lines = [
    `☁️ <b>${siteName} · 每日运营报告</b>`,
    ``,
    `报告生成： ${fmtBjShort(now)}`,
    `CF 统计： ${quotaDateUtc} ${fmtUtcShort(now)}`,
    `─────────────────`,
    ``,
    `⚡️ WORKERS 用量总览`,
    ``,
    `[${health.icon}] 系统评分： ${health.score}/100  (${health.level})`,
    ``,
    `全局请求 (免费上限 10 万次/天)`,
    `[${reqIcon(total.ratio)}] 今日已用： ${fmtNum(total.requests)}  (${(total.ratio * 100).toFixed(1)}%)`,
    `[${remIcon(hoursLeft)}] 剩余额度： ${fmtNum(Math.max(remaining, 0))}`,
    `[${safeTag}] 预测全天： ${fmtNum(predDay)}`,
    ``,
    `核心性能 (单次 CPU 上限 10ms)`,
    `[${cpuIcon(total.cpuP50)}] CPU P50： ${fmtMs(total.cpuP50)}`,
    `[${cpuIcon(total.cpuP99)}] CPU P99： ${fmtMs(total.cpuP99)}`,
    `[${errIcon(total.errorRate)}] 全局错误率： ${pct(total.errors, total.requests)}`,
    `[${durIcon(total.durP99)}] 全局延迟 P99： ${fmtMs(total.durP99)}`,
    `[${subIcon(total.requests > 0 ? total.subrequests / total.requests : 0)}] 总出站请求： ${fmtNum(total.subrequests)} 次`,
    ``,
    `─────────────────`,
    ``,
    `📄 WORKER 详细数据`,
    ``,
  ];

  // 逐一追加各 Worker 数据块，块间空行分隔
  workers.forEach((w, i) => {
    lines.push(buildWorkerBlock(w, i));
    if (i < workers.length - 1) lines.push("");
  });

  // Blogger 模块（可选，仅在已配置且拉取成功时显示）
  if (blogger) {
    lines.push("", buildBloggerBlock(
      blogger, todayPVResult.todayPV, todayPVResult.status, siteName, reportDateBj
    ));
  }

  lines.push(
    ``,
    health.score < 70
      ? `${health.icon} 存在异常指标，请关注告警详情`
      : `✅ 所有服务运行正常，无异常告警`,
    `⏰ 额度重置：${fmtResetCountdown(now)}`,
    `─────────────────`,
    ``,
    `状态说明：`,
    `[🟢] 运行正常      [🟠] 性能退化`,
    `[🟡] 轻微波动      [🔴] 服务异常`,
    `─────────────────`,
  );
  return lines.join("\n");
}

/**
 * 构建告警消息（预警 / 紧急告警）
 *
 * 只列出触发了对应级别阈值的指标，不重复展示正常项，减少消息冗余
 *
 * @param {boolean} isCritical  true=紧急告警（90% / 10ms / 5%），false=预警（70% / 7ms / 1%）
 */
function buildAlert(cfData, health, now, env, isCritical) {
  const { total, workers } = cfData;
  const siteName  = getSiteName(env);
  const remaining = QUOTA.REQUESTS_DAY - total.requests;
  // 已过小时数（用于预测额度耗尽时间）
  const elapsed   = Math.max(now.getUTCHours() + now.getUTCMinutes() / 60, 2);

  // 根据告警级别选取对应阈值
  const reqThreshold = isCritical ? THRESHOLD.REQ_ALERT   : THRESHOLD.REQ_WARN;
  const cpuThreshold = isCritical ? THRESHOLD.CPU_ALERT_MS  : THRESHOLD.CPU_WARN_MS;
  const errThreshold = isCritical ? THRESHOLD.ERR_ALERT    : THRESHOLD.ERR_WARN;
  const durThreshold = isCritical ? THRESHOLD.DUR_ALERT_MS  : THRESHOLD.DUR_WARN_MS;
  const title        = isCritical ? "紧急告警" : "运行预警";

  const issueBlocks = [];

  // 额度消耗超阈值时，计算预计耗尽时间
  if (total.ratio >= reqThreshold) {
    const rate      = total.requests / elapsed;
    const hoursLeft = rate > 0 ? (remaining / rate).toFixed(1) : "∞";
    issueBlocks.push([
      `[${reqIcon(total.ratio)}] ${isCritical ? "请求额度接近耗尽" : "请求额度持续上升"}`,
      `已用：${fmtNum(total.requests)}  剩余：${fmtNum(Math.max(remaining, 0))}`,
      `预计 ${hoursLeft} 小时后触及上限`,
    ]);
  }

  // 逐 Worker 检查性能指标是否超阈值
  workers.forEach(w => {
    const cpuFlag = w.cpuP99    >= cpuThreshold;
    const errFlag = w.errorRate >= errThreshold;
    const durFlag = w.durP99    >= durThreshold;
    if (!cpuFlag && !errFlag && !durFlag) return;
    const rows = [`${esc(w.alias)} · ${esc(w.name)}`];
    if (cpuFlag) rows.push(`[${cpuIcon(w.cpuP99)}] CPU P99： ${fmtMs(w.cpuP99)}`);
    if (errFlag) rows.push(`[${errIcon(w.errorRate)}] 错误率： ${pct(w.errors, w.requests)}`);
    if (durFlag) rows.push(`[${durIcon(w.durP99)}] 延迟 P99： ${fmtMs(w.durP99)}`);
    issueBlocks.push(rows);
  });

  // 块间插入空行，最后一块不加
  const issueLines = issueBlocks.flatMap((block, i) =>
    i < issueBlocks.length - 1 ? [...block, ""] : block
  );

  return [
    `☁️ ${siteName} · ${title}`,
    ``,
    `${fmtBjShort(now)}  |  ${fmtUtcShort(now)}`,
    `系统评分：${health.score}/100 [${health.icon} ${health.level}]`,
    ``,
    isCritical ? `当前问题` : `预警指标`,
    ...issueLines,
    ``,
    `额度重置：${fmtResetCountdown(now)}`,
  ].join("\n");
}

/**
 * 构建 critical Worker 零请求（疑似离线）的告警消息
 * 触发条件：UTC OFFLINEUTCHOUR 之后，critical Worker 请求数仍为 0
 */
function buildOfflineAlert(worker, now, env) {
  const siteName = getSiteName(env);
  return [
    `🛑️ ${siteName} · 服务离线告警`,
    `${fmtBjShort(now)}  |  ${fmtUtcShort(now)}`,
    ``,
    `疑似离线：${esc(worker.alias)} · ${esc(worker.name)}`,
    `今日请求数为零（UTC ${THRESHOLD.OFFLINE_UTC_HOUR}:00 后未见流量）`,
    ``,
    `排查项目`,
    `Worker 是否部署正常`,
    `路由或自定义域名是否失效`,
    `上游服务是否中断`,
  ].join("\n");
}

/**
 * 构建监控执行异常通知消息
 * 错误信息截断至 200 字符，防止内部配置细节（账户 ID、API 路径等）泄露到 Telegram
 */
function buildErrorMsg(errMsg, now, env) {
  const siteName = getSiteName(env ?? {});
  return [
    `🚨️ ${siteName} · 监控执行异常`,
    `${fmtBjShort(now)}  |  ${fmtUtcShort(now)}`,
    ``,
    `错误详情`,
    `<code>${esc(String(errMsg).slice(0, 200))}</code>`,
    ``,
    `本次报告未发送，可通过手动触发链接重新获取`,
  ].join("\n");
}

/** 构建部署自检结果消息（同时通过 Telegram 推送，方便远程确认部署状态） */
function buildVerifyReport(results, now, env) {
  const siteName = getSiteName(env ?? {});
  const allOk    = results.every(r => r.ok);
  const items    = results.map(r => `[${r.ok ? "🟢" : "🔴"}] ${r.name}：${r.msg}`);
  return [
    `⚙️️ ${siteName} · 部署自检`,
    `${fmtBjShort(now)}`,
    ``,
    `检测结果`,
    ...items,
    ``,
    allOk ? `所有模块正常，可以正式使用` : `存在异常项，请检查配置后重新部署`,
  ].join("\n");
}

/**
 * 根据当前数据状态选择要发送的消息模板
 *
 * 选择优先级：
 *   1. isDailyReport=true → 日报（无论告警状态如何，均发送完整报告）
 *   2. hasCritical=true   → 紧急告警
 *   3. hasWarning=true    → 预警
 *   4. 均无               → 空消息，isAlert=false，不发送任何消息
 */
function selectTemplate(cfData, blogger, todayPVResult, health, now, isDailyReport, env, reportDateBj, quotaDateUtc) {
  const { total, workers } = cfData;

  // 检测是否有指标触达紧急告警阈值
  const hasCritical =
    total.ratio >= THRESHOLD.REQ_ALERT ||
    workers.some(w =>
      w.cpuP99    >= THRESHOLD.CPU_ALERT_MS ||
      w.errorRate >= THRESHOLD.ERR_ALERT   ||
      w.durP99    >= THRESHOLD.DUR_ALERT_MS
    );

  // 检测是否有指标触达预警阈值
  const hasWarning =
    total.ratio >= THRESHOLD.REQ_WARN ||
    workers.some(w =>
      w.cpuP99    >= THRESHOLD.CPU_WARN_MS ||
      w.errorRate >= THRESHOLD.ERR_WARN   ||
      w.durP99    >= THRESHOLD.DUR_WARN_MS
    );

  if (isDailyReport) {
    return {
      message:    buildDailyReport(cfData, blogger, todayPVResult, health, now, env, reportDateBj, quotaDateUtc),
      isAlert:    false,
      alertLevel: "none",
    };
  }
  if (hasCritical) return { message: buildAlert(cfData, health, now, env, true),  isAlert: true, alertLevel: "critical" };
  if (hasWarning)  return { message: buildAlert(cfData, health, now, env, false), isAlert: true, alertLevel: "warn" };
  return { message: "", isAlert: false, alertLevel: "none" };
}

// =============================================================
// 区块 11：Telegram 消息发送层
// =============================================================

/**
 * 构建 Telegram 消息的内联键盘
 * - 刷新按钮：发送 callback_query，触发 Webhook 原地刷新数据
 * - CF 控制台：跳转 Cloudflare Dashboard
 */
function makeInlineKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🔄 刷新实时数据", callback_data: "refresh" },
      { text: "🔗 CF 控制台",    url: "https://dash.cloudflare.com" },
    ]],
  };
}

/**
 * Telegram 单条消息最大 4096 字符（HTML 模式）
 * 超出时截断至 3950 并追加提示，预留足够余量给 HTML 标签转义膨胀
 */
function truncateTG(text, suffix = "\n\n<i>⚠️ 内容过长已截断，请前往 CF 控制台查看完整数据</i>") {
  return text.length > 4000 ? text.slice(0, 3950) + suffix : text;
}

/**
 * 发送新 Telegram 消息
 * @returns {number} 成功发送的消息 ID（用于后续原地编辑）
 */
async function sendTGMessage(botToken, chatId, text) {
  const resp = await fetchWithRetry(`${STATIC.TG_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:                  chatId,
      text:                     truncateTG(text),
      parse_mode:               "HTML",
      disable_web_page_preview: true,
      disable_notification:     false,
      reply_markup:             makeInlineKeyboard(),
    }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(`Telegram sendMessage 失败: ${result.error_code} ${result.description}`);
  return result.result.message_id;
}

/**
 * 编辑已有 Telegram 消息（用于刷新按钮触发的原地更新，不产生新消息）
 * error_code 400 通常表示消息内容与当前相同，静默忽略即可
 */
async function editTGMessage(botToken, chatId, messageId, text) {
  const resp = await fetchWithRetry(`${STATIC.TG_API_BASE}/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:                  chatId,
      message_id:               messageId,
      text:                     truncateTG(text, "\n\n<i>⚠️ 内容过长已截断</i>"),
      parse_mode:               "HTML",
      disable_web_page_preview: true,
      reply_markup:             makeInlineKeyboard(),
    }),
  });
  const result = await resp.json();
  if (!result.ok) {
    // 400 = 消息内容未改变，不计为错误
    if (result.error_code === 400) return;
    throw new Error(`Telegram editMessage 失败: ${result.error_code} ${result.description}`);
  }
}

/**
 * 响应 Telegram callback_query（必须在 60 秒内应答，否则按钮持续显示加载状态）
 * 失败时仅打印警告，不影响主流程
 */
async function answerCallbackQuery(botToken, callbackQueryId, text = "") {
  try {
    const resp = await fetch(`${STATIC.TG_API_BASE}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!j.ok) console.warn("answerCallbackQuery failed:", j.description);
  } catch (e) {
    console.warn("answerCallbackQuery error:", e.message);
  }
}

/**
 * 发送错误通知到 Telegram
 * 使用 .catch(() => {}) 静默忽略发送失败，防止错误处理本身再次抛出异常（死循环）
 */
async function sendErrorNotice(botToken, chatId, errMsg, now, env) {
  await sendTGMessage(botToken, chatId, buildErrorMsg(errMsg, now, env)).catch(() => {});
}

// =============================================================
// 区块 12：KV 状态读写
// =============================================================

/**
 * 读取最新日报消息 ID 记录
 * 用于 Webhook 刷新时判断被点击的消息是否为最新日报
 * @returns {{ messageId: number, date: string } | null}
 */
async function getLatestMsgId(kv) {
  try {
    const raw = await kv.get(KV_KEY.LATESTMSGID);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** 保存最新日报消息 ID，有效期 30 天 */
async function saveLatestMsgId(kv, messageId, date) {
  await kv.put(
    KV_KEY.LATESTMSGID,
    JSON.stringify({ messageId, date }),
    { expirationTtl: 30 * 24 * 3600 }
  );
}

/**
 * 读取最近一次告警记录
 * @returns {{ level: string, time: number } | null}
 */
async function getLastAlert(kv) {
  try {
    const raw = await kv.get(KV_KEY.LASTALERT);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** 保存告警记录，有效期 24 小时（避免重启后遗失导致立即重发） */
async function saveLastAlert(kv, level, time) {
  await kv.put(KV_KEY.LASTALERT, JSON.stringify({ level, time }), { expirationTtl: 24 * 3600 });
}

/**
 * 判断是否需要发送新一轮告警
 *
 * 冷却规则：
 *   - newLevel = "none"                    → 永不发送
 *   - lastAlert 为空                        → 立即发送（首次告警）
 *   - newLevel 升级（warn → critical）      → 立即发送（不受冷却限制）
 *   - 同级别且距上次发送 < ALERT_COOLDOWN_MS  → 跳过（冷却中）
 *   - 同级别且冷却时间已过                  → 发送
 *
 * @param {object|null} lastAlert  上次告警记录 { level, time }
 * @param {string}      newLevel   本次检测到的告警级别："critical" / "warn" / "none"
 * @param {number}      now        当前时间戳（毫秒）
 */
function shouldSendAlert(lastAlert, newLevel, now) {
  if (newLevel === "none") return false;
  if (!lastAlert) return true;
  const { level: lastLevel, time: lastTime } = lastAlert;
  // 告警级别升级，立即推送
  if (newLevel === "critical" && lastLevel !== "critical") return true;
  // 同级别冷却中，跳过
  if (lastLevel === newLevel && now - Number(lastTime) < ALERT_COOLDOWN_MS) return false;
  return true;
}

// =============================================================
// 区块 13：主执行链路
// =============================================================

/**
 * 主监控函数，负责完整的数据拉取 → 模板选择 → 消息发送流程
 *
 * @param {object}      env            Cloudflare Workers 环境变量
 * @param {boolean}     isDailyReport  true=发送每日报表，false=执行告警评估
 * @param {Date|null}   nowArg         可注入时间（便于测试），null 时取当前时间
 */
async function runMonitor(env, isDailyReport = true, nowArg = null) {
  validateEnv(env);
  const workerConfigs = parseWorkersConfig(env);
  const kv  = env.KV;
  const now = nowArg ?? new Date();

  const { cfData, blogger, todayPVResult, health, startTime, endTime, reportDateBj, quotaDateUtc } =
    await fetchAllData(env, workerConfigs, now);

  const { message, isAlert, alertLevel } = selectTemplate(
    cfData, blogger, todayPVResult, health, now, isDailyReport, env, reportDateBj, quotaDateUtc
  );

  // 检测疑似离线的 critical Worker（UTC OFFLINEUTCHOUR 之后请求数仍为 0）
  const utcHour        = now.getUTCHours();
  const offlineWorkers = cfData.workers.filter(
    w => w.critical && w.requests === 0 && utcHour >= THRESHOLD.OFFLINE_UTC_HOUR
  );

  let sent = false;

  if (isDailyReport) {
    // 日报：直接发送，无论告警状态
    const msgId = await sendTGMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, message);
    // 保存消息 ID，供刷新按钮判断是否为最新日报
    if (kv) await saveLatestMsgId(kv, msgId, reportDateBj).catch(() => {});
    // 保存日报 PV 快照（仅记录，不影响今日 PV 基线）
    if (blogger && kv) await savePVSnapshot(kv, reportDateBj, blogger.total).catch(() => {});
    sent = true;
  } else if (isAlert) {
    // 告警模式：遵循冷却规则，避免重复推送
    const lastAlert = kv ? await getLastAlert(kv) : null;
    if (shouldSendAlert(lastAlert, alertLevel, now.getTime())) {
      await sendTGMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, message);
      if (kv) await saveLastAlert(kv, alertLevel, now.getTime()).catch(() => {});
      sent = true;
    }
  }

  // 处理离线告警
  if (offlineWorkers.length > 0) {
    if (kv) {
      // 有 KV：读取各 Worker 上次离线告警时间，进行冷却控制
      const offlineKeys  = offlineWorkers.map(w => `${KV_KEY.LASTOFFLINE}:${w.name}`);
      const lastOfflines = await Promise.all(offlineKeys.map(k => kv.get(k).catch(() => null)));
      const sendTasks    = [];
      const saveTasks    = [];
      offlineWorkers.forEach((w, i) => {
        const raw = lastOfflines[i];
        if (raw) {
          const lastTime = Number(JSON.parse(raw));
          // 仍在冷却期内，跳过该 Worker 的离线告警
          if (now.getTime() - lastTime < ALERT_COOLDOWN_MS) return;
        }
        sendTasks.push(
          sendTGMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, buildOfflineAlert(w, now, env)).catch(() => {})
        );
        saveTasks.push(
          kv.put(offlineKeys[i], JSON.stringify(now.getTime()), { expirationTtl: 24 * 3600 }).catch(() => {})
        );
      });
      await Promise.all(sendTasks);
      await Promise.all(saveTasks);
    } else if (isDailyReport) {
      // 无 KV 时：仅在日报执行时随附一次离线提示
      // 不在告警轮次单独发送，避免每轮 Cron（约每 5 分钟）重复推送离线消息
      await Promise.all(
        offlineWorkers.map(w =>
          sendTGMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, buildOfflineAlert(w, now, env)).catch(() => {})
        )
      );
    }
  }

  // 返回本次执行摘要（显示在 HTTP 手动触发的响应体中）
  return [
    `执行完成 | ${fmtBjShort(now)}`,
    `报表日期：${reportDateBj}（北京时间）`,
    `额度日期：${quotaDateUtc}（UTC）`,
    `健康评分：${health.score}/100 ${health.icon}`,
    `今日请求：${fmtNum(cfData.total.requests)} / ${fmtNum(QUOTA.REQUESTS_DAY)}`,
    `消息发送：${sent ? "✅ 已发送" : "⏭ 跳过（冷却中或无需推送）"}`,
    `类型：${isDailyReport ? "每日报告" : "告警评估"}`,
    `时间窗口：${startTime} ~ ${endTime}`,
  ].join("\n");
}

// =============================================================
// 区块 14：Worker 入口（HTTP 请求 / Cron 调度 / Webhook 处理）
// =============================================================

export default {
  /**
   * HTTP 请求入口
   *
   * 路由规则：
   *   POST /webhook                    → Telegram Webhook 回调（inline 刷新按钮）
   *   GET  ?token=xxx&type=verify      → 部署自检（检测各模块连通性并推送结果）
   *   GET  ?token=xxx&type=status      → 返回 JSON 格式的实时状态数据
   *   GET  ?token=xxx&type=alert       → 手动触发告警评估
   *   GET  ?token=xxx（或 type=daily） → 手动触发每日报告
   *
   * 鉴权说明：
   *   - Webhook：通过 X-Telegram-Bot-Api-Secret-Token header + TG_WEBHOOK_SECRET 校验
   *   - 其他接口：通过 URL 参数 token + MANUAL_TOKEN 校验
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram Webhook 回调优先处理（使用独立的 Webhook Secret 鉴权，与 MANUAL_TOKEN 无关）
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    // 手动触发鉴权
    const expectedToken = env.MANUAL_TOKEN ?? "";
    const token         = url.searchParams.get("token") ?? "";

    // MANUAL_TOKEN 未配置时，明确提示配置缺失（区别于 Token 错误）
    if (!expectedToken) {
      return new Response("MANUAL_TOKEN 未配置，手动触发已禁用", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (token !== expectedToken) {
      return new Response("401 Unauthorized\n请在 URL 后附加 ?token=<MANUAL_TOKEN>", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const type = url.searchParams.get("type") ?? "daily";
    try {
      if (type === "verify") {
        return new Response(await runVerify(env), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (type === "status") {
        return new Response(JSON.stringify(await runStatus(env), null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const isDailyReport = type !== "alert";
      const summary = await runMonitor(env, isDailyReport);
      return new Response(summary, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      await sendErrorNotice(env.TG_BOT_TOKEN, env.TG_CHAT_ID, msg, new Date(), env).catch(() => {});
      return new Response("❌ 执行失败: " + msg, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },

  /**
   * Cron 定时触发入口
   *
   * 推荐配置：至少每 5 分钟触发一次（wrangler.toml: crons = ["* /5 * * * *"]）
   * 触发逻辑：
   *   - 北京时间 23:55 ~ 23:59：发送每日报告
   *   - 其余时段：执行告警评估（指标触阈则推送，否则静默跳过）
   *
   * 使用 ctx.waitUntil 确保异步任务在 Worker 返回响应后仍能完成
   */
  async scheduled(event, env, ctx) {
    // 建议 Cron 至少每 5 分钟一次，如 */5 * * * *
    // 否则北京时间 23:55~23:59 的日报发送窗口可能被错过。
    ctx.waitUntil((async () => {
      const now        = new Date(event.scheduledTime);
      const bj         = getBeijingDate(now);
      const bjHour     = bj.getUTCHours();
      const bjMin      = bj.getUTCMinutes();
      // 北京时间 23:55 ~ 23:59 窗口触发每日报告
      const isDailyReport = (bjHour === 23 && bjMin >= 55);
      try {
        await runMonitor(env, isDailyReport, now);
      } catch (err) {
        const msg = err?.message ?? String(err);
        await sendErrorNotice(env.TG_BOT_TOKEN, env.TG_CHAT_ID, msg, now, env).catch(() => {});
      }
    })());
  },
};

/**
 * 处理 Telegram Webhook 回调（inline 刷新按钮点击）
 *
 * 三层安全验证：
 *   1. Webhook Secret Header：验证请求确实来自 Telegram
 *   2. validateEnv：确保必填配置完整
 *   3. chatId 校验：确保回调来自授权的 Chat，防止其他用户触发数据拉取
 *
 * 处理逻辑：
 *   - 立即应答 callback_query（消除 Telegram 客户端加载状态）
 *   - 若被刷新消息非最新日报：追加提示，不重新拉取数据
 *   - 若为最新日报：拉取实时数据，原地编辑该消息
 */
async function handleWebhook(request, env) {
  // 第一层：验证 Webhook Secret，防止非 Telegram 来源的伪造 POST 请求
  // 注意：TG_WEBHOOK_SECRET 未配置时跳过校验（降级为无鉴权模式），
  // 建议在 TG 注册 Webhook 时传入 secret_token 并配置此环境变量。
  if (env.TG_WEBHOOK_SECRET) {
    const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (incomingSecret !== env.TG_WEBHOOK_SECRET) {
      console.warn("handleWebhook: secret-token mismatch, request rejected");
      return new Response("Forbidden", { status: 403 });
    }
  }

  // 第二层：校验必填环境配置
  try { validateEnv(env); }
  catch (e) {
    console.error("handleWebhook validateEnv failed:", e.message);
    return new Response("Internal Config Error", { status: 500 });
  }

  // 解析请求体
  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  // 仅处理 callback_query 类型（inline 按钮点击）
  const cq = body?.callback_query;
  if (!cq) return new Response("OK", { status: 200 });

  const callbackQueryId = cq.id;
  const msgId           = cq.message?.message_id;
  const chatId          = cq.message?.chat?.id;
  const botToken        = env.TG_BOT_TOKEN;

  // 第三层：验证 chatId，确保只响应来自授权 Chat 的刷新请求
  if (String(chatId) !== String(env.TG_CHAT_ID)) {
    // 礼貌应答，消除 Telegram 端加载状态，但不执行任何操作
    await answerCallbackQuery(botToken, callbackQueryId, "无权限");
    return new Response("Forbidden", { status: 403 });
  }

  // 立即应答 callback_query（Telegram 要求 60 秒内应答）
  await answerCallbackQuery(botToken, callbackQueryId, "正在获取最新数据…");

  try {
    const kv         = env.KV;
    const latestInfo = kv ? await getLatestMsgId(kv) : null;
    // 判断被点击的消息是否为最新一条日报
    const isLatest   = !latestInfo || latestInfo.messageId === msgId;

    if (!isLatest) {
      // 历史报告：在消息末尾追加提示，不触发新的 API 调用
      await editTGMessage(
        botToken, chatId, msgId,
        (cq.message?.text ?? "") + "\n\n<i>⚠️ 此条为历史报告，请查看最新推送的日报</i>"
      ).catch(() => {});
      return new Response("OK", { status: 200 });
    }

    // 最新日报：拉取实时数据后原地更新消息内容
    const workerConfigs = parseWorkersConfig(env);
    const now           = new Date();
    const { cfData, blogger, todayPVResult, health, reportDateBj, quotaDateUtc } =
      await fetchAllData(env, workerConfigs, now);
    const message = buildDailyReport(cfData, blogger, todayPVResult, health, now, env, reportDateBj, quotaDateUtc);
    await editTGMessage(botToken, chatId, msgId, message);
  } catch (err) {
    // 刷新失败：在消息末尾追加错误提示（截断至 150 字符防止信息泄露）
    await editTGMessage(
      botToken, chatId, msgId,
      (cq.message?.text ?? "") +
        `\n\n<i>❗ 刷新失败：${esc(String(err?.message ?? err).slice(0, 150))}</i>`
    ).catch(() => {});
  }

  return new Response("OK", { status: 200 });
}

/**
 * 部署自检函数
 * 逐项检测各模块连通性，结果通过 Telegram 推送并以文本形式返回 HTTP 响应
 *
 * 检测项目：
 *   1. 环境配置    - validateEnv 必填项校验
 *   2. CF GraphQL  - API 连通性 + Token 权限验证
 *   3. Blogger API - OAuth 认证 + 数据读取（可选，未配置时标注"未启用"）
 *   4. KV 存储     - 读写测试（未绑定时标注影响范围）
 *   5. TG Webhook  - 检查是否已注册 Webhook URL
 *   6. TG Bot      - 发送测试消息验证推送能力
 */
async function runVerify(env) {
  const now     = new Date();
  const results = [];

  // 检测必填环境配置
  try {
    validateEnv(env);
    results.push({ ok: true, name: "环境配置", msg: "必填项校验通过" });
  } catch (e) {
    results.push({ ok: false, name: "环境配置", msg: e.message });
  }

  // 检测 Cloudflare GraphQL API 连通性与权限
  try {
    const workerConfigs      = parseWorkersConfig(env);
    const { startTime, endTime } = buildTimeWindow(now);
    const raw = await fetchCFAnalytics(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, startTime, endTime);
    const cf  = processCFData(raw, workerConfigs);
    results.push({ ok: true, name: "CF GraphQL API", msg: `今日已采集 ${fmtNum(cf.total.requests)} 次请求` });
  } catch (e) {
    results.push({ ok: false, name: "CF GraphQL API", msg: e.message });
  }

  // 检测 Blogger API（可选功能）
  if (hasBloggerOAuth(env)) {
    try {
      const stats = await fetchBloggerStats(env.BLOGGER_BLOG_ID, env);
      results.push({ ok: true, name: "Blogger API v3", msg: `历史总浏览 ${fmtNum(stats.total)} PV（OAuth 认证正常）` });
    } catch (e) {
      results.push({ ok: false, name: "Blogger API v3", msg: e.message });
    }
  } else {
    const missing = ["BLOGGER_BLOG_ID","BLOGGER_CLIENT_ID","BLOGGER_CLIENT_SECRET","BLOGGER_REFRESH_TOKEN"]
      .filter(k => !env[k]);
    results.push({
      // missing.length === 4：四项全缺 → 用户完全没配置 Blogger，属于正常的"未启用"状态
      // missing.length  < 4：部分缺失 → 配置不完整，属于错误，需要提示修复
      ok:   missing.length === 4,
      name: "Blogger API v3",
      msg:  missing.length === 4
        ? "未配置（可选功能，不影响 CF 监控）"
        : `配置不完整，缺少：${missing.join(", ")}`,
    });
  }

  // 检测 KV 存储读写能力
  if (env.KV) {
    try {
      await env.KV.put("__verify_test__", "ok", { expirationTtl: 60 });
      const val = await env.KV.get("__verify_test__");
      results.push({ ok: val === "ok", name: "KV 存储", msg: val === "ok" ? "读写正常（Blogger 今日浏览量 / 告警冷却 / 最新日报刷新依赖 KV）" : "写入后读取失败" });
    } catch (e) {
      results.push({ ok: false, name: "KV 存储", msg: e.message });
    }
  } else {
    results.push({ ok: true, name: "KV 存储", msg: "未绑定（系统仍可执行基础 CF 监控，但 Blogger 今日浏览量、告警冷却、最新日报刷新将不可用）" });
  }

  // 检测 Telegram Webhook 注册状态
  try {
    const resp  = await fetch(`${STATIC.TG_API_BASE}/bot${env.TG_BOT_TOKEN}/getWebhookInfo`);
    const data  = await resp.json();
    const whUrl = data?.result?.url ?? "";
    results.push({
      ok:   whUrl.length > 0,
      name: "Telegram Webhook",
      msg:  whUrl.length > 0 ? `已注册：${whUrl}` : "未注册，刷新按钮功能将不可用",
    });
  } catch (e) {
    results.push({ ok: false, name: "Telegram Webhook", msg: e.message });
  }

  // 检测 Telegram Bot 发送能力（实际发送一条测试消息）
  try {
    await sendTGMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, buildVerifyReport(results, now, env));
    results.push({ ok: true, name: "Telegram Bot", msg: "测试消息已发送，请检查 TG 是否收到" });
  } catch (e) {
    results.push({ ok: false, name: "Telegram Bot", msg: e.message });
  }

  const allOk = results.every(r => r.ok);
  return [
    `=== 部署自检结果 ===`,
    `时间：${fmtBjShort(now)}`,
    ``,
    ...results.map(r => `${r.ok ? "[OK]  " : "[FAIL]"} ${r.name}：${r.msg}`),
    ``,
    allOk ? "✅ 全部通过，可以正式使用" : "❌ 存在失败项，请检查配置",
  ].join("\n");
}

/**
 * 返回当前监控状态的结构化 JSON 数据
 * 用途：外部系统集成 / 本地调试 / 自动化巡检
 * 访问方式：GET ?type=status&token=<MANUAL_TOKEN>
 */
async function runStatus(env) {
  validateEnv(env);
  const workerConfigs = parseWorkersConfig(env);
  const now           = new Date();
  const { cfData, blogger, todayPVResult, health, startTime, endTime, reportDateBj, quotaDateUtc } =
    await fetchAllData(env, workerConfigs, now);
  return {
    generatedAt:  now.toISOString(),
    beijingTime:  fmtBjShort(now),
    utcTime:      fmtUtcShort(now),
    reportDateBj,
    quotaDateUtc,
    health,
    cf:           { total: cfData.total, workers: cfData.workers },
    blogger,
    todayPV:      todayPVResult,
    window:       { startTime, endTime },
  };
}
