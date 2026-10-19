import {
  API_BASE,
  MODEL,
  planChunks,
  normalizeChunk,
  MAX_BYTES,
} from "./core.js";
import {
  getJob,
  putJob,
  getChunk,
  putChunk,
  saveAudio,
  getAudio,
  deleteAudio,
  commitChunk,
} from "./db.js";
import { openAudio, wavChunk } from "./audio.js";
let paused = false;
const send = (job) => postMessage({ type: "update", job });
async function request(blob, key, diarize) {
  if (blob.size > MAX_BYTES) throw new Error("Слишком большой аудиофрагмент.");
  const form = new FormData();
  form.append("file", blob, "chunk.wav");
  form.append("model", MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append(
    "provider",
    JSON.stringify({
      options: {
        elevenlabs: {
          diarize,
          tag_audio_events: true,
          timestamps_granularity: "word",
        },
      },
    }),
  );
  let response;
  try {
    response = await fetch(API_BASE + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
  } catch {
    throw Object.assign(
      new Error(
        "Запрос прервался. Проверьте списание в RouterAI перед повтором.",
      ),
      { unknown: true },
    );
  }
  if (!response.ok) {
    const known =
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 409].includes(response.status);
    throw Object.assign(
      new Error(
        {
          401: "Проверьте ключ RouterAI.",
          402: "Недостаточно средств или превышен лимит ключа.",
          403: "Нет доступа к модели.",
          429: "Лимит запросов. Продолжите позже.",
        }[response.status] || `Ошибка API ${response.status}.`,
      ),
      { unknown: !known, rejected: known },
    );
  }
  try {
    const data = await response.json();
    if (typeof data.text !== "string") throw new Error();
    return { data, generation_id: response.headers.get("X-Generation-Id") };
  } catch {
    throw Object.assign(
      new Error(
        "Не удалось прочитать ответ API. Проверьте запрос перед повтором.",
      ),
      { unknown: true },
    );
  }
}
async function run({ id, file, apiKey, acknowledge = false, diarize = true }) {
  let input,
    job = await getJob(id),
    sending = null;
  try {
    if (job.status === "unknown" && !acknowledge)
      throw new Error("Сначала подтвердите повтор неподтверждённого запроса.");
    if (file) {
      job.status = "preparing";
      job.error = null;
      await putJob(job);
      send(job);
      const audio = await openAudio(file);
      input = audio.input;
      job.duration = audio.duration;
      job.plan = planChunks(audio.duration);
      job.total = job.plan.length;
      await putJob(job);
    }
    if (!job.plan) throw new Error("Выберите исходный аудиофайл.");
    for (const part of job.plan) {
      let chunk = await getChunk(id, part.number);
      if (chunk?.response) continue;
      if (paused) {
        job.status = "paused";
        await putJob(job);
        send(job);
        return;
      }
      let blob = await getAudio(id, part.number);
      if (!blob) {
        if (!input) {
          job.status = "needs_file";
          job.error = "Выберите тот же аудиофайл, чтобы продолжить.";
          await putJob(job);
          send(job);
          return;
        }
        job.status = "preparing";
        job.current = part.number;
        await putJob(job);
        send(job);
        blob = await wavChunk(input, part, (progress) =>
          postMessage({ type: "progress", id, number: part.number, progress }),
        );
        await saveAudio(id, part.number, blob);
        chunk = { job: id, ...part, status: "prepared" };
        await putChunk(chunk);
      } else if (!chunk) {
        chunk = { job: id, ...part, status: "prepared" };
      }
      job.status = "transcribing";
      job.current = part.number;
      job.error = null;
      chunk.status = "sending";
      chunk.dispatched = Date.now();
      await commitChunk(job, chunk);
      sending = part.number;
      send(job);
      const result = await request(blob, apiKey, diarize);
      chunk.response = result.data;
      chunk.generation_id = result.generation_id;
      chunk.status = "done";
      chunk.segments = normalizeChunk(
        result.data,
        part,
        job.plan[part.number + 1],
      );
      const cost = result.data.usage?.cost;
      job.cost =
        Number.isFinite(cost) && (!job.done || Number.isFinite(job.cost))
          ? (job.cost || 0) + cost
          : null;
      job.done = (job.done || 0) + 1;
      job.segment_count = (job.segment_count || 0) + chunk.segments.length;
      job.status = "transcribing";
      await commitChunk(job, chunk);
      sending = null;
      send(job);
      await deleteAudio(id, part.number);
    }
    job.status = "complete";
    job.error = null;
    await putJob(job);
    send(job);
  } catch (error) {
    if (sending !== null) {
      error.unknown = error.unknown || !error.rejected;
      const chunk = await getChunk(id, sending);
      if (chunk && !chunk.response) {
        chunk.status = error.unknown ? "unknown" : "rejected";
        await putChunk(chunk);
      }
    }
    job.status = error.unknown ? "unknown" : "error";
    job.error =
      error.name === "QuotaExceededError"
        ? "Недостаточно места в хранилище браузера. Готовые результаты сохранены."
        : error.message;
    await putJob(job).catch(() => {});
    send(job);
  } finally {
    input?.dispose();
    apiKey = "";
    postMessage({ type: "finished", id });
  }
}
onmessage = (event) => {
  if (event.data.type === "pause") {
    paused = true;
    return;
  }
  if (event.data.type === "run") {
    paused = false;
    if (!navigator.locks) {
      postMessage({
        type: "failure",
        message:
          "Нужен современный Chrome, Edge или Safari с поддержкой Web Locks.",
      });
      return;
    }
    navigator.locks
      .request(
        "scribe-studio-processing",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            postMessage({
              type: "failure",
              message: "Обработка уже идёт в другой вкладке.",
            });
            return;
          }
          await run(event.data);
        },
      )
      .catch(() =>
        postMessage({
          type: "failure",
          message: "Не удалось начать обработку.",
        }),
      );
  }
};
