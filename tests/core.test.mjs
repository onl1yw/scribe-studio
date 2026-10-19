import test from "node:test";
import assert from "node:assert/strict";
import {
  planChunks,
  normalizeChunk,
  trimRepeatedPhrase,
  exportTexts,
  timestamp,
  MAX_BYTES,
} from "../dist/core.js";
import { Input, BlobSource, ALL_FORMATS } from "../dist/vendor/mediabunny.mjs";
import { wavChunk } from "../dist/audio.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("long recordings have bounded request sizes and contiguous ownership", () => {
  const plan = planChunks(100 * 3600);
  assert.equal(plan.length, 600);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    assert.ok(p.duration * 32000 + 500 < MAX_BYTES);
    assert.ok(p.start >= 0);
    if (i)
      assert.equal(
        p.start + p.overlap_left / 2,
        plan[i - 1].end - p.overlap_left / 2,
      );
  }
});
test("word timestamps become global; speakers stay scoped to a chunk", () => {
  const p = planChunks(1200),
    data = {
      text: "До стыка после",
      words: [
        { word: "До", start: 0.1, end: 0.4, speaker: 9 },
        { word: "стыка", start: 1.1, end: 1.5, speaker: 9 },
        { word: "после", start: 2.1, end: 2.4, speaker: 3 },
      ],
    };
  const result = normalizeChunk(data, p[1]);
  assert.equal(result[0].start, 599.1);
  assert.equal(result[0].speaker, 1);
  assert.equal(result[1].speaker, 2);
  assert.equal(result[1].chunk, 2);
});
test("plain fallback is explicit and deduplicates exact overlap phrases", () => {
  const p = planChunks(3),
    s = normalizeChunk({ text: "Без меток" }, p[0]);
  assert.equal(s[0].timed, false);
  assert.equal(
    trimRepeatedPhrase("Это важная мысль", "Это важная мысль и продолжение"),
    "и продолжение",
  );
  assert.equal(trimRepeatedPhrase("да да", "да снова"), "да снова");
  const out = exportTexts({ filename: "test", total: 1 }, [
    { ...p[0], response: { text: "Без меток" }, segments: s },
  ]);
  assert.equal(out.txt, "Без меток");
  assert.ok(out.json.includes("Без меток"));
});
test("subtitles preserve millisecond precision", () =>
  assert.equal(timestamp(3661.234, true), "01:01:01,234"));
test("real browser-side conversion code creates a standalone bounded WAV", async () => {
  const folder = await mkdtemp(join(tmpdir(), "scribe-static-"));
  let input;
  try {
    const bytes = Buffer.alloc(44 + 16000 * 2 * 3);
    bytes.write("RIFF");
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const path = join(folder, "source.wav");
    await writeFile(path, bytes);
    input = new Input({
      source: new BlobSource(new Blob([bytes])),
      formats: ALL_FORMATS,
    });
    const blob = await wavChunk(input, planChunks(3)[0]);
    const result = Buffer.from(await blob.arrayBuffer());
    assert.equal(result.toString("ascii", 0, 4), "RIFF");
    assert.ok(result.length < MAX_BYTES);
    assert.ok(result.length >= 16000 * 2 * 3);
  } finally {
    input?.dispose();
    await rm(folder, { recursive: true, force: true });
  }
});

test("out-of-order parallel responses assemble into one chronological file", () => {
  const plan = planChunks(1800),
    texts = ["Первая часть.", "Вторая часть.", "Третья часть."];
  const chunks = plan.map((part) => ({
    ...part,
    response: { text: texts[part.number] },
    segments: normalizeChunk(
      {
        text: texts[part.number],
        words: [{ word: texts[part.number], start: 10, end: 11 }],
      },
      part,
      plan[part.number + 1],
    ),
  }));
  const output = exportTexts({ filename: "session.wav", total: 3 }, [
    chunks[2],
    chunks[0],
    chunks[1],
  ]);
  assert.equal(output.txt, texts.join("\n\n"));
  assert.deepEqual(
    JSON.parse(output.json).chunks.map((c) => c.number),
    [0, 1, 2],
  );
  assert.ok(
    output.srt.indexOf("00:00:10,000") < output.srt.indexOf("00:10:08,000"),
  );
  assert.ok(
    output.srt.indexOf("00:10:08,000") < output.srt.indexOf("00:20:08,000"),
  );
});
