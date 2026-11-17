// 同步引擎：终端与服务器之间唯一的通道。
//
// 只做三件事，按重要性排序：
//   ① 长轮询 /api/state，知道"现在该是哪个型号、内容版本是几"
//   ② 把该型号本工序的内容下到本地并校验（边下边播旧的，下完才翻）
//   ③ 请求渲染层翻转（渲染层同步换队列），ack 之后才删旧文件
// 另外网络断了就退回离线态：画面不动、继续播本地内容，指数退避重连。
//
// 5.0.1 删掉的两样（服务端同步删了对应接口）：
//   · 举手（POST /api/ready）—— 换型不再是"集齐才翻"，服务端指定即生效
//   · 管理端改派（/api/state 的 assign）—— 屏的线号工序号只由屏自己填
//
// 有一条不能破：**画面翻不翻由磁盘说话**。本地没有这套内容，就不许翻，
// 宁可亮红字让人看见，也不能让工人对着一屏半新半旧判断错了批次。
const EventEmitter = require('node:events');
const net = require('./net');
const cache = require('./cache');

const ONLINE_PUSH_MS = 30_000;   // 断线后的兜底轮询间隔上限
const FLIP_TIMEOUT_MS = 10_000;  // 等渲染层 ack 的上限，超时算翻转失败（保留旧画面）

/**
 * 清单指纹：改一张图、加一段视频、调一次停留秒数，指纹都会变。
 * 用它判断"服务端说内容变了，但我这套其实没动"——避免别的工序改动把全厂屏都闪一下。
 */
function fpOf(items) {
  // 显示方式（fit/zoom）必须进指纹。只算 mediaId+dwell 的话，
  // 工程部把某张图从"适应"改成"铺满 + 放大 150%"保存后，指纹一样，
  // 终端会当成"内容没变"不重翻 —— 人以为改生效了，屏上还是老样子。
  return (items || [])
    .map((it) => `${it.mediaId || it.file || ''}:${it.dwellSec || 0}:${it.kind || ''}` +
                 `:${it.fit || 'contain'}:${it.zoom || 100}`)
    .join('|');
}

class Syncer extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.flipHandler = opts.flipHandler || null;   // (view) => Promise<void>，由 main.js 注入（走 IPC）
    this.running = false;
    this.lastRev = 0;
    this.appliedModelId = '';
    this.appliedCode = '';
    this.status = 'boot';
    this.progress = { done: 0, total: 0 };
    // 机器参数：分辨率 / 版本 / 磁盘剩余。由 main.js 注入（渲染进程、主进程各有一半信息），
    // 这里只负责随心跳带上去 —— 管理端右栏靠它显示每台屏的实际情况。
    this.meta = { res: '', ver: '', free: 0 };
    this.missing = [];
    this.online = [];
    this.serverSeq = 0;
    this.linked = false;
    this.failCount = 0;
    this.prepared = new Map();     // modelId -> { modelCode, items, at }
    this.inflight = null;          // { modelId, controller }
    this.serverCurrentId = '';     // 服务端当前该播的型号（最近一次轮询结果）
    this.serverContentRev = 0;     // 服务端内容版本（任何清单/媒体改动都会变）
    this.appliedContentRev = null; // 本机已生效的内容版本；null = 冷启动还没核对过
    this.appliedFp = '';           // 已生效清单的指纹，用来判断"内容其实没变"
    this.flipping = false;
    this.lastView = null;
    this.startedAt = Date.now();
    this._statusKey = '';
    this._wakeRetry = null;
  }

  snapshot() {
    return {
      line: this.cfg.line || '',
      op: this.cfg.op,
      server: this.cfg.server,
      status: this.status,
      modelCode: this.appliedCode,
      modelId: this.appliedModelId,
      seq: this.serverSeq,
      done: this.progress.done,
      total: this.progress.total,
      missing: this.missing,
      online: this.online,
      linked: this.linked,
      cache: cache.stats(),
      uptimeMs: Date.now() - this.startedAt
    };
  }

  /** 由 main.js 在启动时和每 30 秒刷新一次（磁盘剩余会变，分辨率一般不变） */
  setMeta(meta) {
    if (meta && typeof meta === 'object') this.meta = { ...this.meta, ...meta };
  }

  /** 拼在 URL 上的机器参数；字段顺序固定，便于抓包看 */
  metaQuery() {
    const p = [];
    if (this.meta.res) p.push('res=' + encodeURIComponent(this.meta.res));
    if (this.meta.ver) p.push('ver=' + encodeURIComponent(this.meta.ver));
    if (this.meta.free) p.push('free=' + Math.round(this.meta.free / 1048576));
    return p.length ? '&' + p.join('&') : '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    // 换过线体就当成空盘：这条线的内容和上一条线完全是两套，不能拿来顶上
    cache.setLine(this.cfg.line || '');
    cache.cleanUpOnStart();

    // ── 先播本地内容，不等网络 ──
    // 断电重启、早上开机、网络还没起来，这几种情况下工人应该立刻看到画面（A5）。
    const local = cache.localItems();
    if (local) {
      this.appliedModelId = local.modelId;
      this.appliedCode = local.modelCode;
      this.appliedFp = fpOf(local.items);
      this.status = 'play';
      this.pushView(local.items, local.modelCode, local.modelId, { reason: 'cold-start' });
    } else {
      this.status = 'boot';
    }
    this.emitStatus(true);
    this.startTelemetry();
    this.loop();
  }

  stop() {
    this.running = false;
    this.stopTelemetry();
    this.abortInflight();
    if (this._wakeRetry) { clearTimeout(this._wakeRetry); this._wakeRetry = null; }
  }

  // ───────────── 遥测 ─────────────

  /**
   * 每 5 秒把「机器参数 + 下载进度」推给服务端。
   *
   * 为什么不搭在长轮询的 query 上：长轮询是"等变化"的，25 秒才回一次；
   * 而管理端右栏的进度条要 2 秒级刷新 —— 挂在长轮询上既看不到进度，又白白把耳朵堵住。
   * 这个请求失败一律静默：遥测丢了不影响生产，下一轮还会再来。
   */
  startTelemetry() {
    this.stopTelemetry();
    const tick = async () => {
      if (!this.running) return;
      try {
        const body = {
          op: this.cfg.op,
          done: this.progress.done,
          total: this.progress.total,
          st: this.status
        };
        if (this.cfg.line) body.line = this.cfg.line;
        if (this.meta.res) body.res = this.meta.res;
        if (this.meta.ver) body.ver = this.meta.ver;
        if (this.meta.free) body.free = Math.round(this.meta.free / 1048576);
        // 1.8.0：计算机名。管理端的客户端列表里「192.168.1.31」变成「3F-XB-01」，
        // 现场说"3楼西北角那台"才找得到是哪一行。老服务端会忽略这个字段。
        if (this.meta.name) body.name = this.meta.name;
        if (this.appliedCode) body.model = this.appliedCode;
        await net.postJson(this.cfg.server, '/api/telemetry', body, { timeoutMs: 6000 });
      } catch { /* 遥测失败无所谓，别在屏上留痕迹 */ }
    };
    this._telTimer = setInterval(tick, 5000);
    this._telTimer.unref?.();
    tick();
  }

  stopTelemetry() {
    if (this._telTimer) { clearInterval(this._telTimer); this._telTimer = null; }
  }

  // ───────────── 主循环 ─────────────

  /** 线体参数：配了才带，没配让服务端按"当前启用的线体"回落（老现场就是这么跑的） */
  lineQuery() {
    return this.cfg.line ? `&line=${encodeURIComponent(this.cfg.line)}` : '';
  }

  async loop() {
    while (this.running) {
      try {
        const st = await net.getJson(
          this.cfg.server,
          `/api/state?op=${encodeURIComponent(this.cfg.op)}&since=${this.lastRev}${this.lineQuery()}${this.metaQuery()}`
        );
        if (!this.running) return;
        this.onLinkUp();
        this.lastRev = Number(st.rev) || this.lastRev;
        this.serverSeq = Number(st.seq) || 0;
        this.online = st.online || [];
        await this.apply(st);
      } catch (e) {
        if (!this.running) return;
        this.onLinkDown(e);
        await this.sleep(this.backoff());
      }
    }
  }

  backoff() {
    this.failCount++;
    if (this.failCount === 1) return 2_000;
    return Math.min(2_000 * Math.pow(2, this.failCount - 1), ONLINE_PUSH_MS);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._wakeRetry = null; resolve(); }, ms);
      this._wakeRetry = () => { clearTimeout(t); this._wakeRetry = null; resolve(); };
    });
  }

  onLinkUp() {
    if (this.linked) { this.failCount = 0; return; }
    this.linked = true;
    this.failCount = 0;
    console.log('[sync] 已连接服务器');
    if (this.status === 'offline') this.status = 'play';
    this.emitStatus(true);
  }

  onLinkDown(e) {
    if (this.linked) {
      this.linked = false;
      console.warn('[sync] 连接断开：', e.message);
    }
    // 断网时画面照旧播本地内容，只把顶栏状态点变灰（A3 / A4）
    if (this.status !== 'offline') {
      this.status = 'offline';
      this.emitStatus(true);
    }
  }

  // ───────────── 状态处理 ─────────────

  async apply(st) {
    const curId = st.currentModelId || '';
    const curCode = st.modelCode || '';
    this.serverCurrentId = curId;
    this.serverContentRev = Number(st.contentRev) || 0;

    // 服务端指定了哪个机种，就播哪个 —— 没有 prepare/举手/集齐再翻那套了。
    // 屏这一侧只剩"下齐 → 校验 → 一次翻页"，网慢就多播一会儿旧的，不等也不抢。
    if (!curId) {
      // 服务端还没指定型号（全新部署），不黑屏，显示等待页
      this.status = 'no-model';
      this.emitStatus();
      return;
    }

    if (curId === this.appliedModelId) {
      // 型号没变，但内容可能被工程部改了（改错图、补注意事项）。
      // appliedContentRev 为 null 表示刚开机还没核对过，也走一次静默核对。
      const checked = this.appliedContentRev !== null;
      if (!checked || (this.serverContentRev && this.serverContentRev !== this.appliedContentRev)) {
        console.log(`[sync] 核对本工序内容（contentRev ${checked ? this.appliedContentRev : '未核对'} → ${this.serverContentRev}）`);
        this.prepared.delete(curId);          // 重新取一次清单，指纹一样就不会闪屏
        this.startPrepare(curId, curCode, { silent: checked === false });
        return;
      }
      // 已经是这个型号了
      this.status = this.missing.length ? 'incomplete' : 'play';
      this.emitStatus();
      return;
    }

    const ready = this.prepared.get(curId);
    if (ready) {
      await this.flipTo(ready, curCode, curId);
      return;
    }

    // ③ 本地没有这套内容。
    //    分两种，不能混：
    //      · 首次装载（盘上本来就空的）—— 新机器/清过数据，是正常冷启动，显示"正在获取内容"
    //      · 掉队（盘上还是上一个型号）—— 服务器等不及强翻了，必须亮红字让人知道不能作业
    const firstLoad = !this.appliedModelId;
    this.status = firstLoad ? 'preparing' : 'stale';
    this.emitStatus(true);
    if (!firstLoad) {
      // 红字已经亮了，下载继续在后台跑；下完下一轮轮询会自己翻过去（自愈）
      console.warn(`[sync] 掉队：本地无 ${curCode} 内容，开始补下载`);
    }
    this.startPrepare(curId, curCode);
  }

  /**
   * 后台准备，不阻塞主循环。
   * 长轮询是终端的耳朵：一旦被下载堵住，就听不到服务端换了型号，
   * 掉队那台会一直显示"准备中"，等于把故障藏起来了。
   */
  startPrepare(modelId, modelCode, opts = {}) {
    if (this.prepared.has(modelId)) return;
    if (this.inflight && this.inflight.modelId === modelId) return;
    this.ensurePrepared(modelId, modelCode, opts).catch(() => { /* 失败由下一轮轮询重试 */ });
  }

  /** 下载并校验某个（型号 × 本工序）。返回是否可用。 */
  async ensurePrepared(modelId, modelCode, opts = {}) {
    if (this.prepared.has(modelId)) return true;
    if (this.inflight && this.inflight.modelId === modelId) {
      await this.inflight.promise;
      return this.prepared.has(modelId);
    }

    this.abortInflight();
    const controller = new AbortController();
    const job = { modelId, controller };

    // silent：刚开机核对同一个型号的内容，画面上本来就在播，别闪一下"准备中"
    if (!opts.silent) {
      this.status = 'preparing';
      this.progress = { done: 0, total: 0 };
      this.missing = [];
      this.emitStatus(true);
    }

    job.promise = (async () => {
      try {
        const list = await net.getJson(
          this.cfg.server,
          `/display/playlist?op=${encodeURIComponent(this.cfg.op)}` +
          `&model=${encodeURIComponent(modelCode || modelId)}${this.lineQuery()}`
        );
        const items = list.items || [];
        const code = list.modelCode || modelCode || '';

        if (!items.length) {
          // 空清单有两种，别混：
          //   · 本来就没配内容 —— 允许切换，屏上显式告警
          //   · 原来有、现在被「播放内容」全排除（hiddenCount>0）—— 管理端明确不让播
          //
          // ⚠️ 这里**不能**直接 return（1.8.3 修）。只改「播放内容」把一项工序全挡住时，
          //    清单会变成 0 项，而屏上还挂着上一次的内容。直接 return 的后果有两个：
          //      ① 不翻转 → 屏继续播着已经被勾掉的内容，人以为改了没生效；
          //      ② 不更新 appliedContentRev → 主循环每 25 秒重新核对一遍，永远收敛不了。
          const hidden = Number(list.hiddenCount) || 0;
          this.prepared.set(modelId, { modelCode: code, items: [], at: Date.now(), hidden });
          this.missing = [];
          this.progress = { done: 0, total: 0 };
          this.emitStatus(true);
          await this.applyPrepared(modelId, code);
          return true;
        }

        const r = await cache.prepareFiles(this.cfg.server, items, {
          signal: controller.signal,
          onProgress: (done, total, name, kind) => {
            this.progress = { done, total };
            this.emitStatus();
          }
        });

        this.prepared.set(modelId, { modelCode: code, items: r.items, at: Date.now() });
        this.missing = r.missing || [];
        this.progress = { done: items.length, total: items.length };
        console.log(
          `[sync] ${code} 就绪：${r.items.length}/${items.length} 项` +
          (r.downloaded ? `，新下载 ${r.downloaded}` : '') +
          (r.skipped ? `，已有 ${r.skipped}` : '') +
          (this.missing.length ? `，缺失 ${this.missing.length}` : '')
        );

        this.emitStatus(true);
        await this.applyPrepared(modelId, code);
        return true;
      } catch (e) {
        if (e.message === 'aborted' || controller.signal.aborted) {
          console.log(`[sync] 取消下载 ${modelCode}（目标已变更）`);
          return false;
        }
        console.warn(`[sync] 准备 ${modelCode} 失败：`, e.message);
        this.status = this.linked ? 'stale' : 'offline';
        this.emitStatus(true);
        // 失败后由主循环的退避重试，不在这里死循环
        return false;
      } finally {
        if (this.inflight === job) this.inflight = null;
      }
    })();

    this.inflight = job;
    await job.promise;
    return this.prepared.has(modelId);
  }

  /**
   * 预备内容就绪之后，决定"要不要真的换画面"。
   *
   * 两处调用：清单非空（下载完）与清单为空（内容被「播放内容」全排除）。
   * 空清单也必须走这里 —— 否则那条"勾掉之后屏上还在播"的路永远绕不过去。
   *
   * 三个不该翻的情况：
   *   · 已经连目标型号都不要了（服务端换了型号）
   *   · 服务端没变化（rev 相同）
   *   · 同型号且指纹一样（变的是别的工序，本机这套其实没动）—— 只更新版本号，不闪屏
   */
  async applyPrepared(modelId, code) {
    if (!this.running || this.serverCurrentId !== modelId) return;
    const prep = this.prepared.get(modelId);
    if (!prep) return;
    const sameModel = this.appliedModelId === modelId;
    if (sameModel && this.serverContentRev === this.appliedContentRev) return;
    if (sameModel && fpOf(prep.items) === this.appliedFp) {
      this.appliedContentRev = this.serverContentRev;
      console.log('[sync] 内容版本更新，但本工序清单未变，不重载');
      return;
    }
    if (!prep.items.length) {
      console.log(
        `[sync] ${code} 本工序无可播内容` +
        (prep.hidden ? `（${prep.hidden} 项被「播放内容」排除）` : '') + '，清屏'
      );
    } else {
      console.log(sameModel ? '[sync] 本工序内容已更新，重载画面' : '[sync] 补播');
    }
    await this.flipTo(prep, code, modelId);
  }

  abortInflight() {
    if (!this.inflight) return;
    try { this.inflight.controller.abort(); } catch { /* ignore */ }
    this.inflight = null;
  }

  /** 翻转：请求渲染层同步换队列，ack 之后再落索引、再删旧文件。 */
  async flipTo(prep, modelCode, modelId) {
    if (this.flipping) return;
    this.flipping = true;
    try {
      // hidden 要一起下发：渲染层靠它区分"本来就没内容"和"内容被播放内容排除"。
      // 前者保留旧画面（绝不翻成黑屏），后者必须真的清掉。
      const ok = await this.pushView(prep.items, modelCode, modelId, {
        reason: 'switch',
        hidden: prep.hidden || 0
      });
      if (!ok) {
        // 渲染层没 ack：不落索引，保住旧画面。下次轮询还会再试。
        console.warn('[sync] 渲染层未确认翻转，保留旧画面');
        this.status = 'stale';
        this.emitStatus(true);
        return;
      }

      cache.commit({ modelCode, modelId, seq: this.serverSeq, line: this.cfg.line || '' }, prep.items);
      this.appliedModelId = modelId;
      this.appliedCode = modelCode;
      this.appliedFp = fpOf(prep.items);
      this.appliedContentRev = this.serverContentRev;
      this.status = prep.items.length ? 'play' : 'incomplete';
      this.emitStatus(true);

      // 翻转已生效，旧内容此刻起没有价值 —— 删。
      // 正在播的文件都在 keep 里，所以这个删除是安全的。
      cache.purgeExcept(prep.items.map((it) => it.file));

      // 顺手清掉别的型号的预备内容（内存里，不占磁盘）
      for (const [id] of this.prepared) if (id !== modelId) this.prepared.delete(id);
    } finally {
      this.flipping = false;
    }
  }

  pushView(items, modelCode, modelId, meta = {}) {
    this.lastView = { items, modelCode, modelId, ...meta };
    if (!this.flipHandler) return Promise.resolve(true);
    return Promise.race([
      Promise.resolve()
        .then(() => this.flipHandler(this.lastView))
        .then(() => true)
        .catch((e) => { console.warn('[sync] 翻转失败：', e.message); return false; }),
      new Promise((resolve) => setTimeout(() => resolve(false), FLIP_TIMEOUT_MS))
    ]);
  }

  /** 状态只在"有意义的变化"时才推送，避免每 25 秒一次的心跳刷屏。 */
  emitStatus(force = false) {
    const snap = this.snapshot();
    const key = [
      snap.status, snap.modelCode, snap.done, snap.total,
      snap.missing.length, snap.linked, snap.seq
    ].join('|');
    if (!force && key === this._statusKey) return;
    this._statusKey = key;
    this.emit('status', snap);
  }
}

module.exports = { Syncer };
