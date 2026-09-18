function setProperty(target, path, value) {
  const parts = String(path).split(".");
  const last = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part] ??= {};
  cursor[last] = value;
}

/** Minimal Foundry Document double that records and applies persistent writes. */
export class RecordingDocument {
  constructor(data = {}) {
    Object.assign(this, structuredClone(data));
    this.updates = [];
    this.failNextUpdate = null;
    this.failNextDelete = null;
    this.deleted = false;
  }

  async update(changes) {
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = null;
      throw error;
    }
    const copy = structuredClone(changes);
    this.updates.push(copy);
    for (const [path, value] of Object.entries(copy)) setProperty(this, path, value);
    return this;
  }

  getFlag(scope, key) {
    return this.flags?.[scope]?.[key];
  }

  async setFlag(scope, key, value) {
    return this.update({ [`flags.${scope}.${key}`]: value });
  }

  async delete() {
    if (this.failNextDelete) {
      const error = this.failNextDelete;
      this.failNextDelete = null;
      throw error;
    }
    this.deleted = true;
    return this;
  }
}

/** Install the smallest GM/Scene surface used by authoritative state handlers. */
export function installFoundryStateHarness(tokenDocuments = []) {
  const tokens = new Map(tokenDocuments.map(token => [token.id, token]));
  globalThis.game = { user: { isGM: true } };
  globalThis.canvas = { scene: { tokens } };
  return { tokens };
}
