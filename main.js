const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"]);

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function resolveFfmpegPath() {
  if (app.isPackaged) {
    const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "ffmpeg-static",
      exeName
    );
    if (fsSync.existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }

  return ffmpegStatic;
}

function resolveBundledAdbPath() {
  if (process.platform !== "win32") return null;
  if (!app.isPackaged) return null;
  const bundled = path.join(process.resourcesPath, "adb", "adb.exe");
  return fsSync.existsSync(bundled) ? bundled : null;
}

function buildAdbCommandCandidates() {
  const candidates = [];

  if (process.platform === "win32") {
    const packagedAdb = resolveBundledAdbPath();
    if (packagedAdb) candidates.push(packagedAdb);

    // 开发态优先尝试项目内 resources/adb/win/adb.exe（由 prepare:adb:win 下载）
    const devBundled = path.join(__dirname, "resources", "adb", "win", "adb.exe");
    if (fsSync.existsSync(devBundled)) candidates.push(devBundled);

    // 兼容从项目根启动的场景
    const cwdBundled = path.join(process.cwd(), "resources", "adb", "win", "adb.exe");
    if (fsSync.existsSync(cwdBundled)) candidates.push(cwdBundled);

    const sdkRoots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME].filter(Boolean);
    for (const sdkRoot of sdkRoots) {
      const sdkAdb = path.join(sdkRoot, "platform-tools", "adb.exe");
      if (fsSync.existsSync(sdkAdb)) candidates.push(sdkAdb);
    }
  }

  candidates.push("adb");
  return [...new Set(candidates)];
}

function resolveAdbCommand() {
  return buildAdbCommandCandidates()[0];
}

async function pickDirectory() {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

async function getSubfolders(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

async function getClipsInFolder(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(folderPath, name));
}

function parsePrefixOrder(orderText, maxCount) {
  if (!orderText || !orderText.trim()) return [];
  const numbers = orderText
    .split(/[-,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));

  if (numbers.length > maxCount) {
    throw new Error(`顺序数量不能超过子文件夹数量（${maxCount}）`);
  }
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > maxCount)) {
    throw new Error(`顺序仅支持 1~${maxCount} 的整数`);
  }
  const unique = new Set(numbers);
  if (unique.size !== numbers.length) {
    throw new Error("顺序中不能包含重复编号");
  }
  return numbers.map((n) => n - 1);
}

function shuffle(arr) {
  const copied = [...arr];
  for (let i = copied.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickClipWithPenalty(list, failScores) {
  if (!list.length) return null;
  let minScore = Number.POSITIVE_INFINITY;
  const bucket = [];
  for (const clip of list) {
    const score = failScores.get(clip) || 0;
    if (score < minScore) {
      minScore = score;
      bucket.length = 0;
      bucket.push(clip);
    } else if (score === minScore) {
      bucket.push(clip);
    }
  }
  return pickRandom(bucket);
}

function buildOrder(prefixOrder, folderCount) {
  const all = Array.from({ length: folderCount }, (_, idx) => idx);
  const remaining = all.filter((idx) => !prefixOrder.includes(idx));
  return [...prefixOrder, ...shuffle(remaining)];
}

function buildUniqueKey(order, clips) {
  return `${order.join(",")}::${clips.join("|")}`;
}

function toConcatFileLine(clipPath) {
  const escaped = clipPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
  return `file '${escaped}'`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        const commandName = path.basename(command).toLowerCase();
        const isAdbMissing = commandName === "adb" || commandName === "adb.exe";
        if (isAdbMissing) {
          reject(
            new Error(
              "未找到 adb 可执行文件。开发调试请先执行 `npm run prepare:adb:win` 下载到项目 resources，或自行安装 Android Platform Tools 并确保 `adb` 在 PATH 中。"
            )
          );
          return;
        }
        reject(
          new Error(
            `未找到可执行文件：${command}。如果你选择了手机(ADB)保存，请安装/配置 adb，或在安装包内置 adb 后重新打包。`
          )
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} 执行失败（退出码 ${code}）: ${stderr || stdout}`));
    });
  });
}

function parseAdbDevicesOutput(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const status = parts[1] || "unknown";
      const model = (parts.find((p) => p.startsWith("model:")) || "").replace("model:", "");
      const deviceName = (parts.find((p) => p.startsWith("device:")) || "").replace("device:", "");
      return { serial, status, model, deviceName };
    })
    .filter((item) => item.status === "device");
}

async function listAdbDevices() {
  const adbCommand = resolveAdbCommand();
  const result = await runCommand(adbCommand, ["devices", "-l"]);
  return parseAdbDevicesOutput(result.stdout);
}

async function triggerAdbMediaScan(serial, remoteFilePath, remoteDirPath) {
  const adbCommand = resolveAdbCommand();
  const fileUri = `file://${remoteFilePath}`;
  const dirUri = `file://${remoteDirPath}`;

  // 兼容不同 Android 版本：先按文件扫描，再尝试按目录扫描。
  await runCommand(adbCommand, [
    "-s",
    serial,
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d",
    fileUri
  ]).catch(() => {});

  await runCommand(adbCommand, [
    "-s",
    serial,
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d",
    dirUri
  ]).catch(() => {});

  // 新系统上的额外兜底扫描命令（部分机型不支持，失败可忽略）。
  await runCommand(adbCommand, [
    "-s",
    serial,
    "shell",
    "cmd",
    "media",
    "scan",
    "--file",
    remoteFilePath
  ]).catch(() => {});
}

async function pushToAdbDevice(serial, adbDirPath, localFilePath) {
  const adbCommand = resolveAdbCommand();
  const normalizedDir = adbDirPath.replace(/\\/g, "/").trim();
  await runCommand(adbCommand, ["-s", serial, "shell", "mkdir", "-p", normalizedDir]);
  await runCommand(adbCommand, ["-s", serial, "push", localFilePath, normalizedDir]);
  const remoteFilePath = path.posix.join(normalizedDir, path.basename(localFilePath));
  await triggerAdbMediaScan(serial, remoteFilePath, normalizedDir);
  return remoteFilePath;
}

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const ENCODE_CACHE_NAMESPACE = "v1";
const ENCODE_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8GB
const ENCODE_CACHE_TRIM_TARGET_BYTES = 6 * 1024 * 1024 * 1024; // 6GB
const ENCODE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let cachedHwEncoder;
let hwEncoderDetectionPromise = null;

const PROBE_TIMEOUT_MS = 5000;

async function detectHwEncoder(ffmpegPath) {
  if (cachedHwEncoder !== undefined) return cachedHwEncoder;
  if (hwEncoderDetectionPromise) return hwEncoderDetectionPromise;

  const probe = (encoder) =>
    new Promise((resolve) => {
      let finished = false;
      const child = spawn(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=128x128:d=0.1",
          "-c:v",
          encoder,
          "-f",
          "null",
          "-"
        ],
        { windowsHide: true }
      );
      // 防止某些驱动下 stderr 被填满导致子进程阻塞
      if (child.stdout) child.stdout.on("data", () => {});
      if (child.stderr) child.stderr.on("data", () => {});
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          child.kill("SIGKILL");
        } catch (_) {
          /* ignore */
        }
        resolve(false);
      }, PROBE_TIMEOUT_MS);
      child.on("error", () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
    });

  hwEncoderDetectionPromise = (async () => {
    const candidates = ["h264_nvenc", "h264_qsv", "h264_amf"];
    for (const enc of candidates) {
      try {
        if (await probe(enc)) {
          cachedHwEncoder = enc;
          return enc;
        }
      } catch (_) {
        /* 继续尝试下一个 */
      }
    }
    cachedHwEncoder = null;
    return null;
  })();

  return hwEncoderDetectionPromise;
}

function buildNormalizeFilter(videoBrightness) {
  const parts = [
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${OUTPUT_FPS}`
  ];
  if (videoBrightness !== 0) parts.push(`eq=brightness=${videoBrightness}`);
  return parts.join(",");
}

function pushVideoEncoderArgs(args, hwEncoder) {
  switch (hwEncoder) {
    case "h264_nvenc":
      args.push(
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p4",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "23",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p"
      );
      break;
    case "h264_qsv":
      args.push(
        "-c:v",
        "h264_qsv",
        "-preset",
        "veryfast",
        "-global_quality",
        "23",
        "-pix_fmt",
        "nv12"
      );
      break;
    case "h264_amf":
      args.push(
        "-c:v",
        "h264_amf",
        "-quality",
        "speed",
        "-rc",
        "cqp",
        "-qp_i",
        "23",
        "-qp_p",
        "23",
        "-pix_fmt",
        "yuv420p"
      );
      break;
    default:
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "0"
      );
  }
}

function getEncodeCacheRoot() {
  // userData 在开发态/打包态都可写，适合作为持久缓存目录。
  return path.join(app.getPath("userData"), "encoded-clip-cache");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function buildCachedClipKey(clipPath, stat, audioVolume, videoBrightness) {
  const payload = [
    ENCODE_CACHE_NAMESPACE,
    clipPath,
    String(stat.size),
    String(Math.floor(stat.mtimeMs)),
    `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}@${OUTPUT_FPS}`,
    `volume=${audioVolume}`,
    `brightness=${videoBrightness}`
  ].join("|");
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function getCachedClipPath(cacheRoot, cacheKey) {
  return path.join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.mp4`);
}

function buildCacheAudioFilter(audioVolume) {
  let audioFilter =
    "aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100";
  if (audioVolume !== 1) audioFilter += `,volume=${audioVolume}`;
  return audioFilter;
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

async function transcodeClipToCache(ffmpegPath, sourceClip, outputClip, audioVolume, videoBrightness) {
  await fs.mkdir(path.dirname(outputClip), { recursive: true });
  const tempClip = path.join(
    path.dirname(outputClip),
    `${path.basename(outputClip, ".mp4")}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`
  );
  const args = ["-y", "-i", sourceClip, "-map", "0:v:0", "-vf", buildNormalizeFilter(videoBrightness)];

  if (audioVolume > 0) {
    args.push("-map", "0:a:0?", "-af", buildCacheAudioFilter(audioVolume), "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }
  args.push(
    "-r",
    String(OUTPUT_FPS),
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "0",
    "-movflags",
    "+faststart",
    tempClip
  );

  try {
    await spawnFfmpeg(ffmpegPath, args);
    try {
      await fs.rename(tempClip, outputClip);
    } catch (renameError) {
      if (await fileExists(outputClip)) {
        await fs.unlink(tempClip).catch(() => {});
      } else {
        throw renameError;
      }
    }
  } catch (error) {
    await fs.unlink(tempClip).catch(() => {});
    throw error;
  }
}

const cachedClipInflightMap = new Map();

async function getOrCreateCachedClip(
  ffmpegPath,
  sourceClip,
  cacheRoot,
  audioVolume,
  videoBrightness,
  reportProgress
) {
  const stat = await fs.stat(sourceClip);
  const cacheKey = buildCachedClipKey(sourceClip, stat, audioVolume, videoBrightness);
  const cachedClip = getCachedClipPath(cacheRoot, cacheKey);
  if (await fileExists(cachedClip)) {
    const now = new Date();
    await fs.utimes(cachedClip, now, now).catch(() => {});
    return cachedClip;
  }
  if (cachedClipInflightMap.has(cachedClip)) {
    return cachedClipInflightMap.get(cachedClip);
  }

  const inflight = (async () => {
    reportProgress(`缓存转码：${path.basename(sourceClip)}`);
    await transcodeClipToCache(ffmpegPath, sourceClip, cachedClip, audioVolume, videoBrightness);
    return cachedClip;
  })();

  cachedClipInflightMap.set(cachedClip, inflight);
  try {
    return await inflight;
  } finally {
    cachedClipInflightMap.delete(cachedClip);
  }
}

async function listCacheFiles(cacheRoot) {
  const files = [];
  const walk = async (dirPath) => {
    let entries = [];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4")) continue;
      try {
        const st = await fs.stat(full);
        files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch (_) {
        /* ignore */
      }
    }
  };
  await walk(cacheRoot);
  return files;
}

async function cleanupEncodeCache(cacheRoot, reportProgress) {
  await fs.mkdir(cacheRoot, { recursive: true });
  const files = await listCacheFiles(cacheRoot);
  if (!files.length) return;
  const now = Date.now();

  // 先清理过期项
  const expired = files.filter((f) => now - f.mtimeMs > ENCODE_CACHE_TTL_MS);
  for (const item of expired) {
    await fs.unlink(item.path).catch(() => {});
  }

  const alive = files.filter((f) => now - f.mtimeMs <= ENCODE_CACHE_TTL_MS);
  let totalBytes = alive.reduce((s, f) => s + f.size, 0);
  if (totalBytes <= ENCODE_CACHE_MAX_BYTES) return;

  // 超额后按最久未使用优先删除，直到回落到目标水位
  const sortedByOldest = [...alive].sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of sortedByOldest) {
    if (totalBytes <= ENCODE_CACHE_TRIM_TARGET_BYTES) break;
    await fs.unlink(item.path).catch(() => {});
    totalBytes -= item.size;
  }

  if (reportProgress) {
    reportProgress(`缓存清理完成，剩余 ${(totalBytes / 1024 / 1024).toFixed(0)} MB`);
  }
}

// ---------- 片段元数据探测 ----------
// 缓存每个片段的编码/分辨率/声道等，用于「同格式优先」与「流拷贝极速路径」判断
const clipMetaCache = new Map();

function parseFfmpegMeta(stderrText) {
  const meta = { video: null, audio: null };
  // 例：Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 1080x1920, 6908 kb/s, 26.66 fps
  const vm = stderrText.match(
    /Stream\s+#\d+:\d+[^\n]*?Video:\s+(\w+)[^,]*,\s*([^\s,()]+)(?:\([^)]+\))?[^,]*,\s*(\d+)x(\d+)[^,]*?,\s*(?:[\d.]+\s*kb\/s,\s*)?([\d.]+)\s*fps/i
  );
  if (vm) {
    meta.video = {
      codec: vm[1].toLowerCase(),
      pixFmt: vm[2].toLowerCase(),
      width: Number(vm[3]),
      height: Number(vm[4]),
      fps: Math.round(Number(vm[5]) * 100) / 100
    };
  }
  // 例：Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 65 kb/s
  const am = stderrText.match(
    /Stream\s+#\d+:\d+[^\n]*?Audio:\s+(\w+)[^,]*,\s*(\d+)\s*Hz,\s*(mono|stereo|[\d.]+\s*channels?)/i
  );
  if (am) {
    meta.audio = {
      codec: am[1].toLowerCase(),
      sampleRate: Number(am[2]),
      channelLayout: am[3].toLowerCase().trim().replace(/\s+/g, "")
    };
  }
  return meta;
}

function probeClipMeta(ffmpegPath, clip) {
  if (clipMetaCache.has(clip)) return Promise.resolve(clipMetaCache.get(clip));
  return new Promise((resolve) => {
    let finished = false;
    const child = spawn(
      ffmpegPath,
      ["-hide_banner", "-i", clip, "-f", "null", "-"],
      { windowsHide: true }
    );
    let stderr = "";
    if (child.stdout) child.stdout.on("data", () => {});
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {
        /* ignore */
      }
      const meta = parseFfmpegMeta(stderr);
      clipMetaCache.set(clip, meta);
      resolve(meta);
    }, 8000);
    child.on("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clipMetaCache.set(clip, { video: null, audio: null });
      resolve({ video: null, audio: null });
    });
    child.on("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const meta = parseFfmpegMeta(stderr);
      clipMetaCache.set(clip, meta);
      resolve(meta);
    });
  });
}

function formatKey(meta) {
  if (!meta || !meta.video) return "unknown";
  const v = meta.video;
  const a = meta.audio;
  return [
    v.codec,
    v.pixFmt,
    `${v.width}x${v.height}`,
    `${v.fps}fps`,
    a ? `${a.codec}/${a.sampleRate}/${a.channelLayout}` : "noaudio"
  ].join("|");
}

async function probeAllClips(ffmpegPath, clips, reportProgress) {
  const uniq = [...new Set(clips)];
  const notCached = uniq.filter((c) => !clipMetaCache.has(c));
  if (notCached.length === 0) return;
  if (reportProgress) reportProgress(`正在探测 ${notCached.length} 个片段的编码参数...`);
  const CONC = 4;
  let idx = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (idx < notCached.length) {
      const my = idx;
      idx += 1;
      await probeClipMeta(ffmpegPath, notCached[my]);
    }
  });
  await Promise.all(workers);
}

// ---------- ffmpeg 子进程执行 ----------
function spawnFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else {
        const tail = stderr.slice(-600);
        reject(new Error(`ffmpeg 执行失败（退出码 ${code}）: ${tail}`));
      }
    });
  });
}

// ---------- 流拷贝极速路径 ----------
// 前置条件：所有 clip 编码参数完全一致、音量=1、亮度=0
async function runFfmpegStreamCopy(ffmpegPath, clips, outputFile) {
  const tempListPath = path.join(
    os.tmpdir(),
    `mixedcut-cp-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  await fs.writeFile(tempListPath, clips.map(toConcatFileLine).join("\n"), "utf-8");
  try {
    await spawnFfmpeg(ffmpegPath, [
      "-y",
      "-fflags",
      "+genpts",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      tempListPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputFile
    ]);
  } finally {
    await fs.unlink(tempListPath).catch(() => {});
  }
}

async function runFfmpegConcat(
  ffmpegPath,
  clips,
  outputFile,
  audioVolume,
  videoBrightness,
  hwEncoder,
  options = {}
) {
  const { allowCopy = false } = options;
  const videoFilter = buildNormalizeFilter(videoBrightness);
  const hasAudio = audioVolume > 0;

  // 1) 流拷贝极速路径（同格式 + 不改音量/亮度）
  if (allowCopy) {
    try {
      await runFfmpegStreamCopy(ffmpegPath, clips, outputFile);
      return { mode: "copy" };
    } catch (_copyError) {
      // 流拷贝失败（timebase/SPS 细微差异等）→ 回落到滤镜重编码
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  // 2) concat filter：逐片独立解码并统一到 1080x1920@30
  //    必须用此路径：不同素材的编码/分辨率/声道/像素格式常常不一致，
  //    concat demuxer 在这种情况下会失败或极慢（逐帧艰难输出）。
  const buildFilterArgs = (useHwEncoder) => {
    const args = ["-y"];
    for (const clip of clips) args.push("-i", clip);
    const n = clips.length;
    let filter = "";
    for (let i = 0; i < n; i += 1) {
      filter += `[${i}:v]${videoFilter}[v${i}];`;
      if (hasAudio) {
        let a =
          `[${i}:a]aresample=async=1:first_pts=0,` +
          "aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100";
        if (audioVolume !== 1) a += `,volume=${audioVolume}`;
        filter += `${a}[a${i}];`;
      }
    }
    let concatIn = "";
    for (let i = 0; i < n; i += 1) {
      concatIn += `[v${i}]`;
      if (hasAudio) concatIn += `[a${i}]`;
    }
    filter += `${concatIn}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}[vout]${
      hasAudio ? "[aout]" : ""
    }`;
    args.push("-filter_complex", filter, "-map", "[vout]");
    if (hasAudio) args.push("-map", "[aout]");
    args.push("-r", String(OUTPUT_FPS), "-fps_mode", "cfr");
    pushVideoEncoderArgs(args, useHwEncoder);
    if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k");
    else args.push("-an");
    args.push("-movflags", "+faststart", outputFile);
    return args;
  };

  try {
    try {
      await spawnFfmpeg(ffmpegPath, buildFilterArgs(hwEncoder));
      return { mode: hwEncoder || "libx264" };
    } catch (hwError) {
      if (!hwEncoder) throw hwError;
      // 硬件编码失败兜底用 libx264（如 QSV 输入异常、驱动暂挂起等）
      await fs.unlink(outputFile).catch(() => {});
      await spawnFfmpeg(ffmpegPath, buildFilterArgs(null));
      return { mode: "libx264(fallback)" };
    }
  } catch (error) {
    await fs.unlink(outputFile).catch(() => {});
    throw error;
  }
}

ipcMain.handle("pick-source-folder", async () => pickDirectory());
ipcMain.handle("pick-output-folder", async () => pickDirectory());

ipcMain.handle("get-subfolders", async (_event, sourceDir) => {
  if (!sourceDir) return [];
  return getSubfolders(sourceDir);
});

ipcMain.handle("get-source-stats", async (_event, sourceDir) => {
  if (!sourceDir) return [];
  const subfolderNames = await getSubfolders(sourceDir);
  const stats = [];
  for (const folderName of subfolderNames) {
    const folderPath = path.join(sourceDir, folderName);
    const clips = await getClipsInFolder(folderPath);
    stats.push({
      name: folderName,
      clipCount: clips.length
    });
  }
  return stats;
});

ipcMain.handle("list-adb-devices", async () => listAdbDevices());

ipcMain.handle("start-mix", async (event, payload) => {
  const reportProgress = (message) => {
    try {
      event.sender.send("mix-progress", { message, time: Date.now() });
    } catch (_) {
      /* 窗口已关闭则忽略 */
    }
  };
  const taskStartAt = Date.now();
  reportProgress(`任务开始：${formatDateTime(taskStartAt)}`);

  const {
    sourceDir,
    outputDir,
    orderText,
    outputCount,
    audioVolume,
    videoBrightness,
    saveTarget,
    adbSerial,
    adbPath
  } = payload;
  if (!sourceDir) {
    throw new Error("请选择源文件夹");
  }

  const subfolderNames = await getSubfolders(sourceDir);
  if (subfolderNames.length === 0) {
    throw new Error("源文件夹下没有可用的片段子文件夹");
  }

  const prefixOrder = parsePrefixOrder(orderText || "", subfolderNames.length);
  const folderClips = [];
  for (const folderName of subfolderNames) {
    const folderPath = path.join(sourceDir, folderName);
    const clips = await getClipsInFolder(folderPath);
    if (clips.length === 0) {
      throw new Error(`子文件夹 "${folderName}" 中没有可用视频片段`);
    }
    folderClips.push(clips);
  }

  const count = Number(outputCount);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("产出数量必须是大于 0 的整数");
  }
  const volume = Number(audioVolume);
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error("音量倍率必须是大于等于 0 的数字");
  }
  const brightness = Number(videoBrightness);
  if (!Number.isFinite(brightness) || brightness < -1 || brightness > 1) {
    throw new Error("视频亮度必须在 -1 到 1 之间");
  }
  const targetType = saveTarget === "adb" ? "adb" : "local";
  if (targetType === "local" && !outputDir) {
    throw new Error("请选择本地输出文件夹");
  }
  if (targetType === "adb") {
    if (!adbSerial) throw new Error("请选择 ADB 设备");
    if (!adbPath || !adbPath.trim()) throw new Error("请输入手机保存路径");
  }

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("未找到可用的 ffmpeg 可执行文件");
  }
  reportProgress("检测硬件编码器...");
  const hwEncoder = await detectHwEncoder(ffmpegPath);
  reportProgress(
    hwEncoder ? `将使用硬件编码器：${hwEncoder}` : "未检测到可用硬件编码器，使用 libx264 (CPU)"
  );
  reportProgress(`输出规格：${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}@${OUTPUT_FPS}，共需生成 ${count} 个视频`);

  const finalOutputDir =
    targetType === "local"
      ? outputDir
      : path.join(os.tmpdir(), `mixedcut-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(finalOutputDir, { recursive: true });

  // ===== 阶段一：预探测所有片段编码参数，按格式分组 =====
  const allClipsFlat = folderClips.flat();
  await probeAllClips(ffmpegPath, allClipsFlat, reportProgress);

  // 每个子文件夹内按 formatKey 聚类
  const folderGroupsByKey = folderClips.map((clips) => {
    const groups = new Map();
    for (const clip of clips) {
      const key = formatKey(clipMetaCache.get(clip));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(clip);
    }
    return groups;
  });

  // 在所有子文件夹中都存在的 formatKey（跨文件夹交集）
  const commonKeys = folderGroupsByKey.length
    ? [...folderGroupsByKey[0].keys()]
        .filter((k) => k !== "unknown" && folderGroupsByKey.every((g) => g.has(k)))
        .sort(
          (a, b) =>
            folderGroupsByKey.reduce((s, g) => s + (g.get(b) ? g.get(b).length : 0), 0) -
            folderGroupsByKey.reduce((s, g) => s + (g.get(a) ? g.get(a).length : 0), 0)
        )
    : [];
  const canStreamCopy = volume === 1 && brightness === 0;
  if (commonKeys.length > 0) {
    reportProgress(
      `发现 ${commonKeys.length} 种跨文件夹同格式的组合${
        canStreamCopy ? "，将优先走流拷贝极速路径" : "（因音量/亮度已调，仍需重编码）"
      }`
    );
  } else {
    reportProgress("未发现跨文件夹同格式组合，将全部走重编码路径");
  }

  // ===== 阶段二：预生成 N 组唯一组合（优先同格式） =====
  const clipFailScores = new Map();
  const usedCombinations = new Set();
  const combos = [];

  const buildMatchedPick = (order, forbidden) => {
    // 随机在同格式 key 里挑一个，保证所有 folder 都有这种 key 的片段
    const keys = shuffle(commonKeys);
    for (const key of keys) {
      const clips = order.map((folderIdx) => {
        const pool = folderGroupsByKey[folderIdx].get(key) || [];
        return pool.length ? pickRandom(pool) : null;
      });
      if (clips.some((c) => !c)) continue;
      const uk = buildUniqueKey(order, clips);
      if (!forbidden.has(uk)) return { clips, matchedKey: key, uniqueKey: uk };
    }
    return null;
  };

  const buildAnyPick = (order, forbidden) => {
    for (let t = 0; t < 30; t += 1) {
      const clips = order.map((folderIdx) =>
        pickClipWithPenalty(folderClips[folderIdx], clipFailScores)
      );
      if (clips.some((c) => !c)) continue;
      const uk = buildUniqueKey(order, clips);
      if (!forbidden.has(uk)) return { clips, matchedKey: null, uniqueKey: uk };
    }
    return null;
  };

  for (let i = 0; i < count; i += 1) {
    let picked = null;
    for (let retry = 0; retry < 500 && !picked; retry += 1) {
      const order = buildOrder(prefixOrder, folderClips.length);
      // 前 70% 次尝试偏好同格式；失败或没有同格式再回退到任意组合
      if (commonKeys.length > 0 && retry < 350) {
        picked = buildMatchedPick(order, usedCombinations);
      }
      if (!picked) {
        picked = buildAnyPick(order, usedCombinations);
      }
      if (picked) picked.order = order;
    }
    if (!picked) {
      throw new Error(
        `无法生成第 ${i + 1} 个可用组合：候选组合已耗尽，请减少产出数量或增加片段数`
      );
    }
    usedCombinations.add(picked.uniqueKey);
    combos.push(picked);
  }

  const matchedCount = combos.filter((c) => c.matchedKey).length;
  reportProgress(
    `组合已分配：同格式 ${matchedCount} 条，混合格式 ${count - matchedCount} 条`
  );
  const encodeCacheRoot = getEncodeCacheRoot();
  const useEncodedClipCache = !(canStreamCopy && matchedCount === count);
  if (useEncodedClipCache) {
    reportProgress(`已启用转码缓存：${encodeCacheRoot}`);
  }

  // ===== 阶段三：并发执行 =====
  // 流拷贝是 I/O 限定，可以并发更多；硬件编码受 GPU 会话数限制；CPU 编码更少
  const cpuCount = Math.max(2, os.cpus().length || 4);
  let concurrency;
  if (canStreamCopy && matchedCount === count) {
    concurrency = Math.min(8, cpuCount);
  } else if (hwEncoder) {
    concurrency = Math.min(3, cpuCount);
  } else {
    concurrency = Math.min(2, cpuCount);
  }
  if (concurrency > count) concurrency = count;
  reportProgress(`并发 ${concurrency} 条同时编码`);

  const results = new Array(count);
  const outputFiles = combos.map((_, i) =>
    path.join(finalOutputDir, `mixed_${String(i + 1).padStart(3, "0")}.mp4`)
  );
  let completed = 0;
  const totalStart = Date.now();

  const runOneTask = async (i) => {
    const { order, clips, matchedKey } = combos[i];
    const outputFile = outputFiles[i];
    await fs.unlink(outputFile).catch(() => {});
    const tagMode = useEncodedClipCache
      ? "缓存复用"
      : canStreamCopy && matchedKey
        ? "流拷贝"
        : matchedKey
          ? "同格式/重编码"
          : "重编码";
    reportProgress(
      `#${i + 1}/${count} 开始（${tagMode}；顺序 ${order.map((x) => x + 1).join("-")}）`
    );
    const t = Date.now();
    let mode;
    if (useEncodedClipCache) {
      const cachedClips = await Promise.all(
        clips.map((clip) =>
          getOrCreateCachedClip(ffmpegPath, clip, encodeCacheRoot, volume, brightness, reportProgress)
        )
      );
      mode = await runFfmpegConcat(ffmpegPath, cachedClips, outputFile, 1, 0, null, { allowCopy: true });
    } else {
      mode = await runFfmpegConcat(ffmpegPath, clips, outputFile, volume, brightness, hwEncoder, {
        allowCopy: canStreamCopy && !!matchedKey
      });
    }
    completed += 1;
    reportProgress(
      `#${i + 1}/${count} 完成（${mode.mode || "?"}，用时 ${((Date.now() - t) / 1000).toFixed(
        1
      )}s）[进度 ${completed}/${count}]`
    );
    let savedPath = outputFile;
    if (targetType === "adb") {
      savedPath = await pushToAdbDevice(adbSerial, adbPath, outputFile);
      await fs.unlink(outputFile).catch(() => {});
    }
    results[i] = {
      outputFile,
      savedPath,
      folderOrder: order.map((idx) => idx + 1),
      clips
    };
  };

  // 工作池
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const my = nextIndex;
      nextIndex += 1;
      if (my >= count) return;
      try {
        await runOneTask(my);
      } catch (error) {
        // 单条失败：不中止其它任务，只记录
        for (const clip of combos[my].clips) {
          clipFailScores.set(clip, (clipFailScores.get(clip) || 0) + 1);
        }
        reportProgress(
          `#${my + 1}/${count} 失败：${(error.message || String(error)).slice(0, 200)}`
        );
        results[my] = { error: error.message || String(error) };
      }
    }
  });
  await Promise.all(workers);

  const ok = results.filter((r) => r && !r.error);
  const failed = results.filter((r) => r && r.error);
  reportProgress(
    `全部完成：成功 ${ok.length}/${count}，失败 ${failed.length}，总用时 ${(
      (Date.now() - totalStart) /
      1000
    ).toFixed(1)}s`
  );

  if (targetType === "adb") {
    await fs.rm(finalOutputDir, { recursive: true, force: true }).catch(() => {});
  }
  if (useEncodedClipCache) {
    await cleanupEncodeCache(encodeCacheRoot, reportProgress).catch(() => {});
  }
  const taskEndAt = Date.now();
  reportProgress(
    `处理时间：开始 ${formatDateTime(taskStartAt)}，结束 ${formatDateTime(taskEndAt)}，耗时 ${(
      (taskEndAt - taskStartAt) /
      1000
    ).toFixed(1)}s`
  );

  return {
    generated: ok.length,
    failed: failed.length,
    ffmpegPath,
    hwEncoder: hwEncoder || null,
    outputSpec: `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}@${OUTPUT_FPS}`,
    targetType,
    concurrency,
    matchedCombos: matchedCount,
    encodedCacheUsed: useEncodedClipCache,
    streamCopyUsed: canStreamCopy && matchedCount > 0,
    results: ok
  };
});

app.whenReady().then(() => {
  createWindow();
  // 后台预热：应用启动后就开始探测硬件编码器，用户首次点击混剪时无需等待
  try {
    const earlyFfmpeg = resolveFfmpegPath();
    if (earlyFfmpeg) {
      detectHwEncoder(earlyFfmpeg).catch(() => {});
    }
  } catch (_) {
    /* 忽略启动期探测错误 */
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
