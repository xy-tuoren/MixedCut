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
    child.on("error", (error) => reject(error));
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
  const result = await runCommand("adb", ["devices", "-l"]);
  return parseAdbDevicesOutput(result.stdout);
}

async function pushToAdbDevice(serial, adbDirPath, localFilePath) {
  const normalizedDir = adbDirPath.replace(/\\/g, "/").trim();
  await runCommand("adb", ["-s", serial, "shell", "mkdir", "-p", normalizedDir]);
  await runCommand("adb", ["-s", serial, "push", localFilePath, normalizedDir]);
  return path.posix.join(normalizedDir, path.basename(localFilePath));
}

async function runFfmpegConcat(ffmpegPath, clips, outputFile, audioVolume, videoBrightness) {
  const tempListPath = path.join(
    os.tmpdir(),
    `mixedcut-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  const concatContent = clips.map(toConcatFileLine).join("\n");
  await fs.writeFile(tempListPath, concatContent, "utf-8");

  const args = [
    "-y",
    // 对损坏数据尽量容错，避免单个坏帧导致整次混剪失败
    "-fflags",
    "+genpts+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    tempListPath,
    "-c:v",
    "libx264",
    "-vf",
    `eq=brightness=${videoBrightness}`,
    "-preset",
    "veryfast",
    "-crf",
    "23"
  ];
  if (audioVolume <= 0) {
    // 音量为 0 时直接不输出音轨，可规避大量音频损坏导致的失败
    args.push("-an");
  } else {
    args.push("-af", `volume=${audioVolume}`, "-c:a", "aac", "-b:a", "192k");
  }
  args.push(outputFile);

  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 执行失败（退出码 ${code}）`));
      });
    }).catch(async (error) => {
      // 某些素材虽有解码报错，但 ffmpeg 末尾非 0 且仍产出可播放文件；这里做兜底
      try {
        const stat = await fs.stat(outputFile);
        if (stat.size > 0) {
          return;
        }
      } catch (_e) {
        // no-op
      }
      throw new Error(`${error.message}: ${stderr}`);
    });
  } finally {
    await fs.unlink(tempListPath).catch(() => {});
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

ipcMain.handle("start-mix", async (_event, payload) => {
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
      try {
        await runFfmpegConcat(ffmpegPath, clips, outputFile, volume, brightness);
        finalOrder = order;
        pickedClips = clips;
        uniqueKey = key;
        break;
      } catch (error) {
        lastConcatError = error;
        triedKeysThisVideo.add(key);
        for (const clip of clips) {
          clipFailScores.set(clip, (clipFailScores.get(clip) || 0) + 1);
        }
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
    targetType,
    results
  };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
