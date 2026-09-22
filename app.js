/**
 * 输液计时器 · 网页端（H5）
 * ------------------------------------------------------------------
 * 由「输液计时器-网页版复刻完整资料包」中的小程序源码 + 网页版复刻提示词
 * 迁移而来：核心业务逻辑（状态机 / 循环校验 / 参考时长 / 进度与剩余时间）
 * 与平台无关，此处照搬；平台相关能力按对照表替换为浏览器 API。
 *
 * - Taro.StorageSync   -> localStorage（JSON 序列化）
 * - Taro.showModal     -> 自建 Promise 弹窗
 * - Taro.showToast     -> 自建轻提示
 * - Taro.vibrateLong   -> navigator.vibrate
 * - Taro.navigateTo    -> location.hash 路由
 * - useDidShow         -> visibilitychange + 首次加载补报
 *
 * 全部数据仅存本机 localStorage，无网络请求、无患者隐私字段。
 */
'use strict';

(function () {
  /* ============================================================
   * 一、数据层（对应 iv-store.ts）
   * ============================================================ */

  const TASK_KEY = 'iv_bottle_tasks'; // 任务列表
  const SEQ_KEY = 'iv_drug_seq';      // 药品序号自增映射
  const A2HS_KEY = 'iv_a2hs_dismissed';

  /* ---------------- 基础读写（带容错） ---------------- */

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      console.warn('[iv-store] 读取本地存储失败', key, e);
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[iv-store] 写入本地存储失败', key, e);
    }
  }

  /* ---------------- 循环校验（防差错核心） ---------------- */

  const isTs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /**
   * 单条任务校验：
   * 1. 数值字段为有限正数；label 非空；
   * 2. 状态与时间戳一致：pending 无戳；running 只有 startTs；done 两戳齐全且 endTs >= startTs；
   * 3. 声明状态不得超前于推导状态，否则剔除。
   */
  function verifyTask(t) {
    if (!t || typeof t.id !== 'string' || typeof t.label !== 'string' || !t.label) return null;
    if (!Number.isFinite(t.totalMl) || t.totalMl <= 0) return null;
    if (!Number.isFinite(t.dripFactor) || t.dripFactor <= 0) return null;
    if (!Number.isFinite(t.expectedMin) || t.expectedMin <= 0) return null;
    if (!Number.isFinite(t.alertMin) || t.alertMin <= 0) return null;
    if (!Number.isFinite(t.createdTs)) return null;

    const startTs = isTs(t.startTs) ? t.startTs : null;
    const endTs = isTs(t.endTs) ? t.endTs : null;
    if (startTs && endTs && endTs < startTs) return null;

    let derived = 'pending';
    if (startTs && endTs) derived = 'done';
    else if (startTs) derived = 'running';

    const order = ['pending', 'running', 'done'];
    if (order.indexOf(t.status) > order.indexOf(derived)) return null;

    return Object.assign({}, t, {
      manufacturer: typeof t.manufacturer === 'string' ? t.manufacturer : '',
      dripRate: Number.isFinite(t.dripRate) && t.dripRate > 0 ? t.dripRate : undefined,
      startTs: startTs,
      endTs: endTs,
      status: derived,
    });
  }

  function verifyTasks(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const fixed = verifyTask(item);
      if (fixed && !seen.has(fixed.id)) {
        seen.add(fixed.id);
        out.push(fixed);
      }
    }
    return out;
  }

  /** 读取 + 校验 + 修复回写（闭环自检） */
  function loadTasks() {
    const raw = lsGet(TASK_KEY, []);
    const arr = Array.isArray(raw) ? raw : [];
    const verified = verifyTasks(arr);
    if (verified.length !== arr.length) lsSet(TASK_KEY, verified);
    return verified;
  }

  function writeTasks(list) {
    lsSet(TASK_KEY, list);
  }

  /* ---------------- 状态机操作 ---------------- */

  function genId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 药品序号：同一药品名自增，持久化，便于区分不同患者的同类药 */
  function nextLabel(drugName) {
    let map = {};
    const raw = lsGet(SEQ_KEY, null);
    if (raw && typeof raw === 'object') map = raw;
    const n = (map[drugName] || 0) + 1;
    map[drugName] = n;
    lsSet(SEQ_KEY, map);
    return drugName + '-' + String(n).padStart(2, '0');
  }

  function addTask(input) {
    const task = {
      id: genId(),
      label: input.label,
      manufacturer: input.manufacturer,
      totalMl: input.totalMl,
      dripFactor: input.dripFactor,
      dripRate: input.dripRate,
      expectedMin: input.expectedMin,
      alertMin: input.alertMin,
      status: 'pending',
      startTs: null,
      endTs: null,
      createdTs: Date.now(),
    };
    const list = loadTasks();
    list.unshift(task);
    writeTasks(verifyTasks(list));
    return task;
  }

  /**
   * 状态推进：start(pending→running) / finish(running→done)
   * 防差错：先重载校验状态合法才推进；推进后单条复验，通不过不写。
   */
  function advance(id, type) {
    const list = loadTasks();
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const task = list[idx];
    const now = Date.now();

    const allowed =
      (type === 'start' && task.status === 'pending') ||
      (type === 'finish' && task.status === 'running');
    if (!allowed) return null;

    const next = Object.assign({}, task);
    if (type === 'start') {
      next.startTs = now;
      next.status = 'running';
    } else {
      next.endTs = now;
      next.status = 'done';
    }

    const recheck = verifyTask(next);
    if (!recheck || recheck.id !== id) return null;

    list.splice(idx, 1, recheck);
    writeTasks(verifyTasks(list));
    return recheck;
  }

  function removeTask(id) {
    writeTasks(loadTasks().filter((t) => t.id !== id));
  }

  /* ---------------- 计算与格式化 ---------------- */

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  /** 友好时长：1h 15min / 45min */
  function fmtHuman(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0 && m > 0) return h + 'h ' + m + 'min';
    if (h > 0) return h + 'h';
    return m + 'min';
  }

  function fmtClock(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtMonthDay(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /** 已输注毫秒数 */
  function elapsedMs(task, now) {
    if (!task.startTs) return 0;
    const end = task.endTs || now;
    return Math.max(0, end - task.startTs);
  }

  /** 剩余毫秒数（仅 running；可能为负 = 超过参考时长） */
  function remainingMs(task, now) {
    if (task.status !== 'running') return Infinity;
    return task.expectedMin * 60 * 1000 - elapsedMs(task, now);
  }

  /** 进度 0~1 */
  function progress(task, now) {
    const total = task.expectedMin * 60 * 1000;
    if (total <= 0) return 0;
    return Math.min(1, elapsedMs(task, now) / total);
  }

  /** 参考时长：分钟 = 总量ml × 滴系数 ÷ 滴速（至少 1 分钟） */
  function calcMinutes(totalMl, dripFactor, dripRate) {
    if (!(totalMl > 0) || !(dripFactor > 0) || !(dripRate > 0)) return null;
    return Math.max(1, Math.round((totalMl * dripFactor) / dripRate));
  }

  /* ============================================================
   * 二、浏览器能力封装（modal / toast / vibrate / 通知 / 日历）
   * ============================================================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 自建弹窗，替代 Taro.showModal */
  function showModal(opts) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const showCancel = opts.showCancel !== false;
      root.hidden = false;
      root.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<h2>' + esc(opts.title) + '</h2>' +
        '<p class="modal-body">' + esc(opts.content || '') + '</p>' +
        '<div class="modal-actions">' +
        (showCancel ? '<button type="button" class="modal-btn" data-result="0">' + esc(opts.cancelText || '取消') + '</button>' : '') +
        '<button type="button" class="modal-btn ' +
        (opts.tone === 'danger' ? 'modal-btn--danger' : 'modal-btn--primary') +
        '" data-result="1">' + esc(opts.confirmText || '确定') + '</button>' +
        '</div></div>';

      const close = (value) => {
        root.hidden = true;
        root.innerHTML = '';
        resolve(value);
      };

      $$('[data-result]', root).forEach((btn) => {
        btn.addEventListener('click', () => close(btn.getAttribute('data-result') === '1'));
      });
      root.addEventListener('click', (e) => {
        if (e.target === root) close(false);
      });
    });
  }

  /** 自建轻提示，替代 Taro.showToast */
  function showToast(message, ok) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast' + (ok ? ' toast--ok' : '');
    el.textContent = message;
    root.appendChild(el);
    window.setTimeout(() => {
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      window.setTimeout(() => el.remove(), 280);
    }, ok ? 1600 : 2600);
  }

  /** 震动反馈，替代 Taro.vibrateLong / vibrateShort */
  function vibrate(long) {
    try {
      if (navigator.vibrate) navigator.vibrate(long ? [80, 60, 80] : 35);
    } catch (e) { /* 不支持的环境忽略 */ }
  }

  /* ---------------- 系统通知（图片中的「开启推送」） ---------------- */

  const notifySupported = () => typeof window.Notification !== 'undefined';

  function notifyGranted() {
    return notifySupported() && Notification.permission === 'granted';
  }

  function pushNotify(title, body) {
    if (!notifyGranted()) return;
    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body: body, tag: 'iv-timer', icon: './icon.svg' });
    } catch (e) { /* 部分浏览器需 ServiceWorker，忽略 */ }
  }

  const ALARM_KEY = 'iv_alarm_pref';

  /** 音量档位（响铃面板/设置里循环切换） */
  const ALARM_VOLUMES = [
    { value: 1, label: '最大' },
    { value: 0.9, label: '很大' },
    { value: 0.8, label: '较大' },
  ];

  function volumeLabel(v) {
    const hit = ALARM_VOLUMES.filter((x) => x.value === v)[0];
    return hit ? hit.label : '最大';
  }

  function alarmPref() {
    const raw = lsGet(ALARM_KEY, null);
    return {
      sound: raw && ALARM_SOUNDS[raw.sound] ? raw.sound : 'alert',
      // 旧版本默认 0.6 明显偏小：小于 0.8 的一律按最大音量起步
      volume: raw && Number.isFinite(raw.volume) && raw.volume >= 0.8 ? raw.volume : 1,
    };
  }

  function setAlarmPref(patch) {
    lsSet(ALARM_KEY, Object.assign(alarmPref(), patch));
  }

  /** 提醒就绪 = 通知已授权且音频已解锁（浏览器要求用户手势后才能出声） */
  function alertReady() {
    return notifyGranted() && !!audioCtx;
  }

  function syncNotifyButton() {
    const btn = $('#btn-notify');
    const text = $('#notify-text');
    if (!btn) return;
    const on = alertReady() || ntfyConfig().enabled; // 远程推送也算已开启
    btn.classList.toggle('is-on', on);
    if (text) {
      if (on) text.textContent = '提醒已开启';
      else if (notifySupported() && Notification.permission === 'denied') text.textContent = '通知被禁用';
      else text.textContent = '开启提醒';
    }
  }

  /** 开启提醒：解锁音频（响铃）+ 申请系统通知权限 */
  async function enableAlert() {
    keepAllowed = true; // 用户手势来了：允许播放（响铃 + 后台保活）
    const ctx = ensureAudio();
    if (!ctx) {
      showToast('当前浏览器不支持铃声，将用震动 + 通知提醒');
    } else {
      playTone(ctx, 987.77, ctx.currentTime + 0.02, 0.2, 'sine', 0.5); // 试听一声，确认已解锁
      vibrate(false);
    }

    if (!notifySupported()) {
      showToast('提醒已开启：到点会响铃提醒', true);
      syncNotifyButton();
      return;
    }
    if (Notification.permission === 'granted') {
      showToast('提醒已开启：到点响铃 + 系统通知', true);
      syncNotifyButton();
      return;
    }
    if (Notification.permission === 'denied') {
      showToast('通知未授权，到点仍会响铃提醒');
      syncNotifyButton();
      return;
    }
    try {
      const res = await Notification.requestPermission();
      showToast(res === 'granted' ? '提醒已开启：到点响铃 + 系统通知' : '通知未授权，到点仍会响铃提醒', res === 'granted');
    } catch (e) {
      showToast('通知未授权，到点仍会响铃提醒');
    }
    syncNotifyButton();
  }

  /* ---------------- .ics 日历下载（照搬源码逻辑） ---------------- */

  function downloadIcs(task, cancel) {
    if (!task.startTs) return;
    const pad = (n) => String(n).padStart(2, '0');
    const fmtIcs = (ts) => {
      const d = new Date(ts);
      return (
        d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
        pad(d.getHours()) + pad(d.getMinutes()) + '00'
      );
    };
    const endTs = task.startTs + task.expectedMin * 60 * 1000;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    if (cancel) lines.push('METHOD:CANCEL');
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + task.id + '@iv-timer');
    lines.push('DTSTART:' + fmtIcs(endTs));
    lines.push('DTEND:' + fmtIcs(endTs + 5 * 60 * 1000));
    lines.push('SUMMARY:' + (cancel ? '✅ 已完成 ' : '⏰ ') + task.label + ' 预计输完');
    lines.push('DESCRIPTION:参考时长 ' + task.expectedMin + ' 分钟，请查看输注情况');
    if (cancel) {
      lines.push('STATUS:CANCELLED', 'SEQUENCE:1');
    } else {
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT0M', 'ACTION:DISPLAY', 'END:VALARM');
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');

    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = task.label + '-' + (cancel ? '取消提醒' : '提醒') + '.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(cancel ? '已下载，打开即可删除日历提醒' : '已下载，点「打开 → 添加到日历」即可', true);
  }

  /* ============================================================
   * 二.5、到点闹钟（应用内响铃）
   * ------------------------------------------------------------
   * - Web Audio 实时合成铃声，无需音频文件、无网络请求
   * - 到点：循环响铃 + 震动 + 系统通知 + 全屏「停止响铃」面板
   * - 响铃期间申请屏幕常亮（Wake Lock），避免锁屏后静默
   * - 页面被系统挂起时（如 iOS 退到后台）不会响铃，这是网页版的
   *   固有限制，因此保留 .ics 日历导出作为后台兜底
   * ============================================================ */

  /* 只保留一种铃声：急促警报（方波连滴，最醒目、穿透力最强） */
  const ALARM_SOUNDS = {
    alert: { label: '急促警报', wave: 'square', dur: 0.06, gap: 0.85, seq: [1568, 0, 1568, 0, 1568, 0, 1568, 0, 1568] },
  };
  const ALARM_AUTO_STOP_MS = 120000; // 无人处理时 2 分钟自动停止

  let audioCtx = null;
  let masterGain = null;
  let ringTimer = null;
  let vibeTimer = null;
  let wakeLock = null;

  const alarm = { list: [], current: null, stopTimer: null, snooze: new Map(), volume: 0.6 };

  function ensureAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) {
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      const p = audioCtx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    return audioCtx;
  }

  function playTone(ctx, freq, at, dur, wave, vol) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, Math.min(1, vol)), at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  /** 播放一组铃声（闹钟的「一遍」） */
  function playRingBar(soundKey) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const s = ALARM_SOUNDS[soundKey] || ALARM_SOUNDS.alert;
    const t0 = ctx.currentTime + 0.03;
    s.seq.forEach((f, i) => {
      if (f > 0) playTone(ctx, f, t0 + i * (s.dur + 0.05), s.dur, s.wave, 0.95 * alarm.volume);
    });
  }

  /* ---------------- WAV 编码：把铃声离线渲染成音频资源 ---------------- */
  /* 走 <audio> 播放 = 走系统「媒体播放」通道，切后台/锁屏后仍能出声，
     这是网页端能做到的、最接近系统闹钟的方式（合成音只在前台可靠） */

  const ringUrlCache = {};
  let silentUrl = null;

  function encodeWav(samples, sampleRate) {
    const len = samples.length;
    const view = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, 36 + len * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, len * 2, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /** 用与实时合成相同的音符参数，离线渲染「一遍铃声」为可循环的 WAV */
  function renderRingUrl(soundKey) {
    if (ringUrlCache[soundKey]) return ringUrlCache[soundKey];
    const s = ALARM_SOUNDS[soundKey] || ALARM_SOUNDS.alert;
    const sr = 8000;
    const dur = Math.max(0.9, s.gap);
    const len = Math.ceil(dur * sr);
    const pcm = new Float32Array(len);

    const tone = (freq, startSec, noteDur) => {
      const from = Math.max(0, Math.floor(startSec * sr));
      const to = Math.min(len, Math.floor((startSec + noteDur) * sr));
      for (let i = from; i < to; i++) {
        const t = (i - from) / sr;
        const env = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) * (5 / Math.max(0.05, noteDur)));
        const ph = 2 * Math.PI * freq * t;
        let v;
        if (s.wave === 'square') v = Math.sin(ph) > 0 ? 1 : -1;
        else if (s.wave === 'triangle') v = (2 / Math.PI) * Math.asin(Math.sin(ph));
        else v = Math.sin(ph);
        pcm[i] += v * env * 0.9; // 接近满刻度，响度最大化
      }
    };
    s.seq.forEach((f, i) => { if (f > 0) tone(f, i * (s.dur + 0.05), s.dur); });
    for (let i = 0; i < len; i++) pcm[i] = Math.max(-1, Math.min(1, pcm[i])); // 限幅防爆音

    const url = URL.createObjectURL(encodeWav(pcm, sr));
    ringUrlCache[soundKey] = url;
    return url;
  }

  function silentWavUrl() {
    if (!silentUrl) silentUrl = URL.createObjectURL(encodeWav(new Float32Array(4000), 8000));
    return silentUrl;
  }

  /* ---------------- 音频元素 + 媒体会话 + 后台保活 ---------------- */

  let ringAudioEl = null;
  let keepAudioEl = null;
  let keepAllowed = false; // 是否已在用户手势中获得播放许可
  let keepPlaying = false;

  function getRingAudio() {
    if (!ringAudioEl) {
      ringAudioEl = document.createElement('audio');
      ringAudioEl.setAttribute('playsinline', '');
      ringAudioEl.loop = true;
      document.body.appendChild(ringAudioEl);
    }
    return ringAudioEl;
  }

  function getKeepAudio() {
    if (!keepAudioEl) {
      keepAudioEl = document.createElement('audio');
      keepAudioEl.setAttribute('playsinline', '');
      keepAudioEl.loop = true;
      keepAudioEl.src = silentWavUrl();
      document.body.appendChild(keepAudioEl);
    }
    return keepAudioEl;
  }

  function updateMediaSession(task) {
    if (!('mediaSession' in navigator)) return;
    try {
      if (!task) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        return;
      }
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: task.label + ' 输液中',
        artist: '输液计时器 · 参考 ' + task.expectedMin + ' 分钟',
        artwork: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      });
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) { /* 忽略不支持的环境 */ }
  }

  /**
   * 保活：有药品正在输液时保持一路静音播放，
   * 让系统的媒体通道一直活跃 → 切后台/锁屏后定时器仍会跑、铃声仍能出声。
   * 首次启动必须在用户手势中（浏览器自动播放限制）。
   */
  function syncKeepAlive() {
    const running = state.tasks.find((t) => t.status === 'running');
    if (!running) {
      stopKeepAlive();
      updateMediaSession(null);
      return;
    }
    updateMediaSession(running);
    if (!keepAllowed) return; // 等一次用户手势
    const el = getKeepAudio();
    if (keepPlaying && !el.paused) return;
    const p = el.play();
    if (p && p.then) p.then(() => { keepPlaying = true; }).catch(() => { keepPlaying = false; });
    else keepPlaying = true;
  }

  function stopKeepAlive() {
    if (keepAudioEl && !keepAudioEl.paused) {
      try { keepAudioEl.pause(); } catch (e) { /* 忽略 */ }
    }
    keepPlaying = false;
  }

  function startRing(soundKey) {
    stopRing();
    const s = ALARM_SOUNDS[soundKey] || ALARM_SOUNDS.alert;

    // ① 优先用 <audio> 走媒体通道（后台/锁屏可继续出声）
    const el = getRingAudio();
    el.src = renderRingUrl(soundKey);
    el.volume = Math.max(0.08, Math.min(1, alarm.volume));
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* 被拦截时走下面的合成音 */ });

    // ② 每秒检查：<audio> 没在响（被系统暂停/不支持）就用实时合成兜底
    ringTimer = window.setInterval(() => {
      const playing = ringAudioEl && !ringAudioEl.paused && !ringAudioEl.ended;
      if (!playing) playRingBar(soundKey);
    }, s.gap * 1000);
  }

  function stopRing() {
    if (ringTimer) { window.clearInterval(ringTimer); ringTimer = null; }
    if (ringAudioEl && !ringAudioEl.paused) {
      try { ringAudioEl.pause(); ringAudioEl.currentTime = 0; } catch (e) { /* 忽略 */ }
    }
  }

  function startVibe() {
    stopVibe();
    const loop = () => vibrate(true);
    loop();
    vibeTimer = window.setInterval(loop, 1600);
  }

  function stopVibe() {
    if (vibeTimer) { window.clearInterval(vibeTimer); vibeTimer = null; }
  }

  async function acquireWakeLock() {
    try {
      if (!navigator.wakeLock || wakeLock) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* 忽略 */ }
    wakeLock = null;
  }

  /* ---------------- 响铃面板 ---------------- */

  function renderAlarmPanel() {
    const root = $('#alarm-root');
    if (!root) return;
    const task = alarm.current;
    if (!task) {
      root.hidden = true;
      return;
    }
    const now = Date.now();
    const elapsed = elapsedMs(task, now);
    const over = Math.max(0, elapsed - task.expectedMin * 60 * 1000);
    const isTest = task.id === TEST_ALARM_ID;
    root.hidden = false;
    $('#alarm-title').textContent = task.label;
    $('#alarm-sub').textContent = isTest
      ? '响铃测试 · 戴耳机确认能听到声音'
      : '参考时长 ' + task.expectedMin + ' 分钟 · 到点提醒';
    const times = $('.alarm-times', root);
    if (times) times.hidden = isTest;
    const icsBtn = $('#alarm-ics');
    if (icsBtn) icsBtn.hidden = isTest;
    $('#alarm-elapsed').textContent = fmtDuration(elapsed);
    $('#alarm-over').textContent = over > 0 ? fmtDuration(over) : '00:00';
    $('#alarm-sound').textContent = '音量：' + volumeLabel(alarmPref().volume);
  }

  function nextAlarm() {
    // 只响「仍在输液」的任务，避免排队的任务已被结束/删除后还响
    alarm.list = alarm.list.filter((t) => isLiveAlarmTask(t.id));
    alarm.current = alarm.list.shift() || null;
    if (!alarm.current) {
      stopRing();
      stopVibe();
      releaseWakeLock();
      renderAlarmPanel();
      return;
    }
    const pref = alarmPref();
    alarm.volume = pref.volume;
    startRing(pref.sound);
    startVibe();
    acquireWakeLock();
    renderAlarmPanel();
    pushNotify('🔔 到点提醒', alarm.current.label + ' 参考时长已到，请查看输注情况');
    if (alarm.stopTimer) window.clearTimeout(alarm.stopTimer);
    alarm.stopTimer = window.setTimeout(stopAlarm, ALARM_AUTO_STOP_MS);
  }

  /** 触发响铃（已在响的任务不会重复入队） */
  function startAlarm(task) {
    if (!task) return;
    if (alarm.current && alarm.current.id === task.id) return;
    if (alarm.list.some((t) => t.id === task.id)) return;
    alarm.list.push(task);
    if (!alarm.current) nextAlarm();
  }

  function stopAlarm() {
    if (alarm.stopTimer) { window.clearTimeout(alarm.stopTimer); alarm.stopTimer = null; }
    stopRing();
    stopVibe();
    if (alarm.list.length > 0) { nextAlarm(); return; }
    alarm.current = null;
    releaseWakeLock();
    renderAlarmPanel();
  }

  function snoozeAlarm(minutes) {
    const task = alarm.current;
    if (!task) return;
    alarm.snooze.set(task.id, Date.now() + minutes * 60 * 1000);
    showToast('已设为 ' + minutes + ' 分钟后再次响铃');
    stopAlarm();
  }

  /** 响铃面板音量按钮：循环切换档位并即时生效 */
  function cycleAlarmVolume() {
    const cur = alarmPref().volume;
    const idx = ALARM_VOLUMES.map((x) => x.value).indexOf(cur);
    const next = ALARM_VOLUMES[(idx + 1) % ALARM_VOLUMES.length].value;
    setAlarmPref({ volume: next });
    alarm.volume = next;
    if (ringAudioEl) ringAudioEl.volume = next;
    if (!ringAudioEl || ringAudioEl.paused) playRingBar(alarmPref().sound); // 没在响就试听一遍
    renderAlarmPanel();
    showToast('响铃音量：' + volumeLabel(next) + '（' + Math.round(next * 100) + '%）', true);
  }

  /** 贪睡未到期时不再自动响铃 */
  function snoozeReady(task) {
    const at = alarm.snooze.get(task.id);
    if (!at) return true;
    if (Date.now() >= at) {
      alarm.snooze.delete(task.id);
      return true;
    }
    return false;
  }

  /** 任务结束 / 删除时清理它的闹钟状态 */
  function clearAlarmFor(id) {
    alarm.list = alarm.list.filter((t) => t.id !== id);
    alarm.snooze.delete(id);
    if (alarm.current && alarm.current.id === id) stopAlarm();
  }

  /* ---------------- 响铃测试（戴耳机自测用） ---------------- */

  const TEST_ALARM_ID = '__test_ring__';

  /** 响铃是否有效：测试响铃放行，其余必须是"仍在输液"的任务 */
  function isLiveAlarmTask(id) {
    if (id === TEST_ALARM_ID) return true;
    const live = state.tasks.find((x) => x.id === id);
    return !!live && live.status === 'running';
  }

  /** 立即响铃（10 秒后自动停，可点「停止响铃」提前结束） */
  function testRing() {
    closePicker(true);
    keepAllowed = true;
    const pref = alarmPref();
    alarm.volume = pref.volume;
    stopAlarm();
    alarm.list = [];
    alarm.current = { id: TEST_ALARM_ID, label: '响铃测试', expectedMin: 1, startTs: Date.now() };
    startRing(pref.sound);
    startVibe();
    acquireWakeLock();
    renderAlarmPanel();
    if (alarm.stopTimer) window.clearTimeout(alarm.stopTimer);
    alarm.stopTimer = window.setTimeout(stopAlarm, 10000);
  }

  /** 模拟一瓶药：立即开始计时，seconds 秒后走完整响铃流程（提前提醒已静默） */
  function simulateAlarm(seconds) {
    const label = nextLabel('模拟药品');
    const task = addTask({
      label: label,
      manufacturer: '',
      totalMl: 100,
      dripFactor: 20,
      expectedMin: Math.max(0.1, seconds / 60),
      alertMin: 1,
    });
    const started = advance(task.id, 'start');
    if (!started) {
      showToast('模拟失败，请重试');
      return;
    }
    unmarkRinged(started.id);
    state.alerted.add('pre:' + started.id); // 跳过开始瞬间的提前提醒
    reload();
    renderMonitor();
    keepAllowed = true;
    syncKeepAlive();
    showToast('已模拟：' + seconds + ' 秒后自动响铃（' + label + '）', true);
  }

  /* ============================================================
   * 二.6、远程推送（ntfy.sh，开源）
   * ------------------------------------------------------------
   * 彻底关掉网页也能收到提醒：开始输液时把「到点时刻 + 药名」投递给
   * ntfy 服务器（X-At 定时投递），由它到点推送到手机的 ntfy App。
   * 结束/删除任务时用同一个 sequence id 发送 DELETE，撤销定时消息，
   * 保证不会在任务结束后还收到（或残留）提醒。
   * 只上传药名与时间，不含患者信息。
   * ============================================================ */

  const NTFY_KEY = 'iv_ntfy';
  const NTFY_BASE = 'https://ntfy.sh';

  function ntfyConfig() {
    const raw = lsGet(NTFY_KEY, null);
    const topic = raw && typeof raw.topic === 'string' ? raw.topic : '';
    return { enabled: !!(raw && raw.enabled && topic), topic: topic };
  }

  function setNtfyConfig(patch) {
    lsSet(NTFY_KEY, Object.assign(ntfyConfig(), patch));
  }

  function genTopic() {
    return 'iv-timer-' + Math.random().toString(36).slice(2, 8);
  }

  function b64Utf8(str) {
    let bin = '';
    new TextEncoder().encode(str).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  /** 非 ASCII 标题按 RFC 2047 编码（ntfy 支持） */
  function ntfyHeader(str) {
    return /^[\x20-\x7E]*$/.test(str) ? str : '=?UTF-8?B?' + b64Utf8(str) + '?=';
  }

  function ntfySeq(taskId) {
    return 'iv-' + taskId;
  }

  function appUrl() {
    return location.origin + location.pathname;
  }

  /** 预约到点推送：X-At 定时投递（服务端限制 10 秒 ~ 3 天） */
  function scheduleRemoteAlarm(task) {
    const cfg = ntfyConfig();
    if (!cfg.enabled || !task || !task.startTs) return;
    const at = task.startTs + task.expectedMin * 60 * 1000;
    if (at - Date.now() < 15000) return; // 太近就不发了
    fetch(NTFY_BASE + '/' + encodeURIComponent(cfg.topic) + '/' + encodeURIComponent(ntfySeq(task.id)), {
      method: 'POST',
      headers: {
        'X-Title': ntfyHeader('⏰ ' + task.label + ' 参考时长已到'),
        'X-Priority': '5',
        'X-Tags': 'alarm_clock,hospital',
        'X-Click': appUrl(),
        'X-At': String(Math.floor(at / 1000)),
      },
      body: task.label + ' 参考 ' + task.expectedMin + ' 分钟已到，请查看输注情况（若已结束请忽略）',
    })
      .then(() => showToast('已预约远程提醒（关掉网页也会推送）', true))
      .catch(() => showToast('远程提醒预约失败，请检查网络或 topic'));
  }

  /** 撤销预约：同 sequence id 的定时消息会被服务端删除，永不投递 */
  function cancelRemoteAlarm(taskId) {
    const cfg = ntfyConfig();
    if (!cfg.enabled || !taskId) return;
    fetch(NTFY_BASE + '/' + encodeURIComponent(cfg.topic) + '/' + encodeURIComponent(ntfySeq(taskId)), {
      method: 'DELETE',
    }).catch(() => {});
  }

  function testRemoteAlarm(topic) {
    return fetch(NTFY_BASE + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers: {
        'X-Title': ntfyHeader('✅ 输液计时器 · 测试推送'),
        'X-Priority': '4',
        'X-Tags': 'white_check_mark,hospital',
        'X-Click': appUrl(),
      },
      body: '看到这条通知，说明远程提醒配置成功。到点时同样会推送。',
    });
  }

  /* ---------------- 提醒设置面板 ---------------- */

  function showAlertSettings() {
    const root = $('#modal-root');
    const cfg = ntfyConfig();
    const topic = cfg.topic || genTopic();

    root.hidden = false;
    root.innerHTML =
      '<div class="modal modal--settings" role="dialog" aria-modal="true">' +
      '<h2>提醒设置</h2>' +
      '<div class="set-row"><span>响铃与系统通知</span><b id="set-alert-state">' + (alertReady() ? '已开启' : '未开启') + '</b></div>' +
      '<button type="button" class="modal-btn modal-btn--primary set-wide" data-set="enable">' +
      (alertReady() ? '试听铃声' : '开启响铃与通知') +
      '</button>' +
      '<p class="set-hint">响铃在页面打开时最可靠（已加静音保活，切后台/锁屏仍会响）；彻底关掉网页时用下面的远程推送兜底。</p>' +
      '<div class="set-actions">' +
      '<button type="button" class="modal-btn" data-set="ring-now">立即响铃测试</button>' +
      '<button type="button" class="modal-btn" data-set="sim-30">模拟 30 秒后到点</button>' +
      '</div>' +
      '<div class="set-actions">' +
      '<button type="button" class="modal-btn" data-set="volume">音量：' + volumeLabel(alarmPref().volume) + '</button>' +
      '</div>' +
      '<div class="set-row"><span>远程推送 · ntfy.sh</span><b id="set-ntfy-state">' + (cfg.enabled ? '已开启' : '未开启') + '</b></div>' +
      '<label class="set-label" for="set-topic">topic（手机 ntfy App 订阅同一个）</label>' +
      '<input class="set-input" id="set-topic" type="text" spellcheck="false" autocomplete="off" value="' + esc(topic) + '" />' +
      '<div class="set-actions">' +
      '<button type="button" class="modal-btn" data-set="ntfy-on">保存并测试</button>' +
      '<button type="button" class="modal-btn" data-set="ntfy-off">关闭远程推送</button>' +
      '</div>' +
      '<p class="set-hint" id="set-msg">手机装 ntfy App → 订阅该 topic，关掉网页也能收到到点推送。只上传药名与时间，不含患者信息。</p>' +
      '<button type="button" class="modal-btn modal-btn--primary set-wide" data-set="close">完成</button>' +
      '</div>';

    const close = () => {
      root.onclick = null;
      root.hidden = true;
      root.innerHTML = '';
    };
    const msg = (text, ok) => {
      const el = $('#set-msg');
      if (el) {
        el.textContent = text;
        el.classList.toggle('is-ok', !!ok);
      }
      if (ok) showToast(text, true);
    };

    root.onclick = async (e) => {
      const btn = e.target.closest('[data-set]');
      if (!btn) {
        if (e.target === root) close();
        return;
      }
      const act = btn.getAttribute('data-set');

      if (act === 'close') { close(); return; }

      if (act === 'ring-now') { close(); testRing(); return; }

      if (act === 'sim-30') { close(); simulateAlarm(30); return; }

      if (act === 'volume') {
        cycleAlarmVolume();
        btn.textContent = '音量：' + volumeLabel(alarmPref().volume);
        return;
      }

      if (act === 'enable') {
        await enableAlert();
        const stateEl = $('#set-alert-state');
        if (stateEl) stateEl.textContent = alertReady() ? '已开启' : '未开启';
        btn.textContent = alertReady() ? '试听铃声' : '开启响铃与通知';
        return;
      }

      if (act === 'ntfy-on') {
        const input = $('#set-topic');
        const t = (input ? input.value : '').trim().toLowerCase();
        if (!/^[a-z0-9_-]{3,64}$/.test(t)) {
          msg('topic 只能用小写字母、数字、- 和 _（3~64 位）');
          return;
        }
        setNtfyConfig({ enabled: true, topic: t });
        msg('正在发送测试推送…');
        try {
          await testRemoteAlarm(t);
          msg('已开启：手机应能收到测试推送（topic: ' + t + '）', true);
          const st = $('#set-ntfy-state');
          if (st) st.textContent = '已开启';
        } catch (err) {
          msg('发送失败，请检查网络后重试');
        }
        return;
      }

      if (act === 'ntfy-off') {
        setNtfyConfig({ enabled: false });
        const st = $('#set-ntfy-state');
        if (st) st.textContent = '未开启';
        msg('已关闭远程推送');
      }
    };
  }

  /* ============================================================
   * 三、监护台视图
   * ============================================================ */

  const PAGE_SIZE = 8; // 病区药品多时分页浏览

  const RINGED_KEY = 'iv_ringed'; // 到点响铃标记（持久化：重开页面不再重复响）

  const state = {
    tasks: [],
    tab: 'active',
    page: 0,
    expandId: null,
    alerted: new Set(), // 提前提醒（每个任务一次）
    ringed: new Set(lsGet(RINGED_KEY, [])), // 到点响铃（每个任务一次，持久化防重复）
  };

  function markRinged(id) {
    state.ringed.add(id);
    lsSet(RINGED_KEY, Array.from(state.ringed));
  }

  function unmarkRinged(id) {
    state.ringed.delete(id);
    lsSet(RINGED_KEY, Array.from(state.ringed));
  }

  const ICON_CHEVRON_DOWN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const ICON_CHEVRON_UP =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
  const ICON_CALENDAR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M8 3v3M16 3v3M3 9.5h18"/></svg>';
  const ICON_STOP =
    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const ICON_TIMER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.4" r="7.6"/><path d="M12 10.4v3.2l2.2 1.4"/><path d="M9.4 3h5.2"/></svg>';

  function reload() {
    state.tasks = loadTasks();
  }

  function currentList() {
    const active = state.tasks.filter((t) => t.status !== 'done');
    const done = state.tasks.filter((t) => t.status === 'done');
    return state.tab === 'active' ? active : done;
  }

  function renderMonitor() {
    reload();
    const activeList = state.tasks.filter((t) => t.status !== 'done');
    const doneList = state.tasks.filter((t) => t.status === 'done');

    $('#cnt-active').textContent = String(activeList.length);
    $('#cnt-done').textContent = String(doneList.length);
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-tab') === state.tab));

    const shown = currentList();
    const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    if (state.page > pageCount - 1) state.page = pageCount - 1;
    const pageItems = shown.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

    /* -------- 已结束：顶部统计（完成瓶数 / 平均单瓶用时） -------- */
    const stats = $('#stats');
    stats.hidden = state.tab !== 'done';
    if (state.tab === 'done') {
      const now = Date.now();
      const avg = doneList.length > 0
        ? doneList.reduce((sum, t) => sum + elapsedMs(t, now), 0) / doneList.length
        : 0;
      $('#stat-count').textContent = String(doneList.length);
      $('#stat-avg').textContent = fmtHuman(avg);
    }

    /* -------- 列表 -------- */
    const list = $('#list');
    if (pageItems.length === 0) {
      list.innerHTML =
        '<div class="empty">' + ICON_TIMER +
        '<span>' + (state.tab === 'active' ? '暂无进行中的药品' : '暂无已结束的记录') + '</span>' +
        (state.tab === 'active' ? '<small>点底部「+ 新增特殊药品」开始</small>' : '<small>结束输液后自动归档</small>') +
        '</div>';
    } else {
      list.innerHTML = pageItems.map((t) => (state.expandId === t.id ? fullCard(t) : miniCard(t))).join('');
    }

    /* -------- 分页栏 -------- */
    const pager = $('#pager');
    pager.hidden = pageCount <= 1;
    if (pageCount > 1) {
      $('#pager-info').textContent = (state.page + 1) + ' / ' + pageCount;
      $('[data-page="prev"]', pager).disabled = state.page <= 0;
      $('[data-page="next"]', pager).disabled = state.page >= pageCount - 1;
    }

    // 兜底：已结束 / 已删除的任务不应保留响铃或排队
    alarm.list = alarm.list.filter((t) => isLiveAlarmTask(t.id));
    if (alarm.current && !isLiveAlarmTask(alarm.current.id)) stopAlarm();

    updateLive();
  }

  /* ---------------- 卡片模板 ---------------- */

  function miniCard(t) {
    return (
      '<button type="button" class="card-mini" data-id="' + t.id + '" data-role="mini" data-act="toggle">' +
      '<span class="card-mini-left">' +
      '<i class="dot dot--' + t.status + '"></i>' +
      (t.createdTs ? '<span class="badge num">' + esc(fmtMonthDay(t.createdTs)) + '</span>' : '') +
      '<span class="card-mini-name">' + esc(t.label) + '</span>' +
      '</span>' +
      '<span class="card-mini-right">' +
      '<span class="card-mini-time num" data-live="mini-time"></span>' +
      '<span class="card-mini-chevron">' + ICON_CHEVRON_DOWN + '</span>' +
      '</span>' +
      '</button>'
    );
  }

  function fullCard(t) {
    const ref = t.specRef;
    const spec =
      '<div class="spec-grid">' +
      '<div class="spec-item">总量：<b>' + esc(t.totalMl) + ' ml</b></div>' +
      '<div class="spec-item">滴系数：<b>' + esc(t.dripFactor) + ' 滴/ml</b></div>' +
      '<div class="spec-item">滴速：<b>' + (t.dripRate ? esc(t.dripRate) + ' 滴/分' : '—') + '</b></div>' +
      '<div class="spec-item">限速等级：<b>' + (ref && ref.level ? esc(ref.level) : '—') + '</b></div>' +
      '</div>' +
      (ref
        ? '<div class="card-spec-ref">' +
          '<span class="card-spec-ref-tag">输液规范</span>' +
          '<span class="card-spec-ref-text">' +
          esc(ref.name) +
          (ref.cls ? ' · ' + esc(ref.cls) : '') +
          (ref.timeText ? ' · 规范输注 ' + esc(ref.timeText) : '') +
          (ref.rateText ? ' · 推荐滴速 ' + esc(ref.rateText) + ' 滴/分' : '') +
          (ref.solvent ? ' · ' + esc(ref.solvent) : '') +
          '</span>' +
          (ref.refMin
            ? '<span class="card-spec-ref-time">参照 ' + (ref.refOpen ? '≥ ' : '') + esc(ref.refMin) + ' 分钟</span>'
            : '') +
          '</div>'
        : '');

    let body = '';
    if (t.status === 'running') {
      body =
        '<span class="timer num" data-live="timer"></span>' +
        '<div class="progress"><i data-live="progress"></i></div>' +
        '<div class="meta-row">' +
        '<span>参考时长 ' + esc(t.expectedMin) + ' 分钟</span>' +
        '<span class="meta-right" data-live="remain"></span>' +
        '</div>';
    } else if (t.status === 'done') {
      body =
        '<span class="timer timer--done num" data-live="timer"></span>' +
        '<div class="progress"><i data-live="progress"></i></div>' +
        '<div class="meta-row">' +
        '<span>开始 ' + esc(fmtClock(t.startTs)) + ' · 结束 ' + esc(fmtClock(t.endTs)) + '</span>' +
        '<span class="meta-right">参考 ' + esc(t.expectedMin) + ' 分钟</span>' +
        '</div>';
    } else {
      body =
        '<div class="meta-row" style="padding-top:12px">' +
        '<span>参考时长 ' + esc(t.expectedMin) + ' 分钟 · 提前 ' + esc(t.alertMin) + ' 分钟提醒</span>' +
        '</div>';
    }

    let actions = '';
    if (t.status === 'pending') {
      actions =
        '<button type="button" class="btn-success" data-act="start">' + ICON_PLAY + '开始输液</button>' +
        '<button type="button" class="btn-soft" data-act="delete">删除</button>';
    } else if (t.status === 'running') {
      actions =
        '<button type="button" class="btn-soft" data-act="ics">' + ICON_CALENDAR + '到点提醒我</button>' +
        '<button type="button" class="btn-danger" data-act="finish">' + ICON_STOP + '结束输液</button>';
    } else {
      actions = '<button type="button" class="btn-soft btn-block" data-act="delete">删除记录</button>';
    }

    return (
      '<article class="card" data-id="' + t.id + '" data-role="full">' +
      '<button type="button" class="card-head" data-act="toggle">' +
      '<i class="dot dot--' + t.status + '"></i>' +
      (t.createdTs ? '<span class="badge num">' + esc(fmtMonthDay(t.createdTs)) + '</span>' : '') +
      '<span class="card-name">' + esc(t.label) + '</span>' +
      '<span class="card-head-time num" data-live="head-time"></span>' +
      '<span class="card-head-chevron">' + ICON_CHEVRON_UP + '</span>' +
      '</button>' +
      spec + body +
      '<div class="card-actions">' + actions + '</div>' +
      '</article>'
    );
  }

  /* ---------------- 每秒动态刷新 ---------------- */

  function updateLive() {
    const now = Date.now();
    for (const t of state.tasks) {
      const elapsed = elapsedMs(t, now);
      const mini = $('[data-role="mini"][data-id="' + t.id + '"]');
      const card = $('[data-role="full"][data-id="' + t.id + '"]');

      const miniTime = mini && $('[data-live="mini-time"]', mini);
      if (miniTime) {
        if (t.status === 'pending') miniTime.textContent = '待开始';
        else if (t.status === 'running') miniTime.textContent = '已输 ' + fmtHuman(elapsed);
        else miniTime.textContent = '用时 ' + fmtHuman(elapsed);
      }

      if (!card) continue;

      const headTime = $('[data-live="head-time"]', card);
      if (headTime) headTime.textContent = t.status === 'pending' ? '待开始' : fmtDuration(elapsed);

      const timer = $('[data-live="timer"]', card);
      if (timer) {
        timer.textContent = t.status === 'done' ? '本瓶用时 ' + fmtDuration(elapsed) : fmtDuration(elapsed);
      }

      const bar = $('[data-live="progress"]', card);
      if (bar) bar.style.width = Math.min(100, Math.round(progress(t, now) * 100)) + '%';

      const remain = $('[data-live="remain"]', card);
      if (remain && t.status === 'running') {
        const rem = remainingMs(t, now);
        if (rem <= 0) {
          remain.textContent = '已超参考 ' + fmtDuration(-rem);
          remain.classList.add('over');
        } else {
          remain.textContent = '参考剩余 ' + fmtDuration(rem);
          remain.classList.remove('over');
        }
      }
    }
  }

  /* ---------------- 操作（弹窗确认 + 震动反馈） ---------------- */

  async function onStart(task) {
    const ok = await showModal({
      title: '请确认',
      content: '药品：' + task.label + '\n时间：' + fmtClock(Date.now()) + '\n开始输液计时？',
      confirmText: '确认开始',
      cancelText: '取消',
    });
    if (!ok) return;
    const result = advance(task.id, 'start');
    if (!result) {
      showToast('状态已变化，请重试');
      renderMonitor();
      return;
    }
    vibrate(true);
    // 重新开始计时：重置该任务的提醒状态
    unmarkRinged(result.id);
    state.alerted.delete('pre:' + result.id);
    keepAllowed = true;
    syncKeepAlive(); // 开始输液 → 启动后台保活（切后台/锁屏也能响）
    scheduleRemoteAlarm(result); // 预约远程推送（关掉网页也能收到）
    const willFinishAt = result.startTs + result.expectedMin * 60 * 1000;
    await showModal({
      title: '✅ 已开始输注',
      content:
        result.label + '\n预计 ' + fmtClock(willFinishAt) + ' 左右输完（参考）\n' +
        '可点「到点提醒我」导出日历，到点系统日历锁屏提醒',
      confirmText: '知道了',
      showCancel: false,
    });
    renderMonitor();
  }

  async function onFinish(task) {
    const ok = await showModal({
      title: '请确认',
      content: '结束「' + task.label + '」输液？\n将记录本瓶实际输注时长。',
      confirmText: '确认结束',
      cancelText: '取消',
    });
    if (!ok) return;
    const result = advance(task.id, 'finish');
    if (!result) {
      showToast('状态已变化，请重试');
      renderMonitor();
      return;
    }
    vibrate(true);
    reload(); // 先让内存状态与磁盘一致，否则定时器会用过期状态重新触发响铃
    clearAlarmFor(result.id); // 结束输液即停止该任务的响铃
    unmarkRinged(result.id);
    cancelRemoteAlarm(result.id); // 撤销已预约的远程推送
    // 任务结束后：日历提醒视为完成，自动生成取消文件删除对应提醒
    downloadIcs(result, true);
    renderMonitor(); // 立即刷新列表，不等弹窗关闭
    await showModal({
      title: '✅ 本瓶输注完成',
      content:
        result.label + ' 实际输注时长：' + fmtHuman(elapsedMs(result, result.endTs)) +
        '\n可以开始输注其他药品了。',
      confirmText: '知道了',
      showCancel: false,
    });
    renderMonitor();
  }

  async function onDelete(task) {
    const ok = await showModal({
      title: '删除确认',
      content: '确认删除「' + task.label + '」？此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    clearAlarmFor(task.id);
    unmarkRinged(task.id);
    cancelRemoteAlarm(task.id); // 删除即撤销远程推送
    removeTask(task.id);
    reload();
    if (state.expandId === task.id) state.expandId = null;
    renderMonitor();
  }

  function showHelp() {
    showModal({
      title: '使用说明',
      content:
        '1. 先点右上角「开启提醒」，解锁响铃与通知权限（只需一次）\n' +
        '2. 点底部「+ 新增特殊药品」，选择或输入药名（勿填患者姓名）\n' +
        '3. 选中规范库药品后，会按当前含量给出参照输注时间\n' +
        '4. 按「开始输液」计时；参考时长到点后会像闹钟一样响铃，\n' +
        '   响铃页可「停止响铃」「5 分钟后提醒」、或点「音量」调整响铃大小\n' +
        '5. 有药品正在输液时会保持一路静音播放（锁屏可见播放控制），\n' +
        '   让切后台/锁屏后仍能响铃；若彻底关闭本页面则无法响铃，\n' +
        '   可提前点「到点提醒我」导出日历做后台兜底\n' +
        '6. 想「彻底关掉网页也能收到」，点右上角「提醒设置」填一个 ntfy topic，\n' +
        '   手机装 ntfy App 订阅同一 topic，到点由服务器推送（只上传药名与时间）\n' +
        '7. 建议「添加到主屏幕」后使用，响铃与保活更稳定\n' +
        '预计时长仅供参考，可随时结束。',
      confirmText: '知道了',
      showCancel: false,
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindMonitor() {
    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const tab = btn.getAttribute('data-tab');
      if (tab === state.tab) return;
      state.tab = tab;
      state.page = 0;
      state.expandId = null;
      renderMonitor();
    });

    $('#btn-notify').addEventListener('click', showAlertSettings);
    $('#btn-help').addEventListener('click', showHelp);

    // 响铃面板
    $('#alarm-stop').addEventListener('click', stopAlarm);
    $('#alarm-snooze').addEventListener('click', () => snoozeAlarm(5));
    $('#alarm-sound').addEventListener('click', cycleAlarmVolume);
    $('#alarm-ics').addEventListener('click', () => {
      if (alarm.current) downloadIcs(alarm.current, false);
    });
    $('#btn-add').addEventListener('click', () => { location.hash = '#/add'; });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('.pager-btn');
      if (!btn || btn.disabled) return;
      const dir = btn.getAttribute('data-page');
      state.page += dir === 'prev' ? -1 : 1;
      state.expandId = null;
      renderMonitor();
    });

    $('#list').addEventListener('click', (e) => {
      const node = e.target.closest('[data-act]');
      if (!node) return;
      const act = node.getAttribute('data-act');
      const holder = e.target.closest('[data-id]');
      if (!holder) return;
      const id = holder.getAttribute('data-id');
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return;

      if (act === 'toggle') {
        state.expandId = state.expandId === id ? null : id;
        renderMonitor();
      } else if (act === 'start') {
        onStart(task);
      } else if (act === 'finish') {
        onFinish(task);
      } else if (act === 'ics') {
        downloadIcs(task, false);
      } else if (act === 'delete') {
        onDelete(task);
      }
    });

    const a2hs = $('#a2hs-tip');
    const isStandalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && !isStandalone && !lsGet(A2HS_KEY, false)) a2hs.hidden = false;
    $('#a2hs-close').addEventListener('click', () => {
      a2hs.hidden = true;
      lsSet(A2HS_KEY, true);
    });
  }

  /* ============================================================
   * 四、新增特殊药品视图
   * ============================================================ */

  const DURATIONS = [15, 30, 45, 60, 90, 120];
  const ALERTS = [1, 3, 5, 10, 15];

  let submitting = false;

  /* ---------------- 静脉输液规范（specs.js） ---------------- */

  const SPECS = Array.isArray(window.IV_SPECS) ? window.IV_SPECS : [];

  /** 名称匹配：精确优先，其次「包含」，多项命中取最长者（如 头孢他啶阿维巴坦 优先于 头孢他啶） */
  function findSpec(name) {
    const key = String(name || '').trim().replace(/\s+/g, '');
    if (!key) return null;
    let exact = null;
    let partial = null;
    for (const s of SPECS) {
      const n = String(s.name).replace(/\s+/g, '');
      if (n === key) { exact = s; break; }
      if (n.indexOf(key) >= 0 || key.indexOf(n) >= 0) {
        if (!partial || n.length > String(partial.name).replace(/\s+/g, '').length) partial = s;
      }
    }
    return exact || partial;
  }

  function fmtNum(n) {
    const v = Number(n);
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  }

  function levelTone(level) {
    const s = String(level || '');
    if (s.indexOf('极慢') >= 0) return 'slow';
    if (s.indexOf('缓慢') >= 0) return 'care';
    return 'normal';
  }

  /**
   * 规范参照时间：把规范里的「推荐溶媒用量区间 + 输注时间区间」按当前含量换算
   * - 含量落在推荐用量区间内：按区间线性插值（100-250ml → 30-60min，则 250ml 得 60min）
   * - 含量落在区间外：按中位容量比例折算，并提示核对
   * - 单一容量（成品 / 固定溶媒）：按含量与规范容量比例折算
   */
  function specReference(spec, ml) {
    if (!spec) return null;
    const tMin = Number(spec.timeMin);
    const tMax = Number.isFinite(Number(spec.timeMax)) ? Number(spec.timeMax) : tMin;
    if (!Number.isFinite(tMin)) return null;

    const vMin = Number(spec.volMin);
    const vMax = Number.isFinite(Number(spec.volMax)) ? Number(spec.volMax) : vMin;
    const open = !!spec.timeOpen;
    const volume = Number(ml);

    let minutes;
    let scope;
    if (!Number.isFinite(vMin) || !(volume > 0)) {
      minutes = open ? tMin : Math.round((tMin + tMax) / 2);
      scope = 'time-only';
    } else if (vMax > vMin && volume >= vMin && volume <= vMax) {
      minutes = Math.round(tMin + ((volume - vMin) / (vMax - vMin)) * (tMax - tMin));
      scope = 'in-range';
    } else {
      const capMid = (vMin + vMax) / 2;
      const tMid = (tMin + tMax) / 2;
      minutes = Math.round(tMid * (volume / capMid));
      scope = 'out-range';
    }

    minutes = Math.max(1, minutes);
    return {
      minutes: minutes,
      open: open,
      scope: scope,
      text: (open ? '≥ ' : '约 ') + minutes + ' 分钟',
    };
  }

  /* ---------------- 自定义滑动选择器（shadcn Select 风格） ---------------- */

  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 12.6l4.6 4.6L19.4 6.6"/></svg>';

  const PICKERS = {
    drug: {
      title: '选择药品 · 静脉输液规范',
      get: () => $('#f-name').value.trim(),
      set: (v) => { $('#f-name').value = v; },
      view: (v) => (v ? v : '从规范库选择'),
      options: () =>
        SPECS.map((s) => ({
          value: s.name,
          label: s.name,
          hint: [s.spec, s.timeText].filter(Boolean).join(' · '),
          group: s.cls || '其他抗菌药物',
        })),
    },
    factor: {
      title: '滴系数（滴/ml）',
      get: () => $('#f-factor').value,
      set: (v) => { $('#f-factor').value = v; },
      view: (v) => String(v),
      options: () => [
        { value: '15', label: '15 滴/ml', hint: '小儿 / 精密输液器常见' },
        { value: '20', label: '20 滴/ml', hint: '常规输液器（默认）' },
        { value: '60', label: '60 滴/ml', hint: '微量泵 / 精密过滤' },
      ],
    },
    duration: {
      title: '参考时长',
      get: () => $('#f-duration').value,
      set: (v) => { $('#f-duration').value = v; },
      view: (v) => (DURATIONS.indexOf(Number(v)) >= 0 ? v + ' 分钟' : v + ' 分钟（规范参照）'),
      options: () =>
        DURATIONS.map((m) => ({
          value: String(m),
          label: m + ' 分钟',
          hint: m <= 30 ? '短时输注' : m >= 90 ? '延长输注' : '',
        })),
    },
    alert: {
      title: '提前提醒',
      get: () => $('#f-alert').value,
      set: (v) => { $('#f-alert').value = v; },
      view: (v) => '还剩 ' + v + ' 分钟时提醒我',
      options: () =>
        ALERTS.map((m) => ({
          value: String(m),
          label: '还剩 ' + m + ' 分钟',
          hint: m <= 3 ? '更贴近到点' : m >= 10 ? '预留备药时间' : '',
        })),
    },
  };

  let activePicker = null;
  let pickerBound = false;

  function pickerOptionHtml(o, current) {
    const selected = String(o.value) === String(current);
    return (
      '<button type="button" class="picker-item' + (selected ? ' is-selected' : '') + '"' +
      ' data-value="' + esc(o.value) + '" role="option" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span class="picker-item-body">' +
      '<span class="picker-item-label">' + esc(o.label) + '</span>' +
      (o.hint ? '<small class="picker-item-hint">' + esc(o.hint) + '</small>' : '') +
      '</span>' +
      '<span class="picker-item-check">' + ICON_CHECK + '</span>' +
      '</button>'
    );
  }

  function openPicker(key, trigger) {
    const cfg = PICKERS[key];
    if (!cfg) return;
    const root = $('#picker-root');

    // 再点同一个触发按钮 = 收起面板（避免连点造成开/关动画叠加）
    if (!root.hidden && activePicker && activePicker.key === key && activePicker.trigger === trigger) {
      closePicker(false);
      return;
    }
    closePicker(true);
    root.classList.remove('is-open', 'is-closing');

    const current = cfg.get();
    const groups = [];
    cfg.options().forEach((o) => {
      const name = o.group || '';
      const last = groups[groups.length - 1];
      if (!last || last.name !== name) groups.push({ name: name, items: [o] });
      else last.items.push(o);
    });

    root.hidden = false;
    root.innerHTML =
      '<div class="picker-sheet" role="dialog" aria-modal="true">' +
      '<span class="picker-grabber" aria-hidden="true"></span>' +
      '<div class="picker-head">' +
      '<span class="picker-title">' + esc(cfg.title) + '</span>' +
      '<button type="button" class="picker-close" aria-label="关闭">' + ICON_CLOSE + '</button>' +
      '</div>' +
      '<div class="picker-list" role="listbox">' +
      groups
        .map(
          (g) =>
            (g.name ? '<div class="picker-group">' + esc(g.name) + '</div>' : '') +
            g.items.map((o) => pickerOptionHtml(o, current)).join('')
        )
        .join('') +
      '</div>' +
      '<div class="picker-foot"><span class="picker-hint">上下滑动选择</span></div>' +
      '</div>';

    void root.offsetHeight; // 强制回流，保证收起态先落地，过渡才能正常播放
    root.classList.add('is-open');

    if (!pickerBound) {
      pickerBound = true;
      root.addEventListener('click', onPickerClick);
    }
    activePicker = { key: key, trigger: trigger || null };
    if (trigger) trigger.setAttribute('aria-expanded', 'true');

    // 打开时把当前选中项滚到列表中间，形成「定位到当前值」的滑动手感
    const centerSelected = () => {
      const list = $('.picker-list', root);
      const sel = $('.picker-item.is-selected', root);
      if (!list || !sel) return;
      list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2);
    };
    window.requestAnimationFrame(centerSelected);
    window.setTimeout(centerSelected, 140); // 兜底：等面板过渡完成后再定位一次
  }

  function onPickerClick(e) {
    const root = $('#picker-root');
    if (!activePicker) return;
    if (e.target.closest('.picker-close')) { closePicker(false); return; }

    const item = e.target.closest('.picker-item');
    if (item) {
      const cfg = PICKERS[activePicker.key];
      if (cfg && cfg.set) cfg.set(item.getAttribute('data-value'));
      $$('.picker-item', root).forEach((el) => {
        const on = el === item;
        el.classList.toggle('is-selected', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      vibrate(false);
      window.setTimeout(() => {
        closePicker(false);
        syncForm();
      }, 170); // 留出选中反馈时间再收起面板
      return;
    }
    if (e.target === root) closePicker(false);
  }

  function closePicker(immediate) {
    const root = $('#picker-root');
    if (!root) return;
    const sheet = $('.picker-sheet', root);
    const finish = () => {
      if (activePicker && activePicker.trigger) activePicker.trigger.setAttribute('aria-expanded', 'false');
      activePicker = null;
      root.classList.remove('is-open', 'is-closing');
      root.hidden = true;
      root.innerHTML = '';
    };
    if (root.hidden) {
      activePicker = null;
      root.classList.remove('is-open', 'is-closing');
      return;
    }
    if (immediate || !sheet) { finish(); return; }
    root.classList.add('is-closing'); // 面板下滑 + 遮罩淡出
    window.setTimeout(finish, 210);
  }

  /** 表单视图同步：选择器文本 + 自动参考时长 + 规范参照 */
  function syncForm() {
    Object.keys(PICKERS).forEach((key) => {
      const el = document.getElementById('view-' + key);
      if (el) el.textContent = PICKERS[key].view(PICKERS[key].get());
    });
    syncAutoDuration();
    renderSpecRef();
  }

  /* ---------------- 输液规范参照展示 ---------------- */

  function renderSpecRef() {
    const wrap = $('#spec-ref');
    const spec = findSpec($('#f-name').value);
    if (!spec) {
      wrap.hidden = true;
      return;
    }

    const mlRaw = Number($('#f-ml').value);
    const hasMl = Number.isFinite(mlRaw) && mlRaw > 0;
    const capMid = (Number(spec.volMin) + Number(spec.volMax)) / 2;
    const useMl = hasMl ? mlRaw : capMid;
    const ref = specReference(spec, useMl);
    const rate = Number($('#f-rate').value);
    const hasRate = Number.isFinite(rate) && rate > 0;

    wrap.hidden = false;
    const levelEl = $('#spec-ref-level');
    levelEl.textContent = spec.level || '规范';
    levelEl.setAttribute('data-tone', levelTone(spec.level));

    $('#spec-ref-time').textContent = ref ? ref.text : '—';
    $('#spec-ref-cap').textContent = hasMl
      ? '当前含量 ' + fmtNum(useMl) + ' ml 对应'
      : '按规范容量 ' + fmtNum(capMid) + ' ml 估算，填总量后重算';

    const rows = [
      ['药物分类', spec.cls || '—'],
      ['常用规格', spec.spec || '—'],
      ['推荐溶媒', spec.solvent || '—'],
      ['推荐滴速', spec.rateText ? spec.rateText + ' 滴/分' : '—'],
      ['规范输注', spec.timeText || '—'],
    ];
    $('#spec-ref-grid').innerHTML = rows
      .map((r) => '<div class="spec-ref-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>')
      .join('');

    const note = $('#spec-ref-note');
    note.hidden = !spec.note;
    note.textContent = spec.note ? '注意事项：' + spec.note : '';

    const warns = [];
    if (
      hasMl && Number(spec.volMax) > Number(spec.volMin) &&
      (useMl < Number(spec.volMin) - 0.5 || useMl > Number(spec.volMax) + 0.5)
    ) {
      warns.push('总量 ' + fmtNum(useMl) + ' ml 不在规范推荐溶媒用量（' + spec.solvent + '）内，请核对');
    }
    if (
      hasRate && Number(spec.rateMin) > 0 &&
      (rate < Number(spec.rateMin) - 0.5 || rate > Number(spec.rateMax) + 0.5)
    ) {
      warns.push('滴速 ' + rate + ' 滴/分 超出规范推荐 ' + spec.rateText + ' 滴/分，建议复核');
    }
    const warnEl = $('#spec-ref-warn');
    warnEl.hidden = warns.length === 0;
    warnEl.innerHTML = warns.map((w) => '⚠️ ' + esc(w)).join('<br />');

    // 一键动作：没填滴速时套用参照时长，填了滴速时套用规范推荐滴速
    const apply = $('#spec-ref-apply');
    apply.hidden = !ref;
    if (ref) {
      if (hasRate) {
        const mid = Math.round((Number(spec.rateMin) + Number(spec.rateMax)) / 2);
        apply.textContent = '填入规范推荐滴速（' + mid + ' 滴/分）';
        apply.setAttribute('data-kind', 'rate');
        apply.setAttribute('data-value', String(mid));
      } else {
        apply.textContent = '采用规范参照时长（' + ref.minutes + ' 分钟）';
        apply.setAttribute('data-kind', 'minutes');
        apply.setAttribute('data-value', String(ref.minutes));
      }
    }
  }

  function applySpecRef() {
    const btn = $('#spec-ref-apply');
    const kind = btn.getAttribute('data-kind');
    const value = btn.getAttribute('data-value');
    if (!value) return;
    if (kind === 'minutes') {
      $('#f-duration').value = value;
      showToast('已采用规范参照时长 ' + value + ' 分钟', true);
    } else {
      $('#f-rate').value = value;
      showToast('已填入规范推荐滴速 ' + value + ' 滴/分', true);
    }
    vibrate(false);
    syncForm();
  }

  function resetForm() {
    $('#f-name').value = '';
    $('#f-ml').value = '';
    $('#f-rate').value = '';
    $('#f-factor').value = '20';
    $('#f-duration').value = '60';
    $('#f-alert').value = '5';
    submitting = false;
    syncForm();
  }

  /** 滴速有值时：自动算参考时长并替换手动时长选择 */
  function syncAutoDuration() {
    const ml = Number($('#f-ml').value);
    const rate = Number($('#f-rate').value);
    const factor = Number($('#f-factor').value);
    const minutes = calcMinutes(ml, factor, rate);

    const tip = $('#rate-tip');
    const auto = $('#auto-duration');
    const card = $('#f-duration-card');

    if (minutes) {
      tip.hidden = false;
      tip.textContent = '⏱️ 自动算出参考时长：约 ' + minutes + ' 分钟（仅供参考，可随时结束）';
      auto.hidden = false;
      auto.textContent = '⏱️ 约 ' + minutes + ' 分钟（按 ' + ml + 'ml × ' + factor + ' ÷ ' + rate + ' 自动计算）';
      card.hidden = true;
      card.classList.add('field-card--auto');
    } else {
      tip.hidden = true;
      auto.hidden = true;
      card.hidden = false;
      card.classList.remove('field-card--auto');
    }
  }

  async function onCreate() {
    if (submitting) return; // 防重复提交
    const name = $('#f-name').value.trim();
    const ml = Number($('#f-ml').value);
    const rate = Number($('#f-rate').value);
    const factor = Number($('#f-factor').value);
    const hasRate = Number.isFinite(rate) && rate > 0;

    if (!name) {
      showToast('请输入或从规范库选择药品名称');
      return;
    }
    if (!Number.isFinite(ml) || ml <= 0) {
      showToast('请输入正确的总量(ml)');
      return;
    }

    const minutes = hasRate
      ? Math.max(1, Math.round((ml * factor) / rate))
      : Number($('#f-duration').value);
    const alertMin = Number($('#f-alert').value);
    const label = nextLabel(name);

    // 规范参照：命中规范库时随任务一起保存，卡片可回看
    const spec = findSpec(name);
    const ref = spec ? specReference(spec, ml) : null;

    const ok = await showModal({
      title: '确认创建',
      content:
        '药品：' + label +
        '\n总量：' + ml + 'ml · 滴系数：' + factor + (hasRate ? ' · 滴速：' + rate + '滴/分' : '') +
        '\n参考时长：约' + minutes + '分钟（仅供参考，可随时结束）' +
        (spec
          ? '\n规范参照：' + (ref ? ref.text : spec.timeText) +
            '（规范 ' + spec.timeText + ' · ' + (spec.level || '规范') + '）'
          : ''),
      confirmText: '确认',
      cancelText: '取消',
    });
    if (!ok) return;

    submitting = true;
    try {
      addTask({
        label: label,
        manufacturer: '', // 已改为输液规范参照，不再记录厂家
        totalMl: ml,
        dripFactor: factor,
        dripRate: hasRate ? rate : undefined,
        expectedMin: minutes,
        alertMin: alertMin,
        specRef: spec
          ? {
              name: spec.name,
              cls: spec.cls,
              level: spec.level,
              specText: spec.spec,
              solvent: spec.solvent,
              rateText: spec.rateText,
              timeText: spec.timeText,
              refMin: ref ? ref.minutes : null,
              refOpen: ref ? ref.open : false,
            }
          : undefined,
      });
      showToast('已创建', true);
      window.setTimeout(() => { location.hash = '#/'; }, 400);
    } finally {
      submitting = false;
    }
  }

  function bindAdd() {
    $('#btn-back').addEventListener('click', () => { location.hash = '#/'; });
    $('#btn-create').addEventListener('click', onCreate);

    // 四个自定义滑动选择器（药品名称 / 滴系数 / 参考时长 / 提前提醒）
    $$('[data-picker]').forEach((btn) => {
      btn.addEventListener('click', () => openPicker(btn.getAttribute('data-picker'), btn));
    });

    // 手动输入药名 / 总量 / 滴速：同步选择器文本、自动时长与规范参照
    ['#f-name', '#f-ml', '#f-rate'].forEach((sel) => {
      $(sel).addEventListener('input', syncForm);
    });

    $('#spec-ref-apply').addEventListener('click', applySpecRef);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && activePicker) closePicker(false);
    });
  }

  /* ============================================================
   * 五、路由 / 时钟 / 提醒
   * ============================================================ */

  function route() {
    const isAdd = location.hash.indexOf('#/add') === 0;
    $('#view-monitor').hidden = isAdd;
    $('#view-add').hidden = !isAdd;
    if (isAdd) resetForm();
    else renderMonitor();
  }

  /** 提醒检测：提前提醒 + 到点响铃（前台、后台都要跑，否则切后台就等不到响铃） */
  function checkAlerts() {
    const t = Date.now();

    for (const task of state.tasks) {
      if (task.status !== 'running') continue;
      const rem = remainingMs(task, t);

      // ① 提前提醒：轻提示（不响铃）
      const preKey = 'pre:' + task.id;
      if (rem > 0 && rem <= task.alertMin * 60 * 1000 && !state.alerted.has(preKey)) {
        state.alerted.add(preKey);
        vibrate(false);
        const msg = task.label + ' 参考剩余约 ' + fmtHuman(rem);
        showToast('🔔 ' + msg);
        pushNotify('🔔 输注提醒', msg);
      }

      // ② 到点闹钟：循环响铃 + 震动 + 全屏「停止响铃」
      if (rem <= 0 && !state.ringed.has(task.id) && snoozeReady(task)) {
        // 二次确认：以磁盘状态为准，杜绝「任务已结束却仍在响铃」
        const fresh = loadTasks().find((x) => x.id === task.id);
        if (!fresh || fresh.status !== 'running') {
          unmarkRinged(task.id);
          continue;
        }
        markRinged(task.id);
        startAlarm(task);
      }
    }

    // 正在响铃的任务若已结束或被删除 → 立刻停响（绝不留残留铃声）
    if (alarm.current) {
      if (!isLiveAlarmTask(alarm.current.id)) stopAlarm();
      else renderAlarmPanel(); // 响铃面板时间每秒走动
    }
    syncKeepAlive(); // 跟随「有药品正在输液」状态启停保活
  }

  /** 前台秒级刷新（含提醒检测） */
  function tick() {
    updateLive();
    checkAlerts();
  }

  /**
   * 补报离开期间错过的提醒：
   * 计时基于绝对时间戳，关页面/切后台不影响准确性。
   */
  function catchUp() {
    reload();
    const t = Date.now();
    const missed = [];

    for (const task of state.tasks) {
      if (task.status !== 'running') continue;
      const rem = remainingMs(task, t);

      const preKey = 'pre:' + task.id;
      if (rem <= task.alertMin * 60 * 1000 && !state.alerted.has(preKey)) {
        state.alerted.add(preKey);
        missed.push(rem <= 0
          ? task.label + ' 已超参考时长 ' + fmtHuman(-rem)
          : task.label + ' 参考剩余约 ' + fmtHuman(rem));
      }

      // 离开期间已到点的：回到页面立即响铃
      if (rem <= 0 && !state.ringed.has(task.id) && snoozeReady(task)) {
        markRinged(task.id);
        startAlarm(task);
      }
    }

    if (missed.length > 0) {
      vibrate(true);
      pushNotify('🔔 输注提醒', missed.join('\n'));
      // 已在响铃时不再叠加弹窗，避免遮挡「停止响铃」
      if (!alarm.current) {
        showModal({
          title: '🔔 输注提醒',
          content: missed.join('\n'),
          confirmText: '知道了',
          showCancel: false,
        });
      }
    }
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    bindMonitor();
    bindAdd();
    syncNotifyButton();
    window.addEventListener('hashchange', route);
    route();

    // 回到页面时补报离开期间错过的参考提醒
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const isAdd = location.hash.indexOf('#/add') === 0;
        if (!isAdd) renderMonitor();
        catchUp();
        if (alarm.current) {
          acquireWakeLock(); // 切回前台重新申请亮屏，避免响铃中被锁屏
          renderAlarmPanel();
        }
      }
    });

    // 首次用户手势后放行播放（响铃与保活静音音轨都受自动播放策略限制）
    document.addEventListener('pointerdown', () => {
      if (keepAllowed) return;
      keepAllowed = true;
      syncKeepAlive();
    }, { passive: true });

    window.setInterval(() => {
      // 切后台/锁屏也继续检测：保活音轨维持媒体通道，到点照样响铃
      if (document.hidden) checkAlerts();
      else tick();
    }, 1000);

    if (!document.hidden) catchUp();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
