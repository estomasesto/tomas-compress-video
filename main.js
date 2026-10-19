"use strict";
const { Plugin, Modal, Notice, Setting, MarkdownView, Platform } = require("obsidian");

const CODECS = [
  { label: "H.265 / HEVC", codec: "hvc1.1.6.L120.B0", mp4: 'video/mp4; codecs="hvc1.1.6.L120.B0"' },
  { label: "H.264 / AVC", codec: "avc1.640028", mp4: 'video/mp4; codecs="avc1.640028"' },
  { label: "VP9", codec: "vp09.00.40.08", webm: 'video/webm; codecs="vp09.00.40.08"' },
  { label: "AV1", codec: "av01.0.08M.08", webm: 'video/webm; codecs="av01.0.08M.08"', mp4: 'video/mp4; codecs="av01.0.08M.08"' },
  { label: "VP8", codec: "vp8", webm: 'video/webm; codecs="vp8"' }
];

const yn = (v) => (v === true ? "sí" : v === false ? "no" : "?");
const msg = (e) => String((e && e.message) || e);

async function encSupported(codec, pref) {
  try {
    const r = await VideoEncoder.isConfigSupported({
      codec, width: 1920, height: 1080, bitrate: 3000000, framerate: 30, hardwareAcceleration: pref
    });
    return !!(r && r.supported);
  } catch (e) {
    return false;
  }
}

async function decSupported(codec) {
  try {
    const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 });
    return !!(r && r.supported);
  } catch (e) {
    return false;
  }
}

async function realEncodeTest(codec) {
  const w = 1280, h = 720, n = 60;
  let chunks = 0, bytes = 0, err = null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const enc = new VideoEncoder({
    output: (c) => { chunks++; bytes += c.byteLength; },
    error: (e) => { err = msg(e); }
  });
  const t0 = performance.now();
  const work = (async () => {
    enc.configure({ codec, width: w, height: h, bitrate: 2000000, framerate: 30 });
    for (let i = 0; i < n; i++) {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${(i * 6) % 360},80%,50%)`);
      g.addColorStop(1, `hsl(${(i * 6 + 120) % 360},80%,40%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.fillRect((i * 20) % w, h / 3, 120, 120);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) });
      enc.encode(frame, { keyFrame: i % 30 === 0 });
      frame.close();
      if (enc.encodeQueueSize > 10) await new Promise((r) => setTimeout(r, 5));
    }
    await enc.flush();
  })();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("tiempo agotado (20 s)")), 20000); });
  try {
    await Promise.race([work, timeout]);
  } catch (e) {
    err = err || msg(e);
  }
  clearTimeout(timer);
  try { enc.close(); } catch (e) { /* ya cerrado */ }
  return { chunks, bytes, ms: performance.now() - t0, err, frames: n };
}

async function collectProbe(log, platformInfo) {
  log("== Entorno ==");
  log(`Plataforma: ${platformInfo}`);
  log(`UserAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`);
  const has = (name) => typeof globalThis[name] !== "undefined";
  log(`APIs: VideoEncoder=${yn(has("VideoEncoder"))} VideoDecoder=${yn(has("VideoDecoder"))} AudioEncoder=${yn(has("AudioEncoder"))} MediaRecorder=${yn(has("MediaRecorder"))} OffscreenCanvas=${yn(has("OffscreenCanvas"))} crossOriginIsolated=${yn(globalThis.crossOriginIsolated)}`);
  log("");

  const canEnc = has("VideoEncoder");
  const canDec = has("VideoDecoder");
  const okEnc = [];

  log("== Codificación y decodificación WebCodecs (1080p, 30 fps) ==");
  for (const c of CODECS) {
    const encAny = canEnc ? await encSupported(c.codec, "no-preference") : false;
    const encHw = canEnc ? await encSupported(c.codec, "prefer-hardware") : false;
    const encSw = canEnc ? await encSupported(c.codec, "prefer-software") : false;
    const dec = canDec ? await decSupported(c.codec) : false;
    if (encAny) okEnc.push(c);
    log(`${encAny ? "✅" : "❌"} ${c.label} (${c.codec}): codificar=${yn(encAny)} [hardware=${yn(encHw)}, software=${yn(encSw)}] decodificar=${yn(dec)}`);
  }
  log("");

  log("== Audio (WebCodecs) ==");
  for (const a of [{ n: "AAC (mp4a.40.2)", codec: "mp4a.40.2" }, { n: "Opus", codec: "opus" }]) {
    let ok = false;
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: a.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      ok = !!(r && r.supported);
    } catch (e) { ok = false; }
    log(`${ok ? "✅" : "❌"} ${a.n}: codificar=${yn(ok)}`);
  }
  log("");

  log("== Reproducción en <video> (canPlayType) ==");
  const v = document.createElement("video");
  for (const c of CODECS) {
    for (const key of ["mp4", "webm"]) {
      if (!c[key]) continue;
      let r = "";
      try { r = v.canPlayType(c[key]); } catch (e) { r = "error"; }
      log(`${r ? "✅" : "❌"} ${c.label} en ${key}: ${r || "no"}`);
    }
  }
  log("");

  log("== MediaRecorder (alternativa) ==");
  const mrTypes = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"', 'video/mp4; codecs="avc1.640028"', "video/mp4",
    'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"', 'video/webm; codecs="av1"'
  ];
  for (const t of mrTypes) {
    let r = false;
    try { r = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t); } catch (e) { r = false; }
    log(`${r ? "✅" : "❌"} ${t}`);
  }
  log("");

  log("== Prueba real de codificación (60 fotogramas a 1280x720) ==");
  if (okEnc.length === 0) {
    log("Ningún códec de video pasó la comprobación de soporte; no se hace prueba real.");
  }
  for (const c of okEnc) {
    log(`Probando ${c.label}...`);
    try {
      const r = await realEncodeTest(c.codec);
      if (r.err || r.chunks < r.frames) {
        log(`❌ ${c.label}: ${r.chunks}/${r.frames} fotogramas, error: ${r.err || "salida incompleta"}`);
      } else {
        const fps = (r.frames / (r.ms / 1000)).toFixed(0);
        log(`✅ ${c.label}: ${r.frames} fotogramas en ${(r.ms / 1000).toFixed(2)} s (~${fps} fps), ${(r.bytes / 1024).toFixed(0)} KB`);
      }
    } catch (e) {
      log(`❌ ${c.label}: falló la prueba (${msg(e)})`);
    }
  }
  log("");
  log("Fin de la prueba.");
}

class ProbeModal extends Modal {
  constructor(app, platformInfo) {
    super(app);
    this.platformInfo = platformInfo;
    this.lines = [];
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Prueba de códecs de video" });
    this.pre = contentEl.createEl("pre");
    this.pre.style.whiteSpace = "pre-wrap";
    this.pre.style.userSelect = "text";
    this.pre.style.maxHeight = "55vh";
    this.pre.style.overflowY = "auto";
    this.pre.style.fontSize = "0.75em";
    this.pre.setText("Ejecutando...");
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Copiar").onClick(() => this.copy()))
      .addButton((b) => b.setButtonText("Insertar en la nota").onClick(() => this.insert()))
      .addButton((b) => b.setButtonText("Cerrar").onClick(() => this.close()));
    const log = (line) => {
      this.lines.push(line);
      this.pre.setText(this.lines.join("\n"));
      this.pre.scrollTop = this.pre.scrollHeight;
    };
    collectProbe(log, this.platformInfo).catch((e) => log("Error inesperado: " + msg(e)));
  }
  text() {
    return this.lines.join("\n");
  }
  async copy() {
    try {
      await navigator.clipboard.writeText(this.text());
      new Notice("Resultados copiados.");
    } catch (e) {
      new Notice("No se pudo copiar; usa 'Insertar en la nota'.");
    }
  }
  insert() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Abre una nota para insertar los resultados.");
      return;
    }
    view.editor.replaceSelection("```\n" + this.text() + "\n```\n");
    this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class VideoProbePlugin extends Plugin {
  onload() {
    const platformInfo = () => {
      const flags = [];
      for (const k of ["isIosApp", "isAndroidApp", "isDesktopApp", "isMobile", "isMacOS", "isWin"]) {
        if (Platform && Platform[k]) flags.push(k);
      }
      return flags.join(", ") || "desconocida";
    };
    const run = () => new ProbeModal(this.app, platformInfo()).open();
    this.addCommand({ id: "probe-video-codecs", name: "Probar códecs de video", callback: run });
    this.addRibbonIcon("film", "Probar códecs de video", run);
  }
};
