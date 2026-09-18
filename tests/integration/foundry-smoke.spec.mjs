import { expect, test } from "@playwright/test";

const adapterId = process.env.SHIPCOMBAT_ADAPTER;
const adapterModuleId = `causodes-shipcombat-${adapterId}`;
const playerName = "Ship Combat Integration Player";
const playerPassword = "ship-combat-integration-player";
const expectedSystemVersions = { dnd5e: "5.3.3", sf2e: "1.4.1", impmal: "4.0.0" };
const expectedFoundryVersion = process.env.FOUNDRY_VERSION ?? "14.367";
const worldId = `shipcombat-integration-${adapterId}`;
const adminKey = process.env.FOUNDRY_ADMIN_KEY;
const logPrefix = `[foundry-integration:${adapterId}]`;

if (!new Set(["dnd5e", "sf2e", "impmal"]).has(adapterId)) {
  throw new Error(`Unsupported SHIPCOMBAT_ADAPTER: ${adapterId}`);
}

function log(message) {
  console.log(`${logPrefix} ${message}`);
}

async function phase(name, callback) {
  const startedAt = Date.now();
  log(`START ${name}`);
  return test.step(name, async () => {
    try {
      const result = await callback();
      log(`PASS  ${name} (${Date.now() - startedAt}ms)`);
      return result;
    } catch (error) {
      log(`FAIL  ${name} (${Date.now() - startedAt}ms): ${error?.message ?? error}`);
      throw error;
    }
  });
}

async function waitForGame(page) {
  log(`Waiting for /game from ${page.url()}`);
  await page.waitForURL(/\/game(?:$|[?#])/);
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 90_000 });
  log(`Foundry game ready at ${page.url()}`);
}

async function ensureWorldActive(page) {
  log("Checking whether the prepared world is already active");
  await page.goto("/join");
  if (/\/game(?:$|[?#])/.test(page.url())) return waitForGame(page);
  if (await page.locator("#join-username, #join-game-user, select[name='userid']").isVisible()) {
    log("Prepared world is already active");
    return;
  }

  log("No active world; checking the Foundry license state");
  await page.goto("/license");
  const eula = page.locator("#eula-agree");
  const eulaVisible = await eula.waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (eulaVisible) {
    log("Accepting the Foundry EULA under the license owner's explicit authorization");
    await eula.check();
    await page.locator("#sign, button[data-action='accept']").click();
    await page.waitForURL(/\/(?:setup|auth)(?:$|[?#])/);
    log(`Foundry EULA accepted; redirected to ${page.url()}`);
  } else if (/\/license(?:$|[?#])/.test(page.url())) {
    const body = await page.locator("body").innerText();
    throw new Error(`Foundry license page did not expose the EULA form: ${body.replace(/\s+/g, " ").trim().slice(0, 1_000)}`);
  }

  if (!/\/(?:setup|auth)(?:$|[?#])/.test(page.url())) await page.goto("/setup");
  if (/\/auth(?:$|[?#])/.test(page.url())) {
    if (!adminKey) throw new Error("FOUNDRY_ADMIN_KEY is required to launch the prepared world");
    log("Authenticating to the Foundry Setup screen");
    await page.locator("#auth-password, input[name='adminPassword']").fill(adminKey);
    await page.locator("button[value='adminAuth']").click();
    await page.waitForURL(/\/setup(?:$|[?#])/);
  }

  const tourOverlay = page.locator(".tour-overlay");
  const tourVisible = await tourOverlay.waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (tourVisible) {
    log("Dismissing the blocking Foundry Setup tour");
    await page.locator(".tour .step-button[data-action='exit']").first().click({ timeout: 5_000 });
    await tourOverlay.waitFor({ state: "detached", timeout: 5_000 });
  }

  const worldsTab = page.locator("#setup-packages nav.tabs [data-tab='worlds']");
  await worldsTab.waitFor({ state: "visible", timeout: 10_000 });
  if (!await worldsTab.evaluate(element => element.classList.contains("active"))) {
    log("Opening the Game Worlds tab");
    await worldsTab.click({ timeout: 5_000 });
  }

  log(`Launching prepared world ${worldId}`);
  const worldTile = page.locator(`#worlds-list .world[data-package-id="${worldId}"]`);
  await worldTile.waitFor({ state: "visible", timeout: 30_000 });
  const launchButton = worldTile.locator("[data-action='worldLaunch']");
  await worldTile.hover({ timeout: 10_000 });
  await launchButton.waitFor({ state: "visible", timeout: 5_000 });
  log(`Clicking the launch control for ${worldId}`);
  await launchButton.click({ timeout: 10_000 });
  log(`Launch control clicked; waiting for ${worldId} to start`);
  await page.waitForURL(/\/(?:join|game)(?:$|[?#])/, { timeout: 90_000 });
  log(`Prepared world launch completed at ${page.url()}`);
}

async function joinWorld(page, username, password = "") {
  log(`Navigating to /join as ${username}`);
  await page.goto("/join");
  log(`Landed on ${page.url()}`);
  if (/\/game(?:$|[?#])/.test(page.url())) return waitForGame(page);

  const userField = page.locator("#join-username, #join-game-user, select[name='userid']");
  try {
    await userField.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const title = await page.title().catch(() => "<unavailable>");
    const body = await page.locator("body").innerText({ timeout: 2_000 })
      .then(text => text.replace(/\s+/g, " ").trim().slice(0, 1_000))
      .catch(() => "<unavailable>");
    throw new Error(`Foundry join form unavailable at ${page.url()} (title: ${title}; body: ${body})`, { cause: error });
  }

  if (await userField.evaluate(element => element.tagName === "SELECT")) {
    await userField.selectOption({ label: username });
  } else {
    log(`Selecting ${username} from the Foundry user autocomplete`);
    await userField.click();
    await page.locator("#autocomplete li").getByText(username, { exact: true }).click({ timeout: 5_000 });
  }
  log(`Selected Foundry user ${username}`);
  await page.locator("#join-password, #join-game-password, input[name='password']").fill(password);
  log(`Submitting the join form as ${username}`);
  await page.locator('button[name="join"]').click();
  await waitForGame(page);
}

function collectModuleErrors(page) {
  const errors = [];
  page.on("pageerror", error => {
    const detail = error.stack ?? error.message;
    errors.push(detail);
    log(`BROWSER PAGE ERROR: ${detail}`);
  });
  page.on("console", message => {
    if (message.type() === "error" && /causodes-shipcombat/i.test(message.text())) {
      errors.push(message.text());
      log(`BROWSER CONSOLE ERROR: ${message.text()}`);
    }
  });
  return errors;
}

test("exercises Foundry-only document, application, canvas, combat, and socket boundaries", async ({ browser, page }) => {
  const gmErrors = collectModuleErrors(page);
  await phase("accept the license and launch the prepared world", () => ensureWorldActive(page));
  await phase("join the active world as Gamemaster", () => joinWorld(page, "Gamemaster"));

  const requiresWarhammerLibrary = adapterId === "impmal";
  const activation = await phase("activate Core, adapter, and dependencies", () => page.evaluate(async ({ adapterModuleId, requiresWarhammerLibrary }) => {
    const current = game.settings.get("core", "moduleConfiguration") ?? {};
    const required = ["socketlib", "causodes-shipcombat-core", adapterModuleId];
    if (requiresWarhammerLibrary) required.unshift("warhammer-lib");
    if (required.every(id => current[id] === true)) return false;
    await game.settings.set("core", "moduleConfiguration", {
      ...current,
      ...Object.fromEntries(required.map(id => [id, true])),
    });
    return true;
  }, { adapterModuleId, requiresWarhammerLibrary }));

  if (activation) {
    await phase("reload after module activation", async () => {
      await page.reload();
      await waitForGame(page);
    });
  }

  await phase("verify Foundry, system, module, and adapter versions", () => expect.poll(() => page.evaluate(({ adapterModuleId }) => ({
    foundry: game.release.version,
    systemId: game.system.id,
    systemVersion: game.system.version,
    core: game.modules.get("causodes-shipcombat-core")?.active,
    adapter: game.modules.get(adapterModuleId)?.active,
    socketlib: game.modules.get("socketlib")?.active,
    configuredAdapter: globalThis.ShipCombat?._api?.SystemAdapter?.current?.moduleId,
  }), { adapterModuleId })).toEqual({
    foundry: expectedFoundryVersion,
    systemId: adapterId,
    systemVersion: expectedSystemVersions[adapterId],
    core: true,
    adapter: true,
    socketlib: true,
    configuredAdapter: adapterModuleId,
  }));

  const fixture = await phase("create player, NPC, ordnance, component, scene, and token fixtures", () => page.evaluate(async ({ adapterModuleId, playerName, playerPassword }) => {
    const fixtureNames = [
      "Ship Combat Integration Ship",
      "Ship Combat Integration NPC",
      "Ship Combat Integration Ordnance",
    ];
    const existingActors = game.actors.filter(actor => fixtureNames.includes(actor.name));
    if (existingActors.length) await Actor.deleteDocuments(existingActors.map(actor => actor.id));
    const existingScene = game.scenes.getName("Ship Combat Integration Scene");
    if (existingScene) await existingScene.delete();
    const existingPlayer = game.users.find(user => user.name === playerName);
    if (existingPlayer) await existingPlayer.delete();

    const player = await User.create({
      name: playerName,
      password: playerPassword,
      role: CONST.USER_ROLES.PLAYER,
    });
    const actor = await Actor.create({
      name: "Ship Combat Integration Ship",
      type: `${adapterModuleId}.ship`,
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    const npcActor = await Actor.create({
      name: "Ship Combat Integration NPC",
      type: `${adapterModuleId}.npcShip`,
    });
    const ordnanceActor = await Actor.create({
      name: "Ship Combat Integration Ordnance",
      type: `${adapterModuleId}.shipOrdnance`,
      system: { subtype: "torpedo" },
    });
    const [component] = await actor.createEmbeddedDocuments("Item", [{
      name: "Ship Combat Integration Engine",
      type: `${adapterModuleId}.component`,
      system: { slot: "engine", speed: 7, maneuverability: 2 },
    }]);
    await actor.update({ "system.roles": { [player.id]: "ordnance" } });

    const torpedoTemplate = ordnanceActor.toObject();
    delete torpedoTemplate._id;
    torpedoTemplate.name = "NPC Integration Torpedo";
    torpedoTemplate.system.subtype = "torpedo";
    torpedoTemplate.system.hull = { value: 0, max: 2 };
    torpedoTemplate.system.fuel = { value: 5, max: 5 };
    const craftTemplate = foundry.utils.deepClone(torpedoTemplate);
    craftTemplate.name = "NPC Integration Strike Craft";
    craftTemplate.system.subtype = "strikeCraft";
    craftTemplate.system.hull = { value: 0, max: 3 };
    await actor.update({
      "system.ordnanceActors": {
        torpedo: [{ id: "integration-player-torpedo", name: torpedoTemplate.name, actorData: torpedoTemplate }],
        strikeCraft: [{ id: "integration-player-craft", name: craftTemplate.name, actorData: craftTemplate }],
      },
    });
    await npcActor.update({
      "system.ordnanceActors": {
        torpedo: [{ id: "integration-npc-torpedo", name: torpedoTemplate.name, actorData: torpedoTemplate }],
        strikeCraft: [{ id: "integration-npc-craft", name: craftTemplate.name, actorData: craftTemplate }],
      },
    });

    const scene = await Scene.create({
      name: "Ship Combat Integration Scene",
      navigation: false,
      width: 3_000,
      height: 2_000,
      grid: { type: CONST.GRID_TYPES.SQUARE, size: 100, distance: 1, units: "sq" },
    });
    const tokenData = await Promise.all([
      actor.getTokenDocument({ x: 300, y: 400, hidden: false }),
      npcActor.getTokenDocument({ x: 1_300, y: 400 }),
      ordnanceActor.getTokenDocument({ x: 800, y: 900, hidden: false }),
    ]);
    const [shipToken, npcToken, ordnanceToken] = await scene.createEmbeddedDocuments(
      "Token",
      tokenData.map(token => token.toObject()),
    );

    const sheet = actor.sheet;
    const useV1 = globalThis.ShipCombat._api.SystemAdapter.current.useApplicationV1;
    await sheet.render(useV1 ? true : { force: true });

    return {
      actorId: actor.id,
      npcActorId: npcActor.id,
      ordnanceActorId: ordnanceActor.id,
      componentId: component.id,
      sceneId: scene.id,
      shipTokenId: shipToken.id,
      npcTokenId: npcToken.id,
      ordnanceTokenId: ordnanceToken.id,
      playerId: player.id,
      useV1,
    };
  }, { adapterModuleId, playerName, playerPassword }));

  await phase("verify real data models, prototype defaults, and embedded document persistence", async () => {
    const boundaryState = await page.evaluate(async ({ actorId, npcActorId, ordnanceActorId, componentId }) => {
      const { SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const npc = game.actors.get(npcActorId);
      const ordnance = game.actors.get(ordnanceActorId);
      const component = actor.items.get(componentId);
      await component.update({ name: "Ship Combat Integration Engine Updated" });
      await ordnance.update({ [SystemAdapter.current.systemPath("payloadCount")]: 4 });
      return {
        modelClasses: [actor, npc, ordnance, component].map(document => document.system?.constructor?.name),
        shipPrototype: {
          disposition: actor.prototypeToken.disposition,
          actorLink: actor.prototypeToken.actorLink,
          lockRotation: actor.prototypeToken.lockRotation,
        },
        npcPrototype: {
          disposition: npc.prototypeToken.disposition,
          actorLink: npc.prototypeToken.actorLink,
          lockRotation: npc.prototypeToken.lockRotation,
        },
        ordnancePrototype: {
          disposition: ordnance.prototypeToken.disposition,
          actorLink: ordnance.prototypeToken.actorLink,
          lockRotation: ordnance.prototypeToken.lockRotation,
        },
        hullDisplayMode: SystemAdapter.current.hullDisplayMode,
        ordnanceHull: SystemAdapter.current.getShipData(ordnance).hull,
        componentName: actor.items.get(componentId)?.name,
        componentParentId: actor.items.get(componentId)?.parent?.id,
        componentImg: actor.items.get(componentId)?.img,
      };
    }, fixture);

    expect(boundaryState.modelClasses.every(name => name && name !== "Object")).toBe(true);
    expect(boundaryState.shipPrototype).toEqual({
      disposition: 1,
      actorLink: true,
      lockRotation: false,
    });
    expect(boundaryState.npcPrototype).toEqual({
      disposition: -1,
      actorLink: false,
      lockRotation: false,
    });
    expect(boundaryState.ordnancePrototype).toEqual({
      disposition: 0,
      actorLink: false,
      lockRotation: false,
    });
    expect(boundaryState.ordnanceHull).toEqual({
      value: boundaryState.hullDisplayMode === "hpRemaining" ? 4 : 0,
      max: 4,
    });
    expect(boundaryState.componentName).toBe("Ship Combat Integration Engine Updated");
    expect(boundaryState.componentParentId).toBe(fixture.actorId);
    expect(boundaryState.componentImg).toEqual(expect.any(String));
    expect(boundaryState.componentImg.length).toBeGreaterThan(0);
  });

  await phase("verify the initial AppV1/AppV2 ship sheet render", async () => {
    expect(fixture.useV1).toBe(adapterId === "sf2e");
    await expect.poll(() => page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      const element = sheet.element?.[0] ?? sheet.element;
      return sheet.rendered && element?.isConnected === true;
    }, fixture.actorId)).toBe(true);
    await page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      globalThis.__shipCombatFirstSheetElement = sheet.element?.[0] ?? sheet.element;
    }, fixture.actorId);
  });

  await phase("close the ship sheet and detach its DOM", async () => {
    await page.evaluate(async actorId => game.actors.get(actorId).sheet.close(), fixture.actorId);
    await expect.poll(() => page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      return !sheet.rendered && globalThis.__shipCombatFirstSheetElement?.isConnected === false;
    }, fixture.actorId)).toBe(true);
  });

  await phase("rerender with a fresh DOM and close the replacement sheet", async () => {
    await page.evaluate(async actorId => {
      const sheet = game.actors.get(actorId).sheet;
      const useV1 = globalThis.ShipCombat._api.SystemAdapter.current.useApplicationV1;
      await sheet.render(useV1 ? true : { force: true });
    }, fixture.actorId);
    await expect.poll(() => page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      const element = sheet.element?.[0] ?? sheet.element;
      return sheet.rendered
        && element?.isConnected === true
        && element !== globalThis.__shipCombatFirstSheetElement
        && globalThis.__shipCombatFirstSheetElement?.isConnected === false;
    }, fixture.actorId)).toBe(true);
    await page.evaluate(actorId => game.actors.get(actorId).sheet.close(), fixture.actorId);
  });

  await phase("render and close the NPC, ordnance, and component sheets", async () => {
    const rendered = await page.evaluate(async ({ actorId, npcActorId, ordnanceActorId, componentId }) => {
      const actor = game.actors.get(actorId);
      const documents = [
        game.actors.get(npcActorId),
        game.actors.get(ordnanceActorId),
        actor.items.get(componentId),
      ];
      const results = [];
      for (const document of documents) {
        const sheet = document.sheet;
        const isV1 = sheet instanceof foundry.appv1.api.Application;
        await sheet.render(isV1 ? true : { force: true });
        await new Promise(resolve => {
          const check = () => {
            const element = sheet.element?.[0] ?? sheet.element;
            if (sheet.rendered && element?.isConnected) resolve();
            else setTimeout(check, 25);
          };
          check();
        });
        const element = sheet.element?.[0] ?? sheet.element;
        results.push({
          type: document.type,
          isV1,
          connected: element?.isConnected === true,
          hasRenderedBox: (element?.getClientRects?.().length ?? 0) > 0,
        });
        await sheet.close();
        if (element?.isConnected) throw new Error(`${document.type} sheet left stale DOM attached after close`);
      }
      return results;
    }, fixture);
    expect(rendered).toHaveLength(3);
    expect(rendered.every(result => result.connected && result.hasRenderedBox)).toBe(true);
  });

  await phase("activate the scene and let real canvasReady hooks reconcile token state", async () => {
    await page.evaluate(async sceneId => {
      const scene = game.scenes.get(sceneId);
      await scene.activate();
      await scene.view();
    }, fixture.sceneId);
    await expect.poll(() => page.evaluate(sceneId => canvas?.ready && canvas.scene?.id === sceneId, fixture.sceneId)).toBe(true);
    await expect.poll(() => page.evaluate(({ sceneId, npcTokenId }) => {
      const token = game.scenes.get(sceneId)?.tokens.get(npcTokenId);
      return { actorLink: token?.actorLink, hidden: token?.hidden };
    }, fixture)).toEqual({ actorLink: true, hidden: true });
  });

  const playerOrdnance = await phase("spawn both player-ship ordnance subtypes through the production workflow", () => page.evaluate(async ({
    shipTokenId,
  }) => {
    const { ShipCombatState } = globalThis.ShipCombat._api;
    const torpedo = await ShipCombatState.spawnOrdnance({
      type: "torpedo",
      templateId: "integration-player-torpedo",
      parentShipTokenId: shipTokenId,
      x: 550,
      y: 650,
      rotation: 0,
      forcedHull: 2,
    });
    const strikeCraft = await ShipCombatState.spawnOrdnance({
      type: "strikeCraft",
      templateId: "integration-player-craft",
      parentShipTokenId: shipTokenId,
      x: 700,
      y: 650,
      rotation: 0,
      forcedHull: 3,
    });
    if (!torpedo?.ok || !strikeCraft?.ok) {
      throw new Error(`Player ordnance spawn failed: ${JSON.stringify({ torpedo, strikeCraft })}`);
    }
    return {
      torpedo: { actorId: torpedo.actorId, tokenId: torpedo.tokenIds[0] },
      strikeCraft: { actorId: strikeCraft.actorId, tokenId: strikeCraft.tokenIds[0] },
    };
  }, fixture));

  await phase("open the NPC ordnance tab with real AppV1/AppV2 listeners", async () => {
    await page.evaluate(async npcActorId => {
      const sheet = game.actors.get(npcActorId).sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      await sheet.render(isV1 ? true : { force: true });
    }, fixture.npcActorId);
    const ordnanceTab = page.locator(
      'nav [data-tab="ordnance"], .tabs [data-tab="ordnance"], [data-action="tab"][data-tab="ordnance"]',
    ).filter({ visible: true }).last();
    await expect(ordnanceTab).toBeVisible();
    await ordnanceTab.click();
    await expect(page.locator('[data-action="npcLaunchTorpedo"]')).toBeVisible();
    await expect(page.locator('[data-action="npcLaunchStrikeCraft"]')).toBeVisible();
  });

  const npcTorpedoActorIdsBefore = await page.evaluate(moduleId => game.actors
    .filter(actor => actor.getFlag(moduleId, "fromOrdnanceMaster"))
    .map(actor => actor.id), adapterModuleId);
  await phase("launch an NPC torpedo through its rendered sheet and side dialog", async () => {
    await page.locator('[data-action="npcLaunchTorpedo"]').click();
    await expect(page.locator('button[data-action="port"]')).toBeVisible();
    await page.locator('button[data-action="port"]').click();
    await expect.poll(() => page.evaluate(({ moduleId, previousIds }) => {
      return game.actors.filter(actor => (
        actor.getFlag(moduleId, "fromOrdnanceMaster")
        && actor.system.subtype === "torpedo"
        && !previousIds.includes(actor.id)
      )).length;
    }, { moduleId: adapterModuleId, previousIds: npcTorpedoActorIdsBefore })).toBe(1);
  });

  const npcCraftActorIdsBefore = await page.evaluate(moduleId => game.actors
    .filter(actor => actor.getFlag(moduleId, "fromOrdnanceMaster"))
    .map(actor => actor.id), adapterModuleId);
  await phase("launch NPC strike craft through the same live UI path", async () => {
    await page.locator('[data-action="npcLaunchStrikeCraft"]').click();
    await expect(page.locator('button[data-action="starboard"]')).toBeVisible();
    await page.locator('button[data-action="starboard"]').click();
    await expect.poll(() => page.evaluate(({ moduleId, previousIds }) => {
      return game.actors.filter(actor => (
        actor.getFlag(moduleId, "fromOrdnanceMaster")
        && actor.system.subtype === "strikeCraft"
        && !previousIds.includes(actor.id)
      )).length;
    }, { moduleId: adapterModuleId, previousIds: npcCraftActorIdsBefore })).toBe(1);
  });

  const npcOrdnance = await phase("identify NPC launches and close their parent sheet", () => page.evaluate(async ({
    moduleId, npcActorId, npcTokenId,
  }) => {
    const generated = game.actors.filter(actor => (
      actor.getFlag(moduleId, "fromOrdnanceMaster")
      && actor.system.parentShipTokenId === npcTokenId
    ));
    const result = Object.fromEntries(generated.map(actor => {
      const token = actor.getActiveTokens()[0];
      return [actor.system.subtype, { actorId: actor.id, tokenId: token?.id }];
    }));
    await game.actors.get(npcActorId).sheet.close();
    return result;
  }, { ...fixture, moduleId: adapterModuleId }));
  fixture.ordnanceMatrix = {
    playerTorpedo: playerOrdnance.torpedo,
    playerStrikeCraft: playerOrdnance.strikeCraft,
    npcTorpedo: npcOrdnance.torpedo,
    npcStrikeCraft: npcOrdnance.strikeCraft,
  };

  await phase("verify the complete parent-by-subtype ordnance matrix", async () => {
    const matrix = await page.evaluate(({ shipTokenId, npcTokenId, playerId, ordnanceMatrix }) => {
      const { resolveOrdnanceParentShipActor } = globalThis.ShipCombat._api;
      return Object.fromEntries(Object.entries(ordnanceMatrix).map(([key, ids]) => {
        const sourceActor = game.actors.get(ids.actorId);
        const token = canvas.scene.tokens.get(ids.tokenId);
        const actor = token.actor;
        return [key, {
          subtype: actor.system.subtype,
          parentTokenId: actor.system.parentShipTokenId,
          resolvedParentId: resolveOrdnanceParentShipActor(actor)?.id,
          playerOwner: actor.testUserPermission(game.users.get(playerId), "OWNER"),
          unlinkedSyntheticActor: token.actorLink === false && actor !== sourceActor,
          disposition: token.disposition,
          width: token.width,
          height: token.height,
          turnComplete: actor.system.turnComplete,
          launchDriftPending: actor.system.launchDriftPending,
          expectedPlayerParent: actor.system.parentShipTokenId === shipTokenId,
          expectedNpcParent: actor.system.parentShipTokenId === npcTokenId,
        }];
      }));
    }, fixture);
    expect(matrix.playerTorpedo).toEqual({
      subtype: "torpedo",
      parentTokenId: fixture.shipTokenId,
      resolvedParentId: fixture.actorId,
      playerOwner: true,
      unlinkedSyntheticActor: true,
      disposition: 0,
      width: 0.5,
      height: 0.5,
      turnComplete: true,
      launchDriftPending: true,
      expectedPlayerParent: true,
      expectedNpcParent: false,
    });
    expect(matrix.playerStrikeCraft).toEqual({
      subtype: "strikeCraft",
      parentTokenId: fixture.shipTokenId,
      resolvedParentId: fixture.actorId,
      playerOwner: true,
      unlinkedSyntheticActor: true,
      disposition: 0,
      width: 0.5,
      height: 0.5,
      turnComplete: false,
      launchDriftPending: false,
      expectedPlayerParent: true,
      expectedNpcParent: false,
    });
    expect(matrix.npcTorpedo).toEqual({
      subtype: "torpedo",
      parentTokenId: fixture.npcTokenId,
      resolvedParentId: fixture.npcActorId,
      playerOwner: false,
      unlinkedSyntheticActor: true,
      disposition: -1,
      width: 0.5,
      height: 0.5,
      turnComplete: true,
      launchDriftPending: true,
      expectedPlayerParent: false,
      expectedNpcParent: true,
    });
    expect(matrix.npcStrikeCraft).toEqual({
      subtype: "strikeCraft",
      parentTokenId: fixture.npcTokenId,
      resolvedParentId: fixture.npcActorId,
      playerOwner: false,
      unlinkedSyntheticActor: true,
      disposition: -1,
      width: 0.5,
      height: 0.5,
      turnComplete: false,
      launchDriftPending: false,
      expectedPlayerParent: false,
      expectedNpcParent: true,
    });
  });

  await phase("verify token persistence and seed every target-reference shape", async () => {
    const tokenState = await page.evaluate(async ({ actorId, sceneId, shipTokenId, npcTokenId }) => {
      const scene = game.scenes.get(sceneId);
      const npcToken = scene.tokens.get(npcTokenId);
      await npcToken.update({ x: npcToken.x + 100, hidden: false });
      const actor = game.actors.get(actorId);
      await globalThis.ShipCombat._api.ShipCombatState.forShip(actor).update({
        "resources.sensors.recommendedTargetId": npcTokenId,
        "resources.captain.priorityTargetId": npcTokenId,
        "resources.sensors.fireCorrection": { targetTokenId: npcTokenId, type: "accuracy" },
        "resources.sensors.contacts": { [npcTokenId]: { tier: 2, realName: npcToken.name } },
        "resources.sensors.locks": [{ targetTokenId: npcTokenId, tier: 2, decayRounds: 3 }],
        "resources.sensors.effects": [{ actionId: "integration", targetTokenId: npcTokenId, roundsRemaining: 1 }],
        "resources.sensors.bdaAttacks": { integration: { targetTokenId: npcTokenId, status: "pending" } },
      });
      const data = globalThis.ShipCombat._api.SystemAdapter.current.getShipData(actor);
      return {
        canvasTokenIds: canvas.tokens.placeables.map(token => token.id),
        shipLinked: scene.tokens.get(shipTokenId)?.actorLink,
        npcLinked: scene.tokens.get(npcTokenId)?.actorLink,
        npcX: scene.tokens.get(npcTokenId)?.x,
        references: {
          recommended: data.resources.sensors.recommendedTargetId,
          priority: data.resources.captain.priorityTargetId,
          contact: Object.hasOwn(data.resources.sensors.contacts, npcTokenId),
          lock: data.resources.sensors.locks.some(lock => lock.targetTokenId === npcTokenId),
          effect: data.resources.sensors.effects.some(effect => effect.targetTokenId === npcTokenId),
          correction: data.resources.sensors.fireCorrection?.targetTokenId,
          bda: data.resources.sensors.bdaAttacks.integration?.targetTokenId,
        },
      };
    }, fixture);
    expect(tokenState.canvasTokenIds).toEqual(expect.arrayContaining([
      fixture.shipTokenId,
      fixture.npcTokenId,
      fixture.ordnanceTokenId,
    ]));
    expect(tokenState.shipLinked).toBe(true);
    expect(tokenState.npcLinked).toBe(true);
    expect(tokenState.npcX).toBe(1_400);
    expect(tokenState.references).toEqual({
      recommended: fixture.npcTokenId,
      priority: fixture.npcTokenId,
      contact: true,
      lock: true,
      effect: true,
      correction: fixture.npcTokenId,
      bda: fixture.npcTokenId,
    });
  });

  await phase("render a real popup and replace stale DOM on a token-driven rerender", async () => {
    await page.evaluate(async ({ actorId, npcTokenId, useV1 }) => {
      const modulePath = useV1
        ? "/modules/causodes-shipcombat-core/scripts/apps/BattleClarityPopupV1.js"
        : "/modules/causodes-shipcombat-core/scripts/apps/BattleClarityPopup.js";
      const popupModule = await import(modulePath);
      const PopupClass = useV1 ? popupModule.BattleClarityPopupV1 : popupModule.BattleClarityPopup;
      const app = new PopupClass({ shipActor: game.actors.get(actorId) });
      globalThis.__shipCombatIntegrationPopup = app;
      await app.render(useV1 ? true : { force: true });
      const findTarget = () => {
        const element = app.element?.[0] ?? app.element;
        return element?.querySelector(`[data-token-id="${npcTokenId}"]`);
      };
      await new Promise(resolve => {
        const check = () => findTarget() ? resolve() : setTimeout(check, 25);
        check();
      });
      globalThis.__shipCombatPopupTarget = findTarget();
    }, fixture);

    await page.evaluate(({ sceneId, npcTokenId }) => {
      const token = game.scenes.get(sceneId).tokens.get(npcTokenId);
      return token.update({ x: token.x + 100 });
    }, fixture);
    await expect.poll(() => page.evaluate(npcTokenId => {
      const app = globalThis.__shipCombatIntegrationPopup;
      const root = app?.element?.[0] ?? app?.element;
      const freshTarget = root?.querySelector(`[data-token-id="${npcTokenId}"]`);
      return app?.rendered
        && freshTarget?.isConnected === true
        && freshTarget !== globalThis.__shipCombatPopupTarget
        && globalThis.__shipCombatPopupTarget?.isConnected === false;
    }, fixture.npcTokenId)).toBe(true);
  });

  await phase("close the popup and prove its live hooks cannot resurrect stale UI", async () => {
    await page.evaluate(async ({ sceneId, npcTokenId }) => {
      const app = globalThis.__shipCombatIntegrationPopup;
      await app.close();
      const token = game.scenes.get(sceneId).tokens.get(npcTokenId);
      await token.update({ x: token.x + 100 });
      await new Promise(resolve => setTimeout(resolve, 300));
    }, fixture);
    expect(await page.evaluate(() => {
      const app = globalThis.__shipCombatIntegrationPopup;
      const root = app?.element?.[0] ?? app?.element;
      return !app?.rendered && !root?.isConnected && globalThis.__shipCombatPopupTarget?.isConnected === false;
    })).toBe(true);
  });

  const combatFixture = await phase("start real combat with player and NPC combatants", () => page.evaluate(async ({
    actorId, npcActorId, sceneId, shipTokenId, npcTokenId,
  }) => {
    const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
    const ship = game.actors.get(actorId);
    const npc = game.actors.get(npcActorId);
    const hpRemaining = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    await ShipCombatState.forShip(ship).update({
      "hull.max": 20,
      "hull.value": hpRemaining ? 20 : 0,
      internalFire: 2,
      "resources.pilot.fuelBurned": 25,
      "resources.pilot.bearing": 45,
      "resources.pilot.prevTurnMove": 0,
    });
    await npc.update({
      "system.hull.max": 20,
      "system.hull.value": hpRemaining ? 20 : 0,
      "system.internalFire": 2,
      "system.voidshieldFlux": 3,
      "system.voidshieldFluxRemaining": 0,
      [SystemAdapter.current.systemPath("resources.pilot.fuelBurned")]: 25,
      [SystemAdapter.current.systemPath("resources.pilot.bearing")]: 45,
      [SystemAdapter.current.systemPath("resources.pilot.prevTurnMove")]: 0,
    });
    const combat = await Combat.create({
      scene: sceneId,
      active: true,
      combatants: [
        { actorId, tokenId: shipTokenId, sceneId, initiative: 20 },
        { actorId: npcActorId, tokenId: npcTokenId, sceneId, initiative: 10 },
      ],
    });
    await combat.startCombat();
    return { combatId: combat.id, hpRemaining };
  }, fixture));

  await phase("verify player turn-start hooks and duplicate-delivery idempotency", async () => {
    const expectedHull = combatFixture.hpRemaining ? 18 : 2;
    await expect.poll(() => page.evaluate(({ actorId, combatId }) => {
      const { SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const data = SystemAdapter.current.getShipData(actor);
      return {
        currentActorId: game.combats.get(combatId)?.combatant?.actorId,
        hull: data.hull.value,
        fuelBurned: data.resources.pilot.fuelBurned,
        bearing: data.resources.pilot.bearing,
      };
    }, { ...fixture, ...combatFixture })).toEqual({
      currentActorId: fixture.actorId,
      hull: expectedHull,
      fuelBurned: 0,
      bearing: 0,
    });

    await page.evaluate(combatId => {
      const combat = game.combats.get(combatId);
      const changes = { round: combat.round, turn: combat.turn };
      const options = { direction: 0 };
      Hooks.callAll("updateCombat", combat, changes, options, game.user.id);
      Hooks.callAll("updateCombat", combat, changes, options, game.user.id);
    }, combatFixture.combatId);
    await expect.poll(() => page.evaluate(actorId => (
      globalThis.ShipCombat._api.SystemAdapter.current.getShipData(game.actors.get(actorId)).hull.value
    ), fixture.actorId)).toBe(expectedHull);
  });

  await phase("advance into the NPC turn and verify its real lifecycle updates", async () => {
    await page.evaluate(async ({ combatId, ordnanceMatrix }) => {
      await canvas.scene.tokens.get(ordnanceMatrix.playerTorpedo.tokenId).actor.update({
        "system.turnComplete": true,
        "system.launchDriftPending": true,
        "system.fuel.value": 5,
      });
      await canvas.scene.tokens.get(ordnanceMatrix.playerStrikeCraft.tokenId).actor.update({
        "system.turnComplete": true,
        "system.fuel.value": 5,
      });
      await game.combats.get(combatId).nextTurn();
    }, { ...fixture, ...combatFixture });
    const expectedHull = combatFixture.hpRemaining ? 18 : 2;
    await expect.poll(() => page.evaluate(({ npcActorId, combatId, ordnanceMatrix }) => {
      const npc = game.actors.get(npcActorId);
      const data = npc.system;
      const playerTorpedo = canvas.scene.tokens.get(ordnanceMatrix.playerTorpedo.tokenId)?.actor?.system;
      const playerCraft = canvas.scene.tokens.get(ordnanceMatrix.playerStrikeCraft.tokenId)?.actor?.system;
      return {
        currentActorId: game.combats.get(combatId)?.combatant?.actorId,
        hull: data.hull.value,
        flux: data.voidshieldFluxRemaining,
        fuelBurned: data.resources.pilot.fuelBurned,
        bearing: data.resources.pilot.bearing,
        playerTorpedoTurnComplete: playerTorpedo?.turnComplete,
        playerTorpedoLaunchDriftPending: playerTorpedo?.launchDriftPending,
        playerCraftTurnComplete: playerCraft?.turnComplete,
      };
    }, { ...fixture, ...combatFixture })).toEqual({
      currentActorId: fixture.npcActorId,
      hull: expectedHull,
      flux: 3,
      fuelBurned: 0,
      bearing: 0,
      playerTorpedoTurnComplete: false,
      playerTorpedoLaunchDriftPending: false,
      playerCraftTurnComplete: false,
    });
  });

  await phase("advance out of the NPC turn and process both NPC ordnance subtypes", async () => {
    await page.evaluate(combatId => game.combats.get(combatId).nextTurn(), combatFixture.combatId);
    await expect.poll(() => page.evaluate(({ actorId, combatId, ordnanceMatrix }) => {
      const npcTorpedo = canvas.scene.tokens.get(ordnanceMatrix.npcTorpedo.tokenId)?.actor?.system;
      const npcCraft = canvas.scene.tokens.get(ordnanceMatrix.npcStrikeCraft.tokenId)?.actor?.system;
      return {
        currentActorId: game.combats.get(combatId)?.combatant?.actorId,
        npcTorpedoTurnComplete: npcTorpedo?.turnComplete,
        npcTorpedoLaunchDriftPending: npcTorpedo?.launchDriftPending,
        npcCraftTurnComplete: npcCraft?.turnComplete,
      };
    }, { ...fixture, ...combatFixture })).toEqual({
      currentActorId: fixture.actorId,
      npcTorpedoTurnComplete: false,
      npcTorpedoLaunchDriftPending: false,
      npcCraftTurnComplete: false,
    });
  });

  await phase("delete target and generated-ordnance tokens and verify hook cleanup", async () => {
    await page.evaluate(async ({ combatId, moduleId, sceneId, npcTokenId, ordnanceTokenId, ordnanceActorId }) => {
      await game.combats.get(combatId)?.delete();
      const ordnance = game.actors.get(ordnanceActorId);
      await ordnance.setFlag(moduleId, "fromOrdnanceMaster", true);
      await game.scenes.get(sceneId).deleteEmbeddedDocuments("Token", [npcTokenId, ordnanceTokenId]);
    }, { ...fixture, ...combatFixture, moduleId: adapterModuleId });
    await expect.poll(() => page.evaluate(({ actorId, npcTokenId, ordnanceActorId }) => {
      const data = globalThis.ShipCombat._api.SystemAdapter.current.getShipData(game.actors.get(actorId));
      const sensors = data.resources.sensors;
      return {
        ordnanceDeleted: !game.actors.has(ordnanceActorId),
        recommended: sensors.recommendedTargetId ?? null,
        priority: data.resources.captain.priorityTargetId ?? null,
        correction: sensors.fireCorrection ?? null,
        contact: Object.hasOwn(sensors.contacts ?? {}, npcTokenId),
        lock: (sensors.locks ?? []).some(entry => entry.targetTokenId === npcTokenId),
        effect: (sensors.effects ?? []).some(entry => entry.targetTokenId === npcTokenId),
        bda: Object.values(sensors.bdaAttacks ?? {}).some(entry => entry.targetTokenId === npcTokenId),
      };
    }, fixture)).toEqual({
      ordnanceDeleted: true,
      recommended: null,
      priority: null,
      correction: null,
      contact: false,
      lock: false,
      effect: false,
      bda: false,
    });
  });

  await phase("stop the GM canvas before starting the player client", () => page.evaluate(async () => {
    if (canvas?.ready) await canvas.tearDown();
  }));

  const { playerContext, playerPage, playerErrors } = await phase("join a second browser session as the owning player", async () => {
    const playerContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await playerContext.addInitScript(() => localStorage.setItem("core.noCanvas", "true"));
    const playerPage = await playerContext.newPage();
    const playerErrors = collectModuleErrors(playerPage);
    await joinWorld(playerPage, playerName, playerPassword);
    return { playerContext, playerPage, playerErrors };
  });

  await phase("verify isolated player ownership across ships and all ordnance paths", async () => {
    const result = await playerPage.evaluate(async ({ actorId, npcActorId, sceneId, ordnanceMatrix }) => {
      const ship = game.actors.get(actorId);
      const npc = game.actors.get(npcActorId);
      const scene = game.scenes.get(sceneId);
      const requestForNpc = globalThis.ShipCombat._api.createActionRequester(() => npc);
      return {
        shipOwner: ship.isOwner,
        npcOwner: npc.isOwner,
        playerTorpedoSourceOwner: game.actors.get(ordnanceMatrix.playerTorpedo.actorId)?.isOwner,
        playerCraftSourceOwner: game.actors.get(ordnanceMatrix.playerStrikeCraft.actorId)?.isOwner,
        playerTorpedoTokenOwner: scene.tokens.get(ordnanceMatrix.playerTorpedo.tokenId)?.actor?.isOwner,
        playerCraftTokenOwner: scene.tokens.get(ordnanceMatrix.playerStrikeCraft.tokenId)?.actor?.isOwner,
        npcTorpedoSourceOwner: game.actors.get(ordnanceMatrix.npcTorpedo.actorId)?.isOwner,
        npcCraftSourceOwner: game.actors.get(ordnanceMatrix.npcStrikeCraft.actorId)?.isOwner,
        npcTorpedoTokenOwner: scene.tokens.get(ordnanceMatrix.npcTorpedo.tokenId)?.actor?.isOwner,
        npcCraftTokenOwner: scene.tokens.get(ordnanceMatrix.npcStrikeCraft.tokenId)?.actor?.isOwner,
        npcResult: await requestForNpc(null, "adjustResources", {
          requestId: "integration-reject-npc-as-player-ship",
          adjustments: [{ roleId: "engineer", key: "auxiliaryPower", delta: 99 }],
        }),
      };
    }, fixture);
    expect(result).toEqual({
      shipOwner: true,
      npcOwner: false,
      playerTorpedoSourceOwner: true,
      playerCraftSourceOwner: true,
      playerTorpedoTokenOwner: true,
      playerCraftTokenOwner: true,
      npcTorpedoSourceOwner: false,
      npcCraftSourceOwner: false,
      npcTorpedoTokenOwner: false,
      npcCraftTokenOwner: false,
      npcResult: false,
    });
  });

  const results = await phase("send a duplicated player-to-GM resource request", () => playerPage.evaluate(async actorId => {
    const actor = game.actors.get(actorId);
    const requestGM = globalThis.ShipCombat._api.createActionRequester(() => actor);
    const payload = {
      requestId: "integration-duplicate-request",
      adjustments: [{ roleId: "engineer", key: "auxiliaryPower", delta: 1 }],
    };
    return Promise.race([
      Promise.all([
        requestGM(null, "adjustResources", payload),
        requestGM(null, "adjustResources", payload),
      ]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Duplicated player-to-GM request did not resolve within 30 seconds")),
        30_000,
      )),
    ]);
  }, fixture.actorId));

  await phase("verify duplicate delivery committed exactly once", async () => {
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    await expect.poll(() => page.evaluate(actorId => {
      const actor = game.actors.get(actorId);
      return globalThis.ShipCombat._api.SystemAdapter.current
        .getShipData(actor)?.resources?.engineer?.auxiliaryPower;
    }, fixture.actorId)).toBe(1);
  });

  await phase("verify GM document updates replicate into the isolated player client", async () => {
    await page.evaluate(actorId => game.actors.get(actorId).update({ name: "Ship Combat Integration Ship Replicated" }), fixture.actorId);
    await expect.poll(() => playerPage.evaluate(actorId => game.actors.get(actorId)?.name, fixture.actorId))
      .toBe("Ship Combat Integration Ship Replicated");
  });

  await phase("close the player session and verify module error capture", async () => {
    await playerContext.close();
    expect(gmErrors).toEqual([]);
    expect(playerErrors).toEqual([]);
  });

  await phase("delete integration fixtures", () => page.evaluate(async ({
    actorId, npcActorId, ordnanceActorId, ordnanceMatrix, sceneId, playerId,
  }) => {
    await game.scenes.get(sceneId)?.delete();
    const generatedIds = Object.values(ordnanceMatrix).map(entry => entry.actorId);
    const actorIds = [actorId, npcActorId, ordnanceActorId, ...generatedIds]
      .filter(id => game.actors.has(id));
    if (actorIds.length) await Actor.deleteDocuments(actorIds);
    await game.users.get(playerId)?.delete();
  }, fixture));
});
