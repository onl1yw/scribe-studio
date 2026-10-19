import {
  API_BASE,
  MODEL,
  planChunks,
  normalizeChunk,
  MAX_BYTES,
} from "./core.js?v=20261019b";
import {
  getJob,
  patchJob,
  getChunk,
  putChunk,
  saveAudio,
  getAudio,
  deleteAudio,
  markSending,
  completeChunk,
  hasPendingRequests,
} from "./db.js?v=20261019b";
import { openAudio, wavChunk } from "./audio.js?v=20261019b";
import { runChunkPool, concurrencyLimit } from "./pool.js?v=20261019b";
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
  const concurrency = 10;
  let input,
    active = 0,
    failed = false,
    job = await getJob(id);
  try {
    if (
      (job.status === "unknown" || (await hasPendingRequests(id))) &&
      !acknowledge
    )
      throw Object.assign(
        new Error("Сначала подтвердите повтор неподтверждённых запросов."),
        { unknown: true },
      );
    send(
      await patchJob(id, {
        status: "preparing",
        error: null,
        concurrency: concurrencyLimit(concurrency),
      }),
    );
    if (file) {
      const audio = await openAudio(file);
      input = audio.input;
      const plan = planChunks(audio.duration);
      job = await patchJob(id, {
        duration: audio.duration,
        plan,
        total: plan.length,
      });
    }
    if (!job.plan)
      throw Object.assign(new Error("Выберите исходный аудиофайл."), {
        needsFile: true,
      });
    const result = await runChunkPool(job.plan, {
      limit: concurrency,
      shouldStop: () => paused || failed,
      onActive: (count) => {
        active = count;
        postMessage({ type: "active", id, count });
      },
      prepare: async (part) => {
        let chunk = await getChunk(id, part.number);
        if (chunk?.response) return null;
        let blob = await getAudio(id, part.number);
        if (!blob) {
          if (!input)
            throw Object.assign(
              new Error("Выберите тот же аудиофайл, чтобы продолжить."),
              { needsFile: true },
            );
          send(
            await patchJob(id, {
              status: active ? "transcribing" : "preparing",
              current: part.number,
            }),
          );
          blob = await wavChunk(input, part, (progress) =>
            postMessage({
              type: "progress",
              id,
              number: part.number,
              progress,
              active,
            }),
          );
          await saveAudio(id, part.number, blob);
          chunk = { job: id, ...part, status: "prepared" };
          await putChunk(chunk);
        }
        return {
          part,
          blob,
          chunk: chunk || { job: id, ...part, status: "prepared" },
        };
      },
      execute: async ({ part, blob, chunk }) => {
        let dispatched = false;
        try {
          send(await markSending(chunk));
          if (paused || failed) {
            await putChunk({ ...chunk, status: "prepared" });
            return;
          }
          dispatched = true;
          const result = await request(blob, apiKey, diarize);
          const completed = {
            ...chunk,
            response: result.data,
            generation_id: result.generation_id,
            status: "done",
            segments: normalizeChunk(
              result.data,
              part,
              job.plan[part.number + 1],
            ),
          };
          send(await completeChunk(completed));
          dispatched = false;
          await deleteAudio(id, part.number);
        } catch (error) {
          failed = true;
          if (dispatched) {
            error.unknown = !!error.unknown || !error.rejected;
            const latest = await getChunk(id, part.number);
            if (latest && !latest.response) {
              latest.status = error.unknown ? "unknown" : "rejected";
              await putChunk(latest);
            }
          }
          throw error;
        }
      },
    });
    const error =
      result.errors.find((error) => error.unknown) || result.errors[0];
    if (error) throw error;
    job = await getJob(id);
    send(
      await patchJob(id, {
        status: job.done === job.total ? "complete" : "paused",
        error: null,
      }),
    );
  } catch (error) {
    const status = error.unknown
      ? "unknown"
      : error.needsFile
        ? "needs_file"
        : "error";
    const message =
      error.name === "QuotaExceededError"
        ? "Недостаточно места в хранилище браузера. Готовые результаты сохранены."
        : error.message;
    const saved = await patchJob(id, { status, error: message }).catch(
      () => null,
    );
    if (saved) send(saved);
    else postMessage({ type: "failure", message });
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
