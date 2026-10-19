import {
  jobs,
  getJob,
  putJob,
  getChunks,
  getViews,
  hasPendingRequests,
  deleteJob,
  getSetting,
  setSetting,
} from "./db.js";
import { exportTexts, timestamp } from "./core.js";
import { concurrencyLimit } from "./pool.js";
import { zipSync, strToU8 } from "./vendor/fflate.mjs";
const $ = (id) => document.getElementById(id),
  element = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
const LABELS = {
  new: "Готов к запуску",
  preparing: "Подготовка",
  transcribing: "Распознавание",
  complete: "Готово",
  paused: "Пауза",
  needs_file: "Нужен исходник",
  unknown: "Проверить запрос",
  error: "Ошибка",
};
let records = [],
  files = [],
  selected = null,
  busy = false,
  worker = null,
  wakeLock = null,
  toastTimer,
  mediaURL = null;
const sources = new Map(),
  activeCounts = new Map();
function icon(name) {
  const span = element("span", null, "icon");
  span.setAttribute("aria-hidden", "true");
  span.style.setProperty(
    "--icon",
    `url("${new URL(`./vendor/lucide/${name}.svg`, import.meta.url).href}")`,
  );
  return span;
}
const toast = (text) => {
  clearTimeout(toastTimer);
  $("toast").textContent = text;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
};
const bytes = (n) =>
  n >= 1024 ** 3
    ? (n / 1024 ** 3).toFixed(2) + " ГБ"
    : n >= 1024 ** 2
      ? (n / 1024 ** 2).toFixed(1) + " МБ"
      : Math.ceil(n / 1024) + " КБ";
async function fingerprint(file) {
  const buffer = await new Blob([
    String(file.size),
    file.slice(0, 65536),
    file.slice(Math.max(0, file.size - 65536)),
  ]).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function choose(list) {
  if (busy) return;
  files = [...list].filter((f) => f.size);
  $("selected-files").replaceChildren();
  for (const [i, file] of files.entries()) {
    const row = element("div", null, "selected-file"),
      text = element("span", file.name);
    text.append(element("small", bytes(file.size)));
    const remove = element("button");
    remove.append(icon("x"));
    remove.title = "Убрать";
    remove.setAttribute("aria-label", "Убрать " + file.name);
    remove.onclick = () => choose(files.filter((_, n) => n !== i));
    row.append(text, remove);
    $("selected-files").append(row);
  }
  $("start").replaceChildren(
    element(
      "span",
      files.length > 1
        ? `Транскрибировать · ${files.length}`
        : "Транскрибировать",
    ),
    icon("arrow-up-right"),
  );
}
async function refresh() {
  records = await jobs();
  renderHistory();
  if (selected) {
    const job = records.find((j) => j.id === selected);
    if (job) await renderJob(job);
  }
}
function renderHistory() {
  $("history-count").textContent = records.length || "";
  $("history").replaceChildren();
  if (!records.length) {
    $("history").append(element("div", "Пока пусто.", "empty"));
    return;
  }
  for (const job of records) {
    const row = element("div", null, "history-row"),
      button = element(
        "button",
        null,
        "history-item " + job.status + (job.id === selected ? " active" : ""),
      );
    button.type = "button";
    button.append(
      element("strong", job.filename),
      element("small", LABELS[job.status] || job.status),
    );
    button.onclick = () => select(job.id);
    const remove = element("button", null, "delete");
    remove.append(icon("x"));
    remove.title = "Удалить запись";
    remove.setAttribute("aria-label", "Удалить " + job.filename);
    remove.onclick = async () => {
      if (busy) return toast("Дождитесь завершения или остановите обработку.");
      if (!confirm("Удалить расшифровку из этого браузера?")) return;
      await deleteJob(job.id);
      sources.delete(job.id);
      if (selected === job.id) {
        selected = null;
        $("result").hidden = true;
      }
      await refresh();
    };
    row.append(button, remove);
    $("history").append(row);
  }
}
async function select(id) {
  selected = id;
  $("acknowledge").checked = false;
  $("result").hidden = false;
  await refresh();
  const file = sources.get(id);
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = null;
  $("audio-controls").hidden = !file;
  $("player").pause();
  if (file) {
    mediaURL = URL.createObjectURL(file);
    $("player").src = mediaURL;
  } else {
    $("player").removeAttribute("src");
    $("player").load();
  }
}
async function renderJob(job) {
  $("result-name").textContent = job.filename;
  $("result-meta").textContent = [
    bytes(job.size),
    job.duration ? timestamp(job.duration) : null,
    job.done
      ? job.cost == null
        ? ""
        : Number(job.cost).toFixed(2) + " ₽"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const active = ["preparing", "transcribing"].includes(job.status);
  $("progress-wrap").hidden = !active;
  $("progress").value = job.total ? (100 * (job.done || 0)) / job.total : 0;
  $("job-state").textContent = LABELS[job.status];
  $("job-percent").textContent = job.total
    ? `${job.done || 0} / ${job.total}${activeCounts.get(job.id) > 1 ? " · " + activeCounts.get(job.id) + " одновременно" : ""}`
    : "";
  $("job-notice").hidden = !job.error;
  $("job-notice").textContent = job.error || "";
  $("retry-consent").hidden = job.status !== "unknown";
  $("job-actions").replaceChildren();
  if (active && busy) {
    const pause = element("button", "Остановить", "secondary");
    pause.onclick = () => {
      worker?.postMessage({ type: "pause" });
      toast("Дождёмся сохранения уже отправленных фрагментов.");
    };
    $("job-actions").append(pause);
  }
  if (["paused", "unknown", "error", "needs_file"].includes(job.status)) {
    const resume = element("button", "Продолжить", "secondary");
    resume.onclick = () => runExisting(job);
    $("job-actions").append(resume);
  }
  document.querySelector(".download-controls").hidden = !job.done;
  $("download-label").textContent =
    job.status === "complete"
      ? "Скачать файл"
      : `Скачать · ${job.done || 0}/${job.total}`;
  $("download").title =
    job.status === "complete"
      ? "Скачать всю расшифровку одним файлом"
      : "Скачать готовые фрагменты";
  $("download-format").querySelector('[value="srt"]').disabled =
    !!job.has_untimed;
  if ($("download-format").selectedOptions[0]?.disabled)
    $("download-format").value = "txt";
}
async function lockScreen() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
async function execute(job, file, key, acknowledge = false) {
  busy = true;
  $("start").disabled = true;
  $("concurrency").disabled = true;
  await lockScreen();
  return new Promise((resolve, reject) => {
    let finished = false;
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    const finish = async () => {
      if (finished) return;
      finished = true;
      worker?.terminate();
      worker = null;
      busy = false;
      activeCounts.delete(job.id);
      $("start").disabled = false;
      $("concurrency").disabled = false;
      await wakeLock?.release().catch(() => {});
      wakeLock = null;
      await refresh();
      resolve();
    };
    worker.onmessage = async (event) => {
      const data = event.data;
      if (data.type === "update") {
        await refresh();
      } else if (data.type === "active") {
        activeCounts.set(data.id, data.count);
        await refresh();
      } else if (
        data.type === "progress" &&
        selected === data.id &&
        !data.active
      ) {
        $("job-state").textContent = "Подготовка";
        $("job-percent").textContent = `${Math.round(data.progress * 100)}%`;
      } else if (data.type === "finished") {
        await finish();
      } else if (data.type === "failure") {
        toast(data.message);
        await finish();
      }
    };
    worker.onerror = async () => {
      toast("Обработка прервалась. Прогресс сохранён.");
      worker?.terminate();
      worker = null;
      await recoverInterrupted();
      await finish();
    };
    worker.postMessage({
      type: "run",
      id: job.id,
      file,
      apiKey: key,
      acknowledge,
      diarize: true,
      concurrency: concurrencyLimit($("concurrency").value),
    });
    key = "";
  });
}
async function runExisting(job) {
  if (busy) return;
  const key = $("api-key").value.trim();
  if (!key) return toast("Введите ключ RouterAI.");
  if (job.status === "unknown" && !$("acknowledge").checked)
    return toast("Проверьте запрос в RouterAI и подтвердите повтор.");
  let file = sources.get(job.id);
  if (!file && files.length) {
    for (const candidate of files)
      if ((await fingerprint(candidate)) === job.fingerprint) {
        file = candidate;
        sources.set(job.id, file);
        break;
      }
  }
  if (!file && !job.plan) return toast("Выберите исходный аудиофайл.");
  await execute(job, file, key, $("acknowledge").checked);
}
async function start() {
  if (busy) return;
  const key = $("api-key").value.trim();
  if (!key) return toast("Введите ключ RouterAI.");
  if (!files.length) {
    const current = selected ? await getJob(selected) : null;
    if (current && current.status !== "complete") return runExisting(current);
    return toast("Выберите аудио.");
  }
  try {
    await navigator.storage?.persist?.();
  } catch {}
  try {
    for (const file of files) {
      const hash = await fingerprint(file);
      let job = (await jobs()).find((j) => j.fingerprint === hash);
      if (!job) {
        job = {
          id: crypto.randomUUID(),
          filename: file.name,
          size: file.size,
          fingerprint: hash,
          created: Date.now(),
          status: "new",
          done: 0,
          total: 0,
          cost: null,
          error: null,
        };
        await putJob(job);
      }
      sources.set(job.id, file);
      await select(job.id);
      if (job.status === "complete") {
        toast("Эта запись уже расшифрована.");
        continue;
      }
      if (job.status === "unknown") {
        toast("Сначала проверьте неподтверждённый запрос.");
        break;
      }
      await execute(job, file, key);
      const latest = await getJob(job.id);
      if (latest.status !== "complete") break;
    }
    choose([]);
  } catch (error) {
    toast(
      error.name === "QuotaExceededError"
        ? "Недостаточно места в браузере."
        : error.message,
    );
  }
}
async function recoverInterrupted() {
  const locks = await navigator.locks?.query();
  if (locks?.held?.some((l) => l.name === "scribe-studio-processing")) return;
  for (const job of await jobs())
    if (["preparing", "transcribing"].includes(job.status)) {
      const unknown = await hasPendingRequests(job.id);
      job.status = unknown ? "unknown" : "paused";
      job.error = unknown
        ? "Вкладка закрылась во время запроса. Проверьте списание в RouterAI перед повтором."
        : null;
      await putJob(job);
    }
}
function save(blob, name) {
  const url = URL.createObjectURL(blob),
    a = element("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function download() {
  if (!selected) return;
  const job = await getJob(selected),
    fmt = $("download-format").value,
    stem = job.filename.replace(/\.[^.]+$/, "");
  const full = exportTexts(
    job,
    await (fmt === "zip" || fmt === "json"
      ? getChunks(job.id)
      : getViews(job.id, Infinity)),
  );
  if (fmt === "srt" && full.segments.some((segment) => !segment.timed))
    return toast("В ответе API нет таймкодов. Выберите TXT или JSON.");
  if (fmt === "zip") {
    const files = {
      "transcript.txt": strToU8(full.txt),
      "timed.txt": strToU8(full.timed),
      "transcript.json": strToU8(full.json),
    };
    if (!full.segments.some((s) => !s.timed))
      files["subtitles.srt"] = strToU8(full.srt);
    save(
      new Blob([zipSync(files)], { type: "application/zip" }),
      stem + ".zip",
    );
  } else
    save(
      new Blob([full[fmt]], {
        type: fmt === "json" ? "application/json" : "text/plain;charset=utf-8",
      }),
      stem +
        (fmt === "timed" ? " — таймкоды" : "") +
        "." +
        (fmt === "timed" ? "txt" : fmt),
    );
}
$("show-key").onclick = () => {
  const show = $("api-key").type === "password";
  $("api-key").type = show ? "text" : "password";
  $("show-key").replaceChildren(icon(show ? "eye-off" : "eye"));
  $("show-key").setAttribute(
    "aria-label",
    show ? "Скрыть ключ" : "Показать ключ",
  );
};
$("concurrency").onchange = () =>
  setSetting("concurrency", concurrencyLimit($("concurrency").value)).catch(
    () => toast("Не удалось сохранить настройку."),
  );
$("api-key").oninput = () => {
  setSetting("api-key", $("api-key").value.trim()).catch(() =>
    toast("Не удалось сохранить ключ в браузере."),
  );
};
function updatePlayer() {
  const player = $("player"),
    duration = Number.isFinite(player.duration) ? player.duration : 0;
  $("audio-position").max = duration || 1;
  $("audio-position").value = player.currentTime || 0;
  $("audio-time").textContent = [player.currentTime, duration]
    .map((t) => timestamp(t).replace(/^00:/, ""))
    .join(" / ");
  $("play-pause").replaceChildren(icon(player.paused ? "play" : "pause"));
  $("play-pause").setAttribute(
    "aria-label",
    player.paused ? "Слушать" : "Пауза",
  );
}
for (const name of [
  "loadedmetadata",
  "timeupdate",
  "play",
  "pause",
  "ended",
  "emptied",
]) {
  $("player").addEventListener(name, updatePlayer);
}
$("play-pause").onclick = () => {
  if ($("player").paused)
    $("player")
      .play()
      .catch(() => toast("Не удалось воспроизвести аудио."));
  else $("player").pause();
};
$("audio-position").oninput = () => {
  $("player").currentTime = Number($("audio-position").value);
};
$("file-input").onchange = (e) => choose(e.target.files);
for (const name of ["dragenter", "dragover"])
  $("dropzone").addEventListener(name, (e) => {
    e.preventDefault();
    $("dropzone").classList.add("drag");
  });
for (const name of ["dragleave", "drop"])
  $("dropzone").addEventListener(name, (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("drag");
  });
$("dropzone").addEventListener("drop", (e) => choose(e.dataTransfer.files));
$("start").onclick = () => start().catch((e) => toast(e.message));
$("download").onclick = () => download().catch((error) => toast(error.message));
addEventListener("beforeunload", (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && busy) lockScreen();
});
try {
  if (!isSecureContext || !globalThis.indexedDB || !globalThis.Worker)
    throw new Error("Откройте страницу по HTTPS в современном браузере.");
  $("api-key").value = (await getSetting("api-key")) || "";
  $("concurrency").value = concurrencyLimit(
    (await getSetting("concurrency")) ?? 10,
  );
  await recoverInterrupted();
  await refresh();
  if (records.length) await select(records[0].id);
  setInterval(() => {
    if (!busy) refresh().catch(() => {});
  }, 3000);
} catch (error) {
  toast(error.message);
  $("start").disabled = true;
}
