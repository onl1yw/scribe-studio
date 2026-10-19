import {
  Input,
  ALL_FORMATS,
  BlobSource,
  Output,
  BufferTarget,
  WavOutputFormat,
  Conversion,
} from "./vendor/mediabunny.mjs";
import { MAX_BYTES } from "./core.js";
export async function openAudio(file) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 8 * 1024 ** 2 }),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("В файле нет аудиодорожки.");
    if (!(await track.canDecode()))
      throw new Error(
        "Этот аудиокодек не поддерживается браузером. Попробуйте Chrome или Edge.",
      );
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Не удалось определить длительность записи.");
    return { input, duration };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
export async function wavChunk(input, chunk, onProgress = () => {}) {
  const target = new BufferTarget(),
    output = new Output({ format: new WavOutputFormat(), target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: { discard: true },
    audio: {
      codec: "pcm-s16",
      sampleRate: 16000,
      numberOfChannels: 1,
      forceTranscode: true,
    },
    trim: { start: chunk.start, end: chunk.end },
    copy: false,
    tags: {},
    showWarnings: false,
  });
  if (!conversion.isValid)
    throw new Error("Не удалось подготовить аудио в этом браузере.");
  conversion.onProgress = onProgress;
  await conversion.execute();
  if (!target.buffer || target.buffer.byteLength > MAX_BYTES)
    throw new Error("Фрагмент превысил безопасный размер запроса.");
  return new Blob([target.buffer], { type: "audio/wav" });
}
