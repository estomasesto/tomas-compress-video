import { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView, Platform, TFile } from "obsidian";
import {
  Input, Output, Conversion, ConversionCanceledError, BlobSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, ALL_FORMATS, canEncodeVideo
} from "mediabunny";

/* ---------------------------------------------------------------- ajustes */

const DEFAULT_SETTINGS = {
  formatMode: "auto",      // auto | hevc-mp4 | h264-mp4 | vp9-webm
  maxResolution: 1080,     // lado corto máximo en px (0 = original)
  maxFps: 30,              // 0 = original
  quality: "medium",       // low | medium | high
  skipSmallFiles: true,
  skipThresholdMB: 2,
  addTimestamp: true,
  stripMetadata: true,
  interceptPasteDrop: true
};

const TARGETS = {
  "hevc-mp4": { container: "mp4", vcodec: "hevc", acodec: "aac", ext: "mp4", label: "H.265 (MP4)" },
  "h264-mp4": { container: "mp4", vcodec: "avc", acodec: "aac", ext: "mp4", label: "H.264 (MP4)" },
  "vp9-webm": { container: "webm", vcodec: "vp9", acodec: "opus", ext: "webm", label: "VP9 (WebM)" }
};
const AUTO_ORDER = ["hevc-mp4", "vp9-webm", "h264-mp4"];

// bits por píxel por fotograma, según códec y calidad
const BPP = {
  hevc: { low: 0.035, medium: 0.055, high: 0.085 },
  avc: { low: 0.055, medium: 0.085, high: 0.13 },
  vp9: { low: 0.037, medium: 0.058, high: 0.09 }
};

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|wmv|flv|3gp|mts|m2ts)$/i;

function isVideoFile(file) {
  return (file.type && file.type.startsWith("video/")) || VIDEO_EXT.test(file.name);
}

/* ------------------------------------------------------------ utilidades */

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const errMsg = (e) => String((e && e.message) || e);

function splitName(name) {
  const i = name.lastIndexOf(".");
  if (i > 0 && i < name.length - 1) return { base: name.slice(0, i), ext: name.slice(i + 1).toLowerCase() };
  return { base: name || "video", ext: "mp4" };
}

async function availablePath(plugin, name, ext, source) {
  const vault = plugin.app.vault;
  try {
    return await vault.getAvailablePathForAttachments(name, ext, source);
  } catch (e) {
    const fm = plugin.app.fileManager;
    if (typeof fm.getAvailablePathForAttachment === "function") {
      return await fm.getAvailablePathForAttachment.call(fm, `${name}.${ext}`, source.path);
    }
    const folder = source.parent || vault.getRoot();
    let candidate = folder.isRoot() ? `${name}.${ext}` : `${folder.path}/${name}.${ext}`;
    let n = 1;
    while (vault.getAbstractFileByPath(candidate)) {
      candidate = folder.isRoot() ? `${name} ${n}.${ext}` : `${folder.path}/${name} ${n}.${ext}`;
      n++;
    }
    return candidate;
  }
}

/* ------------------------------------------------------------ compresión */

function evenRound(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function planOutput(track, srcFps, settings) {
  const dw = track.displayWidth;
  const dh = track.displayHeight;
  let w = dw, h = dh;
  const lim = settings.maxResolution;
  if (lim > 0 && Math.min(dw, dh) > lim) {
    const s = lim / Math.min(dw, dh);
    w = dw * s;
    h = dh * s;
  }
  w = evenRound(w);
  h = evenRound(h);
  const resize = w !== dw || h !== dh;
  const fpsBase = srcFps > 0 ? srcFps : 30;
  const limitFps = settings.maxFps > 0 && fpsBase > settings.maxFps + 1;
  const fps = limitFps ? settings.maxFps : fpsBase;
  return { w, h, resize, fps, frameRate: limitFps ? settings.maxFps : undefined };
}

async function chooseTarget(settings, plan) {
  const order = settings.formatMode === "auto"
    ? AUTO_ORDER
    : [settings.formatMode, ...AUTO_ORDER.filter((k) => k !== settings.formatMode)];
  for (const key of order) {
    const t = TARGETS[key];
    const bpp = BPP[t.vcodec][settings.quality] || BPP[t.vcodec].medium;
    const bitrate = Math.max(300000, Math.round(plan.w * plan.h * plan.fps * bpp));
    let ok = false;
    try {
      ok = await canEncodeVideo(t.vcodec, { width: plan.w, height: plan.h, bitrate, frameRate: plan.fps });
    } catch (e) {
      ok = false;
    }
    if (ok) return { key, target: t, bitrate, fellBack: settings.formatMode !== "auto" && key !== settings.formatMode };
  }
  return null;
}

async function compressVideo(file, settings, onProgress, holder) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The file has no video track.");

    let srcFps = 0;
    try {
      const stats = await track.computePacketStats(200);
      srcFps = stats.averagePacketRate || 0;
    } catch (e) { /* sin dato de fps */ }

    const plan = planOutput(track, srcFps, settings);
    const choice = await chooseTarget(settings, plan);
    if (!choice) throw new Error("This device cannot encode any of the output formats.");
    const { target, bitrate } = choice;

    const output = new Output({
      format: target.container === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget()
    });

    const video = { codec: target.vcodec, bitrate, forceTranscode: true };
    if (plan.resize) { video.width = plan.w; video.height = plan.h; video.fit = "fill"; }
    if (plan.frameRate) video.frameRate = plan.frameRate;

    const audio = { codec: target.acodec };
    if (target.acodec === "opus") audio.bitrate = 96000;

    const options = { input, output, video, audio, showWarnings: false };
    if (settings.stripMetadata) {
      options.tags = (t) => (t && t.date ? { date: t.date } : {});
    }

    const conversion = await Conversion.init(options);
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => d.reason).join(", ");
      throw new Error(`This video could not be converted (${reasons || "invalid track"}).`);
    }
    const audioDropped = conversion.discardedTracks.some(
      (d) => d.track.isAudioTrack() && d.reason !== "discarded_by_user"
    );

    holder.conversion = conversion;
    conversion.onProgress = (p) => onProgress(p);
    await conversion.execute();
    holder.conversion = null;

    const buffer = output.target.buffer;
    if (!buffer) throw new Error("The conversion produced no data.");
    return { buffer, ext: target.ext, label: target.label, audioDropped, fellBack: choice.fellBack, wanted: settings.formatMode };
  } finally {
    try { input.dispose(); } catch (e) { /* ya liberado */ }
  }
}

/* ------------------------------------------------------------------- UI */

class ProgressModal extends Modal {
  constructor(app, onCancel) {
    super(app);
    this.onCancelCb = onCancel;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Compressing video" });
    this.statusEl = contentEl.createDiv({ text: "Starting..." });
    contentEl.createEl("p", { text: "Keep the app open and the screen on until it finishes." }).style.opacity = "0.7";
    const meter = contentEl.createDiv();
    meter.style.cssText = "height:8px;border-radius:4px;background:var(--background-modifier-border);overflow:hidden;margin:12px 0;";
    this.fillEl = meter.createDiv();
    this.fillEl.style.cssText = "height:100%;width:0%;background:var(--interactive-accent);transition:width .2s;";
    new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => {
      this.cancelOnce();
      this.close();
    }));
  }
  cancelOnce() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancelCb();
  }
  set(text, pct) {
    if (this.statusEl) this.statusEl.setText(text);
    if (this.fillEl && typeof pct === "number") this.fillEl.style.width = `${Math.round(pct * 100)}%`;
  }
  onClose() {
    this.contentEl.empty();
    if (!this.done) this.cancelOnce();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    new Setting(containerEl).setName("Video compression").setHeading();

    new Setting(containerEl)
      .setName("Output format")
      .setDesc("Automatic picks the most efficient format this device can encode: H.265 (MP4) where available (iPhone), otherwise VP9 (WebM), otherwise H.264 (MP4).")
      .addDropdown((d) => d.addOptions({
        "auto": "Automatic",
        "hevc-mp4": "H.265 (MP4)",
        "vp9-webm": "VP9 (WebM)",
        "h264-mp4": "H.264 (MP4, most compatible)"
      }).setValue(s.formatMode).onChange(async (v) => { s.formatMode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Max resolution")
      .setDesc("Limit for the shorter side of the video. Smaller videos are never upscaled.")
      .addDropdown((d) => d.addOptions({
        "0": "Original", "480": "480p", "720": "720p", "1080": "1080p", "1440": "1440p"
      }).setValue(String(s.maxResolution)).onChange(async (v) => { s.maxResolution = parseInt(v, 10); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Max frame rate")
      .setDesc("Videos with a higher frame rate are reduced to this value.")
      .addDropdown((d) => d.addOptions({
        "0": "Original", "24": "24 fps", "30": "30 fps", "60": "60 fps"
      }).setValue(String(s.maxFps)).onChange(async (v) => { s.maxFps = parseInt(v, 10); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Quality")
      .setDesc("Higher quality means larger files. Medium is a good balance for notes.")
      .addDropdown((d) => d.addOptions({
        "low": "Low (smallest)", "medium": "Medium", "high": "High"
      }).setValue(s.quality).onChange(async (v) => { s.quality = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Skip small files")
      .setDesc("Videos below the threshold are saved as they are.")
      .addToggle((t) => t.setValue(s.skipSmallFiles).onChange(async (v) => {
        s.skipSmallFiles = v;
        await this.plugin.saveSettings();
        this.display();
      }));
    if (s.skipSmallFiles) {
      new Setting(containerEl)
        .setName("Skip threshold (MB)")
        .addText((t) => t.setPlaceholder("2").setValue(String(s.skipThresholdMB)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n)) { s.skipThresholdMB = Math.max(0, n); await this.plugin.saveSettings(); }
        }));
    }

    new Setting(containerEl)
      .setName("Add timestamp")
      .setDesc("Add a human-readable timestamp to the filename.")
      .addToggle((t) => t.setValue(s.addTimestamp).onChange(async (v) => { s.addTimestamp = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Remove metadata")
      .setDesc("Drops location, device and other tags from the compressed video (the recording date is kept).")
      .addToggle((t) => t.setValue(s.stripMetadata).onChange(async (v) => { s.stripMetadata = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Handle pasted and dropped videos")
      .setDesc("Compress videos that you paste or drop into a note. Takes effect after reloading the plugin.")
      .addToggle((t) => t.setValue(s.interceptPasteDrop).onChange(async (v) => { s.interceptPasteDrop = v; await this.plugin.saveSettings(); }));
  }
}

/* --------------------------------------------------------------- plugin */

export default class CompressVideoPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.busy = false;

    this.addCommand({
      id: "compress-and-add-videos",
      name: "Compress and add video(s)",
      icon: "film",
      editorCallback: (editor, view) => {
        if (view instanceof MarkdownView) this.pickVideos(editor, view);
      }
    });
    this.addRibbonIcon("film", "Add video(s) and compress", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) this.pickVideos(view.editor, view);
      else new Notice("Open a note to insert videos.");
    });

    if (this.settings.interceptPasteDrop) {
      this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, view) => {
        if (evt.defaultPrevented || !evt.clipboardData) return;
        const files = [];
        for (const item of Array.from(evt.clipboardData.items || [])) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f && isVideoFile(f)) files.push(f);
          }
        }
        if (files.length) {
          evt.preventDefault();
          void this.processAndInsert(files, editor, view);
        }
      }));
      this.registerEvent(this.app.workspace.on("editor-drop", (evt, editor, view) => {
        if (evt.defaultPrevented || !evt.dataTransfer) return;
        const files = Array.from(evt.dataTransfer.files || []).filter(isVideoFile);
        if (files.length) {
          evt.preventDefault();
          void this.processAndInsert(files, editor, view);
        }
      }));
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  pickVideos(editor, view) {
    const input = activeDocument.body.createEl("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "video/*";
    input.onchange = async () => {
      const files = Array.from(input.files || []).filter(isVideoFile);
      input.remove();
      if (files.length) await this.processAndInsert(files, editor, view);
      else new Notice("No compatible videos selected.");
    };
    input.click();
  }

  async saveOriginal(file, activeFile) {
    const { base, ext } = splitName(file.name);
    const name = this.settings.addTimestamp ? `${base}_${timestamp()}` : base;
    const path = await availablePath(this, name, ext, activeFile);
    return await this.app.vault.createBinary(path, await file.arrayBuffer());
  }

  async processAndInsert(files, editor, view) {
    const activeFile = view.file;
    if (!activeFile) return;
    if (this.busy) {
      new Notice("Another video is still being processed.");
      return;
    }
    this.busy = true;
    const settings = this.settings;
    const holder = { conversion: null, cancelled: false };
    const modal = new ProgressModal(this.app, () => {
      holder.cancelled = true;
      if (holder.conversion) void holder.conversion.cancel();
    });
    modal.open();

    let wake = null;
    try {
      if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen");
    } catch (e) { /* no disponible */ }

    const links = [];
    let before = 0, after = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (holder.cancelled) break;
        const file = files[i];
        const { base } = splitName(file.name);
        const prefix = `Video ${i + 1} of ${files.length}: ${file.name}`;
        modal.set(`${prefix} — preparing...`, 0);

        let saved = null;
        const small = settings.skipSmallFiles && file.size < settings.skipThresholdMB * 1024 * 1024;
        if (small) {
          saved = await this.saveOriginal(file, activeFile);
        } else {
          try {
            const out = await compressVideo(file, settings, (p) => modal.set(`${prefix} — ${Math.round(p * 100)} %`, p), holder);
            if (out.buffer.byteLength >= file.size * 0.95) {
              saved = await this.saveOriginal(file, activeFile);
              new Notice(`${file.name}: the original was already smaller, kept as is.`);
            } else {
              const name = settings.addTimestamp ? `${base}_${timestamp()}` : base;
              const path = await availablePath(this, name, out.ext, activeFile);
              saved = await this.app.vault.createBinary(path, out.buffer);
              before += file.size;
              after += out.buffer.byteLength;
              let note = `${file.name}: ${formatBytes(file.size)} → ${formatBytes(out.buffer.byteLength)} (${out.label})`;
              if (out.fellBack) note += " — the chosen format is not available on this device";
              if (out.audioDropped) note += " — audio could not be kept";
              new Notice(note, 8000);
            }
          } catch (e) {
            holder.conversion = null;
            if (e instanceof ConversionCanceledError || holder.cancelled) break;
            console.error("Video compression failed", e);
            new Notice(`Could not compress ${file.name} (${errMsg(e)}). Saved the original.`, 10000);
            saved = await this.saveOriginal(file, activeFile);
          }
        }
        if (saved) {
          const link = this.app.fileManager.generateMarkdownLink(saved, activeFile.path);
          links.push(link.startsWith("!") ? link : `!${link}`);
        }
      }
    } catch (e) {
      console.error(e);
      new Notice(`Error: ${errMsg(e)}`);
    } finally {
      this.busy = false;
      modal.done = true;
      modal.close();
      if (wake) { try { await wake.release(); } catch (e) { /* ya liberado */ } }
    }

    if (links.length) editor.replaceSelection(links.join("\n\n") + "\n");
    if (holder.cancelled) new Notice("Cancelled.");
    else if (links.length > 1 && before > 0) new Notice(`Total: ${formatBytes(before)} → ${formatBytes(after)}`, 8000);
  }
}
