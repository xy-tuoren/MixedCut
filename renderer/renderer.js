const state = {
  sourceDir: "",
  outputDir: "",
  subfolders: [],
  sourceStats: [],
  maxCombinations: null,
  adbDevices: []
};

const sourcePathEl = document.getElementById("sourcePath");
const outputPathEl = document.getElementById("outputPath");
const subfolderListEl = document.getElementById("subfolderList");
const orderInputEl = document.getElementById("orderInput");
const outputCountEl = document.getElementById("outputCount");
const audioVolumeEl = document.getElementById("audioVolume");
const audioVolumeValueEl = document.getElementById("audioVolumeValue");
const videoBrightnessEl = document.getElementById("videoBrightness");
const videoBrightnessValueEl = document.getElementById("videoBrightnessValue");
const maxComboInfoEl = document.getElementById("maxComboInfo");
const logEl = document.getElementById("log");
const btnStartEl = document.getElementById("btnStart");
const saveTargetEls = document.querySelectorAll('input[name="saveTarget"]');
const localOutputSettingsEl = document.getElementById("localOutputSettings");
const adbSettingsEl = document.getElementById("adbSettings");
const btnRefreshAdbEl = document.getElementById("btnRefreshAdb");
const adbDeviceSelectEl = document.getElementById("adbDeviceSelect");
const adbPathInputEl = document.getElementById("adbPathInput");

function appendLog(text) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

if (window.mixedCutApi && typeof window.mixedCutApi.onMixProgress === "function") {
  window.mixedCutApi.onMixProgress((data) => {
    if (data && data.message) appendLog(data.message);
  });
}

function renderAdjustValue() {
  audioVolumeValueEl.textContent = Number(audioVolumeEl.value).toFixed(1);
  videoBrightnessValueEl.textContent = Number(videoBrightnessEl.value).toFixed(2);
}

function getSelectedSaveTarget() {
  const checked = Array.from(saveTargetEls).find((el) => el.checked);
  return checked ? checked.value : "local";
}

function updateSaveTargetView() {
  const target = getSelectedSaveTarget();
  localOutputSettingsEl.classList.toggle("hidden", target !== "local");
  adbSettingsEl.classList.toggle("hidden", target !== "adb");
}

function renderAdbDevices() {
  adbDeviceSelectEl.innerHTML = "";
  if (!state.adbDevices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未检测到可用设备";
    adbDeviceSelectEl.appendChild(option);
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "请选择设备";
  adbDeviceSelectEl.appendChild(placeholder);

  state.adbDevices.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.serial;
    const desc = [item.serial, item.model, item.deviceName].filter(Boolean).join(" | ");
    option.textContent = desc || item.serial;
    adbDeviceSelectEl.appendChild(option);
  });
}

async function refreshAdbDevices() {
  try {
    const previousSelectedSerial = adbDeviceSelectEl.value;
    state.adbDevices = await window.mixedCutApi.listAdbDevices();
    renderAdbDevices();
    if (state.adbDevices.length) {
      const hasPrevious = state.adbDevices.some((item) => item.serial === previousSelectedSerial);
      const selectedSerial = hasPrevious ? previousSelectedSerial : state.adbDevices[0].serial;
      adbDeviceSelectEl.value = selectedSerial;
      appendLog(`已自动选中设备：${selectedSerial}`);
    }
    appendLog(`ADB 设备检测完成，共 ${state.adbDevices.length} 台在线设备。`);
  } catch (error) {
    appendLog(`ADB 设备检测失败：${error.message || String(error)}`);
  }
}

function renderSubfolders() {
  if (!state.subfolders.length) {
    subfolderListEl.textContent = "未检测到子文件夹。";
    return;
  }
  subfolderListEl.textContent = state.subfolders
    .map((name, idx) => `${idx + 1}. ${name}`)
    .join("    ");
}

function parseOrderForUi(orderText, maxCount) {
  if (!orderText || !orderText.trim()) {
    return { prefixOrder: [], error: "" };
  }

  const numbers = orderText
    .split(/[-,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));

  if (numbers.length > maxCount) {
    return { prefixOrder: [], error: `顺序数量不能超过子文件夹数量（${maxCount}）` };
  }
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > maxCount)) {
    return { prefixOrder: [], error: `顺序仅支持 1~${maxCount} 的整数` };
  }
  if (new Set(numbers).size !== numbers.length) {
    return { prefixOrder: [], error: "顺序中不能包含重复编号" };
  }

  return {
    prefixOrder: numbers.map((n) => n - 1),
    error: ""
  };
}

function factorialBigInt(n) {
  let result = 1n;
  for (let i = 2; i <= n; i += 1) {
    result *= BigInt(i);
  }
  return result;
}

function updateMaxCombinationsView() {
  if (!state.sourceStats.length) {
    state.maxCombinations = null;
    maxComboInfoEl.textContent = "最大可生成组合数：-";
    return;
  }

  const { prefixOrder, error } = parseOrderForUi(orderInputEl.value, state.sourceStats.length);
  if (error) {
    state.maxCombinations = null;
    maxComboInfoEl.textContent = `最大可生成组合数：-（${error}）`;
    return;
  }

  const hasEmptyFolder = state.sourceStats.some((item) => item.clipCount <= 0);
  if (hasEmptyFolder) {
    state.maxCombinations = 0n;
    maxComboInfoEl.textContent = "最大可生成组合数：0（存在空子文件夹）";
    return;
  }

  const remainingFolderCount = state.sourceStats.length - prefixOrder.length;
  const orderCombinations = factorialBigInt(remainingFolderCount);
  const clipCombinations = state.sourceStats.reduce(
    (acc, item) => acc * BigInt(item.clipCount),
    1n
  );
  state.maxCombinations = orderCombinations * clipCombinations;
  maxComboInfoEl.textContent = `最大可生成组合数：${state.maxCombinations.toString()}`;
}

async function refreshSubfolders() {
  if (!state.sourceDir) {
    state.subfolders = [];
    state.sourceStats = [];
    renderSubfolders();
    updateMaxCombinationsView();
    return;
  }

  state.sourceStats = await window.mixedCutApi.getSourceStats(state.sourceDir);
  state.subfolders = state.sourceStats.map((item) => item.name);
  renderSubfolders();
  updateMaxCombinationsView();
}

document.getElementById("btnPickSource").addEventListener("click", async () => {
  const folder = await window.mixedCutApi.pickSourceFolder();
  if (!folder) return;
  state.sourceDir = folder;
  sourcePathEl.textContent = folder;
  appendLog(`已选择素材目录：${folder}`);
  await refreshSubfolders();
});

document.getElementById("btnPickOutput").addEventListener("click", async () => {
  const folder = await window.mixedCutApi.pickOutputFolder();
  if (!folder) return;
  state.outputDir = folder;
  outputPathEl.textContent = folder;
  appendLog(`已选择输出目录：${folder}`);
});

btnStartEl.addEventListener("click", async () => {
  const saveTarget = getSelectedSaveTarget();
  if (!state.sourceDir) {
    appendLog("请先选择素材目录。");
    return;
  }
  if (saveTarget === "local" && !state.outputDir) {
    appendLog("请先选择输出目录。");
    return;
  }
  if (saveTarget === "adb") {
    if (!adbDeviceSelectEl.value) {
      appendLog("请选择 ADB 设备。");
      return;
    }
    if (!adbPathInputEl.value.trim()) {
      appendLog("请输入手机保存路径。");
      return;
    }
  }
  if (state.maxCombinations !== null) {
    const wanted = Number(outputCountEl.value);
    if (Number.isInteger(wanted) && wanted > 0 && BigInt(wanted) > state.maxCombinations) {
      appendLog(
        `请求数量 ${wanted} 超过最大可生成组合数 ${state.maxCombinations.toString()}，请调小数量。`
      );
      return;
    }
  }
  const audioVolume = Number(audioVolumeEl.value);
  if (!Number.isFinite(audioVolume) || audioVolume < 0) {
    appendLog("音量倍率必须是大于等于 0 的数字。");
    return;
  }
  const videoBrightness = Number(videoBrightnessEl.value);
  if (!Number.isFinite(videoBrightness) || videoBrightness < -1 || videoBrightness > 1) {
    appendLog("视频亮度必须在 -1 到 1 之间。");
    return;
  }

  btnStartEl.disabled = true;
  try {
    appendLog("开始执行混剪...");
    const result = await window.mixedCutApi.startMix({
      sourceDir: state.sourceDir,
      outputDir: state.outputDir,
      orderText: orderInputEl.value,
      outputCount: Number(outputCountEl.value),
      audioVolume,
      videoBrightness,
      saveTarget,
      adbSerial: adbDeviceSelectEl.value,
      adbPath: adbPathInputEl.value.trim()
    });

    appendLog(
      `完成，共生成 ${result.generated} 个视频${result.failed ? `（失败 ${result.failed}）` : ""}。`
    );
    appendLog(`ffmpeg 路径：${result.ffmpegPath}`);
    if (result.outputSpec) {
      appendLog(`输出规格：${result.outputSpec}`);
    }
    appendLog(
      `编码器：${result.hwEncoder ? `${result.hwEncoder}（硬件加速）` : "libx264（CPU）"}`
    );
    if (typeof result.concurrency === "number") {
      appendLog(`并发数：${result.concurrency}`);
    }
    if (typeof result.matchedCombos === "number") {
      appendLog(
        `同格式组合：${result.matchedCombos} 条${
          result.streamCopyUsed ? "（已启用流拷贝极速路径）" : ""
        }`
      );
    }
    appendLog(`保存目标：${result.targetType === "adb" ? "手机(ADB)" : "本地文件夹"}`);
    appendLog(`输出音量倍率：${audioVolume}`);
    appendLog(`视频亮度：${videoBrightness.toFixed(2)}`);
    result.results.forEach((item, index) => {
      appendLog(
        `#${index + 1} 顺序 ${item.folderOrder.join("-")} -> ${item.savedPath || item.outputFile}`
      );
    });
  } catch (error) {
    appendLog(`失败：${error.message || String(error)}`);
  } finally {
    btnStartEl.disabled = false;
  }
});

orderInputEl.addEventListener("input", () => {
  updateMaxCombinationsView();
});
audioVolumeEl.addEventListener("input", renderAdjustValue);
videoBrightnessEl.addEventListener("input", renderAdjustValue);
saveTargetEls.forEach((el) => {
  el.addEventListener("change", updateSaveTargetView);
});
btnRefreshAdbEl.addEventListener("click", refreshAdbDevices);

renderAdjustValue();
updateSaveTargetView();

appendLog("应用已启动，请先选择素材目录和输出目录。");
