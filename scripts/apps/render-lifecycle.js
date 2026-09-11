/** Shared AppV1/AppV2 cleanup for live Foundry hooks and DOM listeners. */
export class RenderLifecycle {
  constructor(owner) {
    this.owner = owner;
    this.hooks = [];
    this.listeners = [];
  }

  watchHooks(names, callback) {
    if (this.hooks.length) return callback;
    for (const name of names) {
      Hooks.on(name, callback);
      this.hooks.push([name, callback]);
    }
    return callback;
  }

  listen(target, eventName, callback, options) {
    if (!target?.addEventListener) return false;
    target.addEventListener(eventName, callback, options);
    this.listeners.push([target, eventName, callback, options]);
    return true;
  }

  clearDomListeners() {
    for (const [target, eventName, callback, options] of this.listeners) {
      target.removeEventListener?.(eventName, callback, options);
    }
    this.listeners = [];
  }

  beginRender() {
    this.clearDomListeners();
  }

  close() {
    this.clearDomListeners();
    for (const [name, callback] of this.hooks) Hooks.off(name, callback);
    this.hooks = [];
  }
}
