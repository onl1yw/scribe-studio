export const API_BASE = "https://routerai.ru/api/v1";
export const MODEL = "elevenlabs/scribe-v2";
export const STEP = 600,
  OVERLAP = 2,
  MAX_BYTES = 20 * 1024 ** 2;
export function planChunks(duration, step = STEP) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Не удалось определить длительность записи.");
  if (!Number.isInteger(step) || step < 1 || step > 600)
    throw new Error("Некорректная длина фрагмента.");
  return Array.from({ length: Math.ceil(duration / step) }, (_, number) => {
    const start = Math.max(0, number * step - (number ? OVERLAP : 0)),
      end = Math.min(duration, (number + 1) * step);
    return {
      number,
      start,
      end,
      duration: end - start,
      overlap_left: number ? Math.min(OVERLAP, number * step) : 0,
    };
  });
}
export function timestamp(seconds, subtitle = false) {
  const ms = Math.max(0, Math.round((seconds || 0) * 1000)),
    s = Math.floor(ms / 1000);
  return (
    [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
      .map((v) => String(v).padStart(2, "0"))
      .join(":") + (subtitle ? "," + String(ms % 1000).padStart(3, "0") : "")
  );
}
export function normalizeChunk(data, chunk, next) {
  const offset = chunk.start,
    left = offset + chunk.overlap_left / 2,
    right = next ? next.start + next.overlap_left / 2 : Infinity;
  const speakers = new Map(),
    label = (value) =>
      value == null
        ? null
        : speakers.has(String(value))
          ? speakers.get(String(value))
          : (speakers.set(String(value), speakers.size + 1), speakers.size);
  const output = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    output.push({
      start: group[0].start,
      end: group.at(-1).end,
      speaker: group[0].speaker,
      chunk: chunk.number + 1,
      timed: true,
      text: group
        .map((w) => w.text)
        .join(" ")
        .replace(/\s+([,.!?;:…])/g, "$1"),
    });
    group = [];
  };
  const words = (data.words || []).filter(
    (w) =>
      w.type !== "spacing" &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end),
  );
  for (const word of words) {
    const start = offset + word.start,
      end = offset + word.end,
      text = (word.word ?? word.text ?? "").trim();
    if (
      !text ||
      end < start ||
      (start + end) / 2 < left ||
      (start + end) / 2 >= right
    )
      continue;
    const speaker = label(word.speaker ?? word.speaker_id);
    if (
      group.length &&
      (speaker !== group[0].speaker ||
        start - group[0].start >= 25 ||
        start - group.at(-1).end >= 2)
    )
      flush();
    group.push({
      start: Math.max(0, start),
      end: Math.max(start, end),
      text,
      speaker,
    });
  }
  flush();
  if (!words.length)
    for (const segment of data.segments || []) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end))
        continue;
      const start = offset + segment.start,
        end = offset + segment.end;
      if (
        (start + end) / 2 >= left &&
        (start + end) / 2 < right &&
        segment.text?.trim()
      )
        output.push({
          start,
          end,
          text: segment.text.trim(),
          speaker: label(segment.speaker),
          chunk: chunk.number + 1,
          timed: true,
        });
    }
  if (!words.length && !output.length && data.text?.trim())
    output.push({
      start: offset,
      end: chunk.end,
      text: data.text.trim(),
      speaker: null,
      chunk: chunk.number + 1,
      timed: false,
    });
  return output;
}
export function trimRepeatedPhrase(previous, text) {
  const a = previous.match(/\S+/g) || [],
    b = [...text.matchAll(/\S+/g)],
    norm = (s) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let n = Math.min(32, a.length, b.length); n >= 3; n--)
    if (
      a.slice(-n).map(norm).join("\0") ===
      b
        .slice(0, n)
        .map((v) => norm(v[0]))
        .join("\0")
    )
      return text.slice(b[n - 1].index + b[n - 1][0].length).trimStart();
  return text;
}
export function exportTexts(job, chunks) {
  let previous = "";
  const segments = [];
  for (const chunk of chunks)
    for (const original of chunk.segments || []) {
      const segment = { ...original };
      if (!segment.timed)
        segment.text = trimRepeatedPhrase(previous, segment.text);
      if (!segment.text) continue;
      previous = (previous + " " + segment.text).slice(-4000);
      segments.push(segment);
    }
  const txt = segments.map((s) => s.text).join("\n\n");
  const timed = segments
    .map(
      (s) =>
        `[${timestamp(s.start)}] ${job.total > 1 ? "Фрагмент " + s.chunk + " · " : ""}${s.speaker == null ? "" : "Говорящий " + s.speaker}\n${s.text}`,
    )
    .join("\n\n");
  const srt = segments
    .filter((s) => s.timed)
    .map(
      (s, i) =>
        `${i + 1}\n${timestamp(s.start, true)} --> ${timestamp(s.end, true)}\n${s.text}\n`,
    )
    .join("\n");
  return {
    txt,
    timed,
    srt,
    segments,
    json: JSON.stringify(
      {
        model: MODEL,
        filename: job.filename,
        duration: job.duration,
        cost_rub: job.cost,
        segments,
        chunks: chunks.map(({ response, ...c }) => ({ ...c, response })),
      },
      null,
      2,
    ),
  };
}
