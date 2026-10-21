// 同步引擎：终端与服务器之间唯一的通道。
//
// 只做四件事，按重要性排序：
//   ① 长轮询 /api/state，知道"现在该是哪个型号"
//   ② prepare 阶段把新型号内容下到本地并校验，下完 POST /api/ready 举手
//   ③ 服务器 activate 之后，请求渲染层翻转（渲染层同步换队列），ack 后才删旧文件
//   ④ 网络断了就退回离线态：画面不动、继续播本地内容，指数退避重连
//
// 有一条不能破：**画面翻不翻由磁盘说话**。本地没有这套内容，就不许翻，
// 宁可亮红字让人看见，也不能让工人对着一屏半新半旧判断错了批次。
const EventEmitter = require('node:events');
const net = require('./net');
const cache = require('./cache');

const ONLINE_PUSH_MS = 30_000;   // 断线后的兜底轮询间隔上限
const FLIP_TIMEOUT_MS = 10_000;  // 等渲染层 ack 的上限，超时算翻转失败（保留旧画面）

class Syncer extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.flipHandler = opts.flipHandler || null;   // (view) => Promise<void>，由 main.js 注入（走 IPC）
    this.running = false;
    this.lastRev = 0;
    this.appliedModelId = '';
    this.appliedCode = '';
    this.phase = 'idle';
    this.pendingModelId = '';
    this.pendingCode = '';
    this.status = 'boot';
    this.progress = { done: 0, total: 0 };
    this.missing = [];
    this.online = [];
    this.serverSeq = 0;
    this.linked = false;
    this.failCount = 0;
    this.prepared = new Map();     // modelId -> { modelCode, items, at }
    this.inflight = null;          // { modelId, controller }
    this.flipping = false;
    this.lastView = null;
    this.startedAt = Date.now();
    this._statusKey = '';
    this._wakeRetry = null;
  }

  snapshot() {
    return {
      op: this.cfg.op,
      server: this.cfg.server,
      status: this.status,
      phase: this.phase,
      modelCode: this.appliedCode,
      modelId: this.appliedModelId,
      pendingCode: this.pendingCode,
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

  start() {
    if (this.running) return;
    this.running = true;
    cache.cleanUpOnStart();

    // ── 先播本地内容，不等网络 ──
    // 断电重启、早上开机、网络还没起来，这几种情况下工人应该立刻看到画面（A5）。
    const local = cache.localItems();
    if (local) {
      this.appliedModelId = local.modelId;
      this.appliedCode = local.modelCode;
      this.status = 'play';
      this.pushView(local.items, local.modelCode, local.modelId, { reason: 'cold-start' });
    } else {
      this.status = 'boot';
    }
    this.emitStatus(true);
    this.loop();
  }

  stop() {
    this.running = false;
    this.abortInflight();
    if (this._wakeRetry) { clearTimeout(this._wakeRetry); this._wakeRetry = null; }
  }

  // ───────────── 主循环 ─────────────

  async loop() {
    while (this.running) {
      try {
        const st = await net.getJson(this.cfg.server, `/api/state?op=${encodeURIComponent(this.cfg.op)}&since=${this.lastRev}`);
        if (!this.running) return;
        this.onLinkUp();
        this.lastRev = Number(st.rev) || this.lastRev;
        this.serverSeq = Number(st.seq) || 0;
        this.phase = st.phase || 'idle';
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

    // ① prepare：先把内容备好，画面不动
    if (st.phase === 'prepare' && st.pendingModelId && st.pendingModelId !== this.appliedModelId) {
      this.pendingModelId = st.pendingModelId;
      this.pendingCode = st.pendingModelCode || '';
      await this.ensurePrepared(st.pendingModelId, this.pendingCode);
      return;                                   // 准备期间绝不动画面
    }
    this.pendingModelId = '';
    this.pendingCode = '';

    // ② idle：服务器已经喊翻了
    if (!curId) {
      // 服务端还没指定型号（全新部署），不黑屏，显示等待页
      this.status = 'no-model';
      this.emitStatus();
      return;
    }

    if (curId === this.appliedModelId) {
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
    if (!firstLoad) {
      this.emitStatus(true);
      console.warn(`[sync] 掉队：本地无 ${curCode} 内容，开始补下载`);
    }
    const ok = await this.ensurePrepared(curId, curCode);
    if (ok && this.prepared.get(curId)) {
      await this.flipTo(this.prepared.get(curId), curCode, curId);
    }
  }

  /** 下载并校验某个（型号 × 本工序），完成即举手。返回是否可用。 */
  async ensurePrepared(modelId, modelCode) {
    if (this.prepared.has(modelId)) return true;
    if (this.inflight && this.inflight.modelId === modelId) {
      await this.inflight.promise;
      return this.prepared.has(modelId);
    }

    this.abortInflight();
    const controller = new AbortController();
    const job = { modelId, controller };

    this.status = 'preparing';
    this.progress = { done: 0, total: 0 };
    this.missing = [];
    this.emitStatus(true);

    job.promise = (async () => {
      try {
        const list = await net.getJson(
          this.cfg.server,
          `/display/playlist?op=${encodeURIComponent(this.cfg.op)}&model=${encodeURIComponent(modelCode || modelId)}`
        );
        const items = list.items || [];
        const code = list.modelCode || modelCode || '';

        if (!items.length) {
          // 空清单：允许切换，但屏上必须显式告警，不能静默播空白
          this.prepared.set(modelId, { modelCode: code, items: [], at: Date.now() });
          this.missing = [];
          this.progress = { done: 0, total: 0 };
          await this.reportReady(modelId);
          this.emitStatus(true);
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

        await this.reportReady(modelId);
        this.emitStatus(true);
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

  abortInflight() {
    if (!this.inflight) return;
    try { this.inflight.controller.abort(); } catch { /* ignore */ }
    this.inflight = null;
  }

  async reportReady(modelId) {
    try {
      await net.postJson(this.cfg.server, '/api/ready', { op: this.cfg.op, modelId });
      console.log(`[sync] 已举手 ${this.cfg.op} / ${modelId}`);
    } catch (e) {
      // 409 = 目标已变更，无所谓，下一轮会按新目标重新来
      // 其它错误（断网）也不致命：服务端会超时强翻，本地照样能自愈
      if (e.status !== 409) console.warn('[sync] 举手失败：', e.message);
    }
  }

  /** 翻转：请求渲染层同步换队列，ack 之后再落索引、再删旧文件。 */
  async flipTo(prep, modelCode, modelId) {
    if (this.flipping) return;
    this.flipping = true;
    try {
      const ok = await this.pushView(prep.items, modelCode, modelId, { reason: 'switch' });
      if (!ok) {
        // 渲染层没 ack：不落索引，保住旧画面。下次轮询还会再试。
        console.warn('[sync] 渲染层未确认翻转，保留旧画面');
        this.status = 'stale';
        this.emitStatus(true);
        return;
      }

      cache.commit({ modelCode, modelId, seq: this.serverSeq }, prep.items);
      this.appliedModelId = modelId;
      this.appliedCode = modelCode;
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
      snap.status, snap.phase, snap.modelCode, snap.pendingCode,
      snap.done, snap.total, snap.missing.length, snap.linked, snap.seq
    ].join('|');
    if (!force && key === this._statusKey) return;
    this._statusKey = key;
    this.emit('status', snap);
  }
}

module.exports = { Syncer };
