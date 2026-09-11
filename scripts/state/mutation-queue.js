export function mutationQueueKey(document, fallback = "active-document") {
  return document?.uuid ?? document?.id ?? fallback;
}

/** Serialize mutations by identity without allowing a rejected job to poison the queue. */
export async function runSerializedMutation(queue, key, operation) {
  if (!(queue instanceof Map)) throw new TypeError("Mutation queue requires a Map.");
  if (typeof operation !== "function") throw new TypeError("Mutation transaction requires a function.");
  const previous = queue.get(key) ?? Promise.resolve();
  const transaction = previous.catch(() => {}).then(operation);
  queue.set(key, transaction);
  try {
    return await transaction;
  } finally {
    if (queue.get(key) === transaction) queue.delete(key);
  }
}
