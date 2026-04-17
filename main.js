const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
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

async function runFfmpegConcat(
  ffmpegPath,
  clips,
  outputFile,
  audioVolume,
  videoBrightness,
  hwEncoder
) {
  const runArgs = (args) =>
    new Promise((resolve, reject) => {
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

  const videoFilter = buildNormalizeFilter(videoBrightness);
  const hasAudio = audioVolume > 0;

  // concat filter：逐片独立解码并统一到 1080x1920@30、立体声 44.1kHz
  // 必须用此路径：不同素材的编码/分辨率/声道/像素格式常常不一致，
  // concat demuxer 在这种情况下会失败或极慢（逐帧艰难输出）。
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
      await runArgs(buildFilterArgs(hwEncoder));
      return;
    } catch (hwError) {
      if (!hwEncoder) throw hwError;
      // 硬件编码单次失败时兜底用 libx264（例如 QSV 输入异常、驱动暂挂起等）
      await fs.unlink(outputFile).catch(() => {});
      await runArgs(buildFilterArgs(null));
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
  const usedCombinations = new Set();
  const clipFailScores = new Map();
  const results = [];

  for (let i = 0; i < count; i += 1) {
    let finalOrder = null;
    let pickedClips = null;
    let uniqueKey = null;
    let lastConcatError = null;
    const triedKeysThisVideo = new Set();

    for (let retry = 0; retry < 500; retry += 1) {
      const order = buildOrder(prefixOrder, folderClips.length);
      const clips = order.map((folderIdx) => pickClipWithPenalty(folderClips[folderIdx], clipFailScores));
      if (clips.some((clip) => !clip)) {
        continue;
      }
      const key = buildUniqueKey(order, clips);
      if (usedCombinations.has(key) || triedKeysThisVideo.has(key)) {
        continue;
      }

      const outputFile = path.join(finalOutputDir, `mixed_${String(i + 1).padStart(3, "0")}.mp4`);
      await fs.unlink(outputFile).catch(() => {});
      if (retry === 0) {
        reportProgress(`#${i + 1}/${count} 开始编码（顺序 ${order.map((x) => x + 1).join("-")}）`);
      } else {
        reportProgress(`#${i + 1}/${count} 第 ${retry + 1} 次尝试...`);
      }
      const encodeStart = Date.now();
      try {
        await runFfmpegConcat(ffmpegPath, clips, outputFile, volume, brightness, hwEncoder);
        finalOrder = order;
        pickedClips = clips;
        uniqueKey = key;
        reportProgress(
          `#${i + 1}/${count} 完成，用时 ${((Date.now() - encodeStart) / 1000).toFixed(1)}s`
        );
        break;
      } catch (error) {
        lastConcatError = error;
        triedKeysThisVideo.add(key);
        for (const clip of clips) {
          clipFailScores.set(clip, (clipFailScores.get(clip) || 0) + 1);
        }
        reportProgress(
          `#${i + 1}/${count} 第 ${retry + 1} 次失败，换一组重试：${(error.message || "").slice(0, 120)}`
        );
      }
    }

    if (!pickedClips || !finalOrder || !uniqueKey) {
      const suffix = lastConcatError ? `；最近一次失败原因：${lastConcatError.message}` : "";
      throw new Error(
        `无法生成第 ${i + 1} 个可用视频：候选组合已耗尽或素材片段存在损坏，请补充/替换片段后重试${suffix}`
      );
    }

    usedCombinations.add(uniqueKey);
    const outputFile = path.join(finalOutputDir, `mixed_${String(i + 1).padStart(3, "0")}.mp4`);
    let savedPath = outputFile;
    if (targetType === "adb") {
      savedPath = await pushToAdbDevice(adbSerial, adbPath, outputFile);
      await fs.unlink(outputFile).catch(() => {});
    }

    results.push({
      outputFile,
      savedPath,
      folderOrder: finalOrder.map((idx) => idx + 1),
      clips: pickedClips
    });
  }

  if (targetType === "adb") {
    await fs.rm(finalOutputDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    generated: results.length,
    ffmpegPath,
    hwEncoder: hwEncoder || null,
    outputSpec: `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}@${OUTPUT_FPS}`,
    targetType,
    results
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
