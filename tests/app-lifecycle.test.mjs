import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const callbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const entries = callbacks.get(name) ?? new Set();
    entries.add(callback);
    callbacks.set(name, entries);
    return callback;
  },
  off(name, callback) {
    callbacks.get(name)?.delete(callback);
  },
  call(name, ...args) {
    for (const callback of callbacks.get(name) ?? []) callback(...args);
  },
};

const { RenderLifecycle } = await import("../scripts/apps/render-lifecycle.js");

class FakeElement {
  handlers = new Map();
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  removeEventListener(name, callback) {
    if (this.handlers.get(name) === callback) this.handlers.delete(name);
  }
  dispatch(name) { this.handlers.get(name)?.({ preventDefault() {} }); }
}

test("AppV1/AppV2 hook registration is stable across rerenders and removed on close", () => {
  const owner = { rendered: true, renders: 0, render() { this.renders += 1; } };
  const lifecycle = new RenderLifecycle(owner);
  const rerender = () => { if (owner.rendered) owner.render(); };
  lifecycle.watchHooks(["updateActor", "updateToken"], rerender);
  lifecycle.watchHooks(["updateActor", "updateToken"], rerender);

  assert.equal(callbacks.get("updateActor").size, 1);
  Hooks.call("updateActor");
  assert.equal(owner.renders, 1);
  owner.rendered = false;
  Hooks.call("updateToken");
  assert.equal(owner.renders, 1, "closed applications ignore late hook delivery");

  lifecycle.close();
  assert.equal(callbacks.get("updateActor").size, 0);
  assert.equal(callbacks.get("updateToken").size, 0);
});

test("rerender detaches stale DOM listeners before attaching the replacement", () => {
  const lifecycle = new RenderLifecycle({});
  const stale = new FakeElement();
  const current = new FakeElement();
  let clicks = 0;
  lifecycle.listen(stale, "click", () => { clicks += 1; });
  stale.dispatch("click");
  lifecycle.beginRender();
  lifecycle.listen(current, "click", () => { clicks += 1; });
  stale.dispatch("click");
  current.dispatch("click");
  assert.equal(clicks, 2);
  lifecycle.close();
  current.dispatch("click");
  assert.equal(clicks, 2);
});

test("representative AppV1 and AppV2 popups share the lifecycle implementation", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const filename of ["BattleClarityPopup.js", "BattleClarityPopupV1.js"]) {
    const source = fs.readFileSync(path.join(root, "scripts/apps", filename), "utf8");
    assert.match(source, /new RenderLifecycle\(this\)/);
    assert.match(source, /this\._lifecycle\.close\(\)/);
  }
});

test("every popup live-hook registration has a matching close-time removal", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const appRoot = path.join(root, "scripts/apps");
  for (const filename of fs.readdirSync(appRoot).filter(name => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(appRoot, filename), "utf8");
    const registered = [...source.matchAll(/Hooks\.on\("([^"]+)"/g)].map(match => match[1]).sort();
    if (!registered.length || filename === "render-lifecycle.js") continue;
    const removed = [...source.matchAll(/Hooks\.off\("([^"]+)"/g)].map(match => match[1]).sort();
    assert.deepEqual(removed, registered, `${filename} leaks or mismatches a live hook`);
  }
});
