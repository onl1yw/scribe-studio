export function concurrencyLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 10;
}

// Prepare one bounded audio file at a time while up to `limit` requests run.
// On pause/failure stop scheduling and drain every already-started request.
export async function runChunkPool(
  items,
  { limit, prepare, execute, shouldStop = () => false, onActive = () => {} },
) {
  const active = new Set(),
    errors = [];
  const stopped = () => errors.length > 0 || shouldStop();
  const launch = (value) => {
    const task = Promise.resolve()
      .then(() => execute(value))
      .catch((error) => {
        errors.push(error);
      })
      .finally(() => {
        active.delete(task);
        onActive(active.size);
      });
    active.add(task);
    onActive(active.size);
  };
  for (const item of items) {
    while (active.size >= concurrencyLimit(limit) && !stopped())
      await Promise.race(active);
    if (stopped()) break;
    let value;
    try {
      value = await prepare(item);
    } catch (error) {
      errors.push(error);
      break;
    }
    if (stopped()) break;
    if (value != null) launch(value);
  }
  await Promise.all(active);
  return { errors, paused: shouldStop() };
}
