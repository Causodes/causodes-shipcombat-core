import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const scenarioId = process.env.SHIPCOMBAT_SCENARIO ?? process.env.SHIPCOMBAT_ADAPTER;
const scenarios = {
  dnd5e: { adapterId: "dnd5e", systemId: "dnd5e", extraModules: [] },
  sf2e: { adapterId: "sf2e", systemId: "sf2e", extraModules: [] },
  "sf2e-anachronism": {
    adapterId: "sf2e",
    systemId: "pf2e",
    extraModules: ["sf2e-anachronism"],
  },
  impmal: { adapterId: "impmal", systemId: "impmal", extraModules: ["warhammer-lib"] },
};
const scenario = scenarios[scenarioId];
const adapterId = scenario?.adapterId;
const adapterModuleId = `causodes-shipcombat-${adapterId}`;
const playerName = "Ship Combat Integration Player";
const playerPassword = "ship-combat-integration-player";
const resolutionPath = process.env.PACKAGE_RESOLUTION_PATH;
if (!resolutionPath) throw new Error("PACKAGE_RESOLUTION_PATH is required for Foundry integration tests.");
const packageResolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
const expectedFoundryVersion = packageResolution.foundry.version;
const expectedSystemVersion = packageResolution.packages[scenario?.systemId]?.version;
const expectedDependencyVersions = Object.fromEntries(
  ["socketlib", ...(scenario?.extraModules ?? [])].map(id => [id, packageResolution.packages[id]?.version]),
);
if (packageResolution.scenarioId !== scenarioId) {
  throw new Error(`Package resolution is for ${packageResolution.scenarioId}, not ${scenarioId}.`);
}
if (process.env.FOUNDRY_VERSION && process.env.FOUNDRY_VERSION !== expectedFoundryVersion) {
  throw new Error(`Resolved Foundry ${expectedFoundryVersion} does not match FOUNDRY_VERSION ${process.env.FOUNDRY_VERSION}.`);
}
if (!expectedSystemVersion || Object.values(expectedDependencyVersions).some(version => !version)) {
  throw new Error(`Package resolution is incomplete for ${scenarioId}.`);
}
const worldId = `shipcombat-integration-${scenarioId}`;
const adminKey = process.env.FOUNDRY_ADMIN_KEY;
const logPrefix = `[foundry-integration:${scenarioId}]`;

if (!scenario) {
  throw new Error(`Unsupported SHIPCOMBAT_SCENARIO: ${scenarioId}`);
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

async function installAppRootResolver(page) {
  await page.evaluate(() => {
    globalThis.__shipCombatAppRoot = application => {
      const element = application?.element;
      if (typeof element?.querySelector === "function") return element;
      const indexed = element?.[0] ?? element?.get?.(0);
      return typeof indexed?.querySelector === "function" ? indexed : null;
    };
  });
}

test("exercises Foundry-only document, application, canvas, combat, and socket boundaries", async ({ browser, page }) => {
  const gmErrors = collectModuleErrors(page);
  await phase("accept the license and launch the prepared world", () => ensureWorldActive(page));
  await phase("join the active world as Gamemaster", () => joinWorld(page, "Gamemaster"));

  const activation = await phase("activate Core, adapter, and dependencies", () => page.evaluate(async ({ adapterModuleId, extraModules }) => {
    const current = game.settings.get("core", "moduleConfiguration") ?? {};
    const required = ["socketlib", "causodes-shipcombat-core", adapterModuleId];
    required.unshift(...extraModules);
    if (required.every(id => current[id] === true)) return false;
    await game.settings.set("core", "moduleConfiguration", {
      ...current,
      ...Object.fromEntries(required.map(id => [id, true])),
    });
    return true;
  }, { adapterModuleId, extraModules: scenario.extraModules }));

  if (activation) {
    await phase("reload after module activation", async () => {
      await page.reload();
      await waitForGame(page);
    });
  }

  await phase("install the cross-version application root resolver", () => installAppRootResolver(page));

  await phase("verify Foundry, system, module, and adapter versions", () => expect.poll(() => page.evaluate(({ adapterModuleId, extraModules }) => ({
    foundry: game.release.version,
    systemId: game.system.id,
    systemVersion: game.system.version,
    core: game.modules.get("causodes-shipcombat-core")?.active,
    adapter: game.modules.get(adapterModuleId)?.active,
    socketlib: game.modules.get("socketlib")?.active,
    extraModules: Object.fromEntries(extraModules.map(id => [id, game.modules.get(id)?.active])),
    dependencyVersions: Object.fromEntries(["socketlib", ...extraModules].map(id => [id, game.modules.get(id)?.version])),
    configuredAdapter: globalThis.ShipCombat?._api?.SystemAdapter?.current?.moduleId,
  }), { adapterModuleId, extraModules: scenario.extraModules })).toEqual({
    foundry: expectedFoundryVersion,
    systemId: scenario.systemId,
    systemVersion: expectedSystemVersion,
    core: true,
    adapter: true,
    socketlib: true,
    extraModules: Object.fromEntries(scenario.extraModules.map(id => [id, true])),
    dependencyVersions: expectedDependencyVersions,
    configuredAdapter: adapterModuleId,
  }));

  await phase("verify every shared localization token resolved after adapter startup", async () => {
    const unresolved = await page.evaluate(() => {
      const matches = [];
      const visit = (value, path = "") => {
        if (typeof value === "string") {
          if (/\{\{SHIPCOMBAT\.[\w.-]+\}\}/.test(value)) matches.push({ path, value });
          return;
        }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
      };
      visit(game.i18n.translations?.SHIPCOMBAT, "SHIPCOMBAT");
      return matches;
    });
    expect(unresolved).toEqual([]);
  });

  const fixture = await phase("create player, NPC, ordnance, component, scene, and token fixtures", () => page.evaluate(async ({ adapterModuleId, playerName, playerPassword }) => {
    const fixtureNames = [
      "Ship Combat Integration Ship",
      "Ship Combat Integration NPC",
      "Ship Combat Integration Ordnance",
      "Ship Combat Integration Crew",
    ];
    const fixtureItemNames = [
      "Ship Combat Integration World Weapon",
      "Ship Combat Integration World Engine",
    ];
    const existingActors = game.actors.filter(actor => fixtureNames.includes(actor.name));
    if (existingActors.length) await Actor.deleteDocuments(existingActors.map(actor => actor.id));
    const existingItems = game.items.filter(item => fixtureItemNames.includes(item.name));
    if (existingItems.length) await Item.deleteDocuments(existingItems.map(item => item.id));
    const existingScene = game.scenes.getName("Ship Combat Integration Scene");
    if (existingScene) await existingScene.delete();
    const existingPlayer = game.users.find(user => user.name === playerName);
    if (existingPlayer) await existingPlayer.delete();

    const player = await User.create({
      name: playerName,
      password: playerPassword,
      role: CONST.USER_ROLES.PLAYER,
    });
    const actorTypeRegistry = game.system.documentTypes?.Actor;
    const systemActorTypes = Array.isArray(actorTypeRegistry)
      ? actorTypeRegistry
      : actorTypeRegistry instanceof Set
        ? [...actorTypeRegistry]
        : Array.isArray(actorTypeRegistry?.types)
          ? actorTypeRegistry.types
          : actorTypeRegistry?.types instanceof Set
            ? [...actorTypeRegistry.types]
            : actorTypeRegistry && typeof actorTypeRegistry === "object"
              ? Object.keys(actorTypeRegistry)
              : [];
    const crewActorType = systemActorTypes.includes("character") ? "character" : systemActorTypes[0];
    if (!crewActorType) throw new Error(`${game.system.id} exposes no Actor type for the crew fixture`);
    const crewActor = await Actor.create({
      name: "Ship Combat Integration Crew",
      type: crewActorType,
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    await player.update({ character: crewActor.id });
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
    const createdComponents = await actor.createEmbeddedDocuments("Item", [
      {
        name: "Ship Combat Integration Engine",
        type: `${adapterModuleId}.component`,
        system: {
          slot: "engine", speed: 7, maneuverability: 2,
          acContributionEngine: 2, armourClassContribution: 2,
        },
      },
      {
        name: "Ship Combat Integration Armour",
        type: `${adapterModuleId}.component`,
        system: {
          slot: "armour", armourValues: { bow: 5, stern: 4, port: 3, starboard: 2 },
          acContributionArmor: 3, armourClassContribution: 3,
        },
      },
      {
        name: "Ship Combat Integration Reactor",
        type: `${adapterModuleId}.component`,
        system: {
          slot: "reactor", rating: 4, coreOutput: 4, shieldStrengthPerCore: 3,
          heatCapacity: 8, bankCapacity: 6, reserveMultiplier: 2,
        },
      },
      {
        name: "Ship Combat Integration Sensor",
        type: `${adapterModuleId}.component`,
        system: { slot: "sensor", rating: 7, bandSize: 2, autoScanRange: 10, maxRange: 20, apCostMultiplier: 0.5 },
      },
      {
        name: "Ship Combat Integration Weapons Bay",
        type: `${adapterModuleId}.component`,
        system: {
          slot: "weaponsBay", bayAmmoCapacity: 12, bayChargeCapacity: 9,
          bayManpower: 8, bayTorpedoCapacity: 5, bayMaxFlights: 3,
          bayStrikeCraftCapacity: 7,
        },
      },
    ]);
    const componentsByName = new Map(createdComponents.map(item => [item.name, item]));
    const component = componentsByName.get("Ship Combat Integration Engine");
    const armour = componentsByName.get("Ship Combat Integration Armour");
    const reactor = componentsByName.get("Ship Combat Integration Reactor");
    const sensor = componentsByName.get("Ship Combat Integration Sensor");
    const weaponsBay = componentsByName.get("Ship Combat Integration Weapons Bay");
    if ([component, armour, reactor, sensor, weaponsBay].some(item => !item)) {
      throw new Error("Bulk component creation did not return every named fixture document");
    }
    const worldWeapon = await Item.create({
      name: fixtureItemNames[0],
      type: `${adapterModuleId}.component`,
      system: { slot: "weapon", weaponPosition: "prow", range: 12, damage: "2d6" },
    });
    const worldEngine = await Item.create({
      name: fixtureItemNames[1],
      type: `${adapterModuleId}.component`,
      system: { slot: "engine", speed: 11, maneuverability: 6 },
    });
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
      actor.getTokenDocument({ name: "Ship Combat Integration Player Token", x: 300, y: 400, hidden: false }),
      npcActor.getTokenDocument({ name: "Ship Combat Integration NPC Token", x: 1_300, y: 400 }),
      npcActor.getTokenDocument({ name: "Ship Combat Integration Sibling NPC Token", x: 1_700, y: 400 }),
      ordnanceActor.getTokenDocument({ name: "Ship Combat Integration Ordnance Token", x: 800, y: 900, hidden: false }),
    ]);
    const createdTokens = await scene.createEmbeddedDocuments(
      "Token",
      tokenData.map(token => token.toObject()),
    );
    const tokensByName = new Map(createdTokens.map(token => [token.name, token]));
    const shipToken = tokensByName.get("Ship Combat Integration Player Token");
    const npcToken = tokensByName.get("Ship Combat Integration NPC Token");
    const siblingNpcToken = tokensByName.get("Ship Combat Integration Sibling NPC Token");
    const ordnanceToken = tokensByName.get("Ship Combat Integration Ordnance Token");
    if ([shipToken, npcToken, siblingNpcToken, ordnanceToken].some(token => !token)) {
      throw new Error("Bulk token creation did not return every named fixture document");
    }
    if (shipToken.actorId !== actor.id
      || npcToken.actorId !== npcActor.id
      || siblingNpcToken.actorId !== npcActor.id
      || ordnanceToken.actorId !== ordnanceActor.id) {
      throw new Error("Named token fixtures resolved to the wrong persisted Actors");
    }

    const sheet = actor.sheet;
    const useV1 = globalThis.ShipCombat._api.SystemAdapter.current.useApplicationV1;
    await sheet.render(useV1 ? true : { force: true });

    return {
      actorId: actor.id,
      crewActorId: crewActor.id,
      npcActorId: npcActor.id,
      ordnanceActorId: ordnanceActor.id,
      componentId: component.id,
      armourId: armour.id,
      reactorId: reactor.id,
      sensorId: sensor.id,
      weaponsBayId: weaponsBay.id,
      worldWeaponId: worldWeapon.id,
      worldEngineId: worldEngine.id,
      sceneId: scene.id,
      shipTokenId: shipToken.id,
      npcTokenId: npcToken.id,
      siblingNpcTokenId: siblingNpcToken.id,
      ordnanceTokenId: ordnanceToken.id,
      playerId: player.id,
      useV1,
    };
  }, { adapterModuleId, playerName, playerPassword }));

  await phase("verify real data models, prototype defaults, and embedded document persistence", async () => {
    const boundaryState = await page.evaluate(async ({ actorId, npcActorId, ordnanceActorId, componentId }) => {
      const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const npc = game.actors.get(npcActorId);
      const ordnance = game.actors.get(ordnanceActorId);
      const component = actor.items.get(componentId);
      await component.update({ name: "Ship Combat Integration Engine Updated" });
      await ordnance.update({ [SystemAdapter.current.systemPath("payloadCount")]: 4 });
      const installedData = SystemAdapter.current.getShipData(actor);
      const installedMovement = { ...installedData.movement };
      const installedArmour = { ...installedData.armour };
      const reactorStats = ShipCombatState.getReactorStats(actor);
      const sensorStats = ShipCombatState.getSensorStats(actor);
      const ordnanceBayStats = ShipCombatState.getOrdnanceBayStats(actor);
      await component.update({ "system.equipped": false });
      const unequippedMovement = { ...SystemAdapter.current.getShipData(actor).movement };
      await component.update({ "system.equipped": true });
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
        installedMovement,
        unequippedMovement,
        installedArmour,
        reactorStats,
        sensorStats,
        ordnanceBayStats,
        dndComponentAC: Number(installedData.attributes?.ac?.value ?? 0),
        sfComponentAC: Number(installedData.armorClass ?? 0),
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
    expect(boundaryState.installedMovement).toMatchObject({ speed: 7, maneuverability: 2 });
    expect(boundaryState.unequippedMovement).toMatchObject({ speed: 0, maneuverability: 0 });
    expect(boundaryState.installedArmour).toEqual({ bow: 5, stern: 4, port: 3, starboard: 2 });
    expect(boundaryState.reactorStats).toEqual({
      coreOutput: 4,
      shieldStrengthPerCore: 3,
      heatCapacity: 8,
      auxPowerCapacity: 6,
      reserveMultiplier: 2,
      ...(adapterId === "dnd5e" ? { overclockBaseDC: 10 } : {}),
    });
    expect(boundaryState.sensorStats).toEqual({
      rating: 7,
      bandSize: 2,
      autoScanRange: 10,
      maxRange: 20,
      apCostMultiplier: 0.5,
    });
    expect(boundaryState.ordnanceBayStats).toEqual({
      ammoCapacity: 12,
      chargeCapacity: 9,
      manpower: 8,
      torpedoCapacity: 5,
      maxFlights: 3,
      strikeCraftCapacity: 7,
    });
    if (adapterId === "dnd5e") expect(boundaryState.dndComponentAC).toBe(5);
    if (adapterId === "sf2e") expect(boundaryState.sfComponentAC).toBe(5);
  });

  await phase("verify the initial AppV1/AppV2 ship sheet render", async () => {
    expect(fixture.useV1).toBe(adapterId === "sf2e");
    await expect.poll(() => page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      const element = globalThis.__shipCombatAppRoot(sheet);
      return sheet.rendered && element?.isConnected === true;
    }, fixture.actorId)).toBe(true);
    const unresolvedSheetTokens = await page.evaluate(actorId => {
      const root = globalThis.__shipCombatAppRoot(game.actors.get(actorId).sheet);
      return [...(root?.textContent?.matchAll(/\{\{SHIPCOMBAT\.[\w.-]+\}\}/g) ?? [])]
        .map(match => match[0]);
    }, fixture.actorId);
    expect(unresolvedSheetTokens).toEqual([]);
    await page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      globalThis.__shipCombatFirstSheetElement = globalThis.__shipCombatAppRoot(sheet);
    }, fixture.actorId);
  });

  await phase("render committed, staged, and overclocked Power Cores in canonical order", async () => {
    await page.evaluate(async actorId => {
      const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const state = ShipCombatState.forShip(actor);
      await state.update({
        assignedCores: { captain: true, gunner: true },
        "shieldPool.committed": 1,
        "resources.engineer.committedAuxCores": 1,
        "resources.engineer.stagedCores": { sensors: true },
        "resources.engineer.stagedShieldCores": 1,
        "resources.engineer.stagedAuxCores": 1,
        "resources.engineer.powerCores": 1,
      });
      const sheet = actor.sheet;
      await sheet.render(SystemAdapter.current.useApplicationV1 ? true : { force: true });
    }, fixture.actorId);
    await expect.poll(() => page.evaluate(actorId => {
      const sheet = game.actors.get(actorId).sheet;
      const root = globalThis.__shipCombatAppRoot(sheet);
      return [...(root?.querySelectorAll(".shipcombat-core-pips [data-pip-state]") ?? [])]
        .map(element => element.dataset.pipState);
    }, fixture.actorId)).toEqual([
      "assigned", "assigned", "shield-committed", "aux-committed",
      "staged", "shield-staged", "aux-staged", "available",
    ]);
    await page.evaluate(async actorId => {
      const { ShipCombatState } = globalThis.ShipCombat._api;
      const state = ShipCombatState.forShip(game.actors.get(actorId));
      await state.update({
        assignedCores: {},
        "shieldPool.committed": 0,
        "resources.engineer.committedAuxCores": 0,
        "resources.engineer.stagedCores": {},
        "resources.engineer.stagedShieldCores": 0,
        "resources.engineer.stagedAuxCores": 0,
        "resources.engineer.powerCores": 0,
      });
    }, fixture.actorId);
  });

  await phase("assign bridge crew through the live AppV1/AppV2 actor-drop boundary", async () => {
    await page.evaluate(({ actorId, crewActorId }) => {
      const sheet = game.actors.get(actorId).sheet;
      const root = globalThis.__shipCombatAppRoot(sheet);
      const target = root?.querySelector('[data-role-drop="ordnance"]');
      if (!target) throw new Error("Rendered ship sheet has no Ordnance bridge-crew drop target");
      const transfer = new DataTransfer();
      transfer.setData("text/plain", JSON.stringify(game.actors.get(crewActorId).toDragData()));
      target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    }, fixture);
    await expect.poll(() => page.evaluate(({ actorId, playerId }) => (
      globalThis.ShipCombat._api.SystemAdapter.current
        .getShipData(game.actors.get(actorId)).roles?.[playerId]
    ), fixture)).toBe("ordnance");
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
      const element = globalThis.__shipCombatAppRoot(sheet);
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
            const element = globalThis.__shipCombatAppRoot(sheet);
            if (sheet.rendered && element?.isConnected) resolve();
            else setTimeout(check, 25);
          };
          check();
        });
        const element = globalThis.__shipCombatAppRoot(sheet);
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

  await phase("submit component edits through the real AppV1/AppV2 form", async () => {
    const result = await page.evaluate(async ({ actorId, componentId }) => {
      const actor = game.actors.get(actorId);
      const component = actor.items.get(componentId);
      const sheet = component.sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      await sheet.render(isV1 ? true : { force: true });
      const findInput = () => globalThis.__shipCombatAppRoot(sheet)
        ?.querySelector('input[name="system.speed"]');
      let input = findInput();
      if (!input) {
        const detailsTab = globalThis.__shipCombatAppRoot(sheet)
          ?.querySelector('[data-tab="details"]');
        detailsTab?.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        input = findInput();
      }
      if (!input) throw new Error("Rendered component sheet did not expose system.speed");
      input.value = "9";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.form?.requestSubmit?.();
      const deadline = Date.now() + 5_000;
      while (component.system.speed !== 9 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const persistedSpeed = component.system.speed;
      const derivedSpeed = globalThis.ShipCombat._api.SystemAdapter.current
        .getShipData(actor).movement.speed;
      await component.update({ "system.speed": 7 });
      await sheet.close();
      return { persistedSpeed, derivedSpeed };
    }, fixture);
    expect(result).toEqual({ persistedSpeed: 9, derivedSpeed: 9 });
  });

  await phase("exercise player and NPC component drop contracts with real documents", async () => {
    const result = await page.evaluate(async ({
      actorId, npcActorId, worldWeaponId, worldEngineId, useV1, adapterId,
    }) => {
      const playerActor = game.actors.get(actorId);
      const npcActor = game.actors.get(npcActorId);
      const weapon = game.items.get(worldWeaponId);
      const engine = game.items.get(worldEngineId);
      const eventFor = (slot, position = null) => ({
        preventDefault() {},
        target: {
          closest(selector) {
            return selector === "[data-component-slot]"
              ? { dataset: { componentSlot: slot, componentPosition: position } }
              : null;
          },
        },
      });
      const playerSheet = playerActor.sheet;
      const npcSheet = npcActor.sheet;
      const callPlayerDrop = async (item, event) => {
        if (useV1) return playerSheet._onDropItem(event, item.toDragData());
        if (adapterId === "dnd5e") return playerSheet._onDropItem(event, item);
        return playerSheet._onDropItem(item.toDragData(), event);
      };
      const callNpcDrop = async (item, event) => {
        if (useV1) return npcSheet._onDropItem(event, item.toDragData());
        if (adapterId === "dnd5e") return npcSheet._onDropItem(event, item);
        return npcSheet._onDropItem(item.toDragData(), event);
      };

      const npcBefore = npcActor.items.size;
      await callPlayerDrop(weapon, eventFor("weapon", "prow"));
      await callPlayerDrop(engine, eventFor("engine"));
      await callNpcDrop(engine, eventFor("weapon", "prow"));
      const npcAfterRejected = npcActor.items.size;
      await callNpcDrop(weapon, eventFor("weapon", "prow"));

      const playerWeapon = playerActor.items.find(item => item.name === weapon.name);
      const playerEngine = playerActor.items.find(item => item.name === engine.name);
      const npcWeapon = npcActor.items.find(item => item.name === weapon.name);
      return {
        playerWeapon: playerWeapon ? {
          slot: playerWeapon.system.slot,
          position: playerWeapon.system.weaponPosition,
          equipped: playerWeapon.system.equipped,
        } : null,
        overflowEngine: playerEngine ? {
          slot: playerEngine.system.slot,
          equipped: playerEngine.system.equipped,
        } : null,
        npcRejectedInvalid: npcAfterRejected === npcBefore,
        npcWeapon: npcWeapon ? {
          slot: npcWeapon.system.slot,
          position: npcWeapon.system.weaponPosition,
        } : null,
      };
    }, { ...fixture, adapterId });
    expect(result).toEqual({
      playerWeapon: { slot: "weapon", position: "prow", equipped: true },
      overflowEngine: { slot: "engine", equipped: false },
      npcRejectedInvalid: true,
      npcWeapon: { slot: "weapon", position: "prow" },
    });
  });

  await phase("edit weapon traits through the adapter component dialog", async () => {
    await page.evaluate(async actorId => {
      const actor = game.actors.get(actorId);
      const component = actor.items.find(item => item.name === "Ship Combat Integration World Weapon");
      if (!component) throw new Error("Dropped player weapon is missing");
      const sheet = component.sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      await sheet.render(isV1 ? true : { force: true });
    }, fixture.actorId);
    const componentRoot = page.locator(
      '.shipcombat-component:visible, .causodes-shipcombat-dnd5e.component:visible, .causodes-shipcombat-impmal:visible',
    ).last();
    const detailsTab = componentRoot.locator('[data-action="tab"][data-tab="details"], nav [data-tab="details"], .tabs [data-tab="details"]').first();
    if (await detailsTab.count()) await detailsTab.click();
    const editTraits = componentRoot.locator('[data-action="editWeaponTraits"]');
    await expect(editTraits).toBeVisible();
    await editTraits.click();

    const traitValue = page.locator('input[name="rend-value"]:visible').last();
    const traitEnabled = page.locator('input[name="rendEnabled"]:visible').last();
    await expect(traitValue).toBeVisible();
    await traitValue.fill("3");
    await traitEnabled.check();
    const traitForm = traitValue.locator("xpath=ancestor::form");
    const saveTraits = traitForm.locator('.wte-save, button[type="submit"], button[data-action="ok"]').last();
    await expect(saveTraits).toBeVisible();
    await saveTraits.click();
    await expect.poll(() => page.evaluate(actorId => {
      const component = game.actors.get(actorId).items
        .find(item => item.name === "Ship Combat Integration World Weapon");
      return {
        rend: component?.system?.traits?.rend,
        enabled: component?.system?.traits?.rendEnabled,
      };
    }, fixture.actorId)).toEqual({ rend: 3, enabled: true });
    await page.evaluate(async actorId => {
      const component = game.actors.get(actorId).items
        .find(item => item.name === "Ship Combat Integration World Weapon");
      await component?.sheet?.close();
    }, fixture.actorId);
  });

  await phase("unassign and delete a component through rendered ship controls", async () => {
    const result = await page.evaluate(async actorId => {
      const actor = game.actors.get(actorId);
      const component = actor.items.find(item => item.name === "Ship Combat Integration World Weapon");
      if (!component) throw new Error("Dropped player weapon is missing");
      const componentId = component.id;
      const sheet = actor.sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      const root = () => globalThis.__shipCombatAppRoot(sheet);
      const waitFor = async predicate => {
        const deadline = Date.now() + 5_000;
        while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (!predicate()) throw new Error("Timed out waiting for rendered component control state");
      };
      await sheet.render(isV1 ? true : { force: true });
      await waitFor(() => root()?.isConnected);
      root()?.querySelector('[data-action="tab"][data-tab="overview"], nav [data-tab="overview"], .tabs [data-tab="overview"]')?.click();
      await waitFor(() => root()?.querySelector(`[data-id="${componentId}"] [data-action="unassignWeapon"]`));
      root().querySelector(`[data-id="${componentId}"] [data-action="unassignWeapon"]`).click();
      await waitFor(() => actor.items.get(componentId)?.system.equipped === false);

      root()?.querySelector('[data-action="tab"][data-tab="config"], nav [data-tab="config"], .tabs [data-tab="config"]')?.click();
      await waitFor(() => root()?.querySelector(`[data-id="${componentId}"] [data-action="deleteEmbedded"]`));
      root().querySelector(`[data-id="${componentId}"] [data-action="deleteEmbedded"]`).click();
      await waitFor(() => !actor.items.has(componentId));
      await sheet.close();
      return { unassigned: true, deleted: !actor.items.has(componentId) };
    }, fixture.actorId);
    expect(result).toEqual({ unassigned: true, deleted: true });
  });

  await phase("activate the scene and let real canvasReady hooks reconcile token state", async () => {
    await page.evaluate(async sceneId => {
      const scene = game.scenes.get(sceneId);
      await scene.activate();
      await scene.view();
    }, fixture.sceneId);
    await expect.poll(() => page.evaluate(sceneId => canvas?.ready && canvas.scene?.id === sceneId, fixture.sceneId)).toBe(true);
    await expect.poll(() => page.evaluate(({ sceneId, npcTokenId, siblingNpcTokenId }) => {
      const scene = game.scenes.get(sceneId);
      const token = scene?.tokens.get(npcTokenId);
      const sibling = scene?.tokens.get(siblingNpcTokenId);
      return {
        actorLink: token?.actorLink,
        hidden: token?.hidden,
        siblingActorLink: sibling?.actorLink,
        siblingHidden: sibling?.hidden,
        actorId: token?.actorId,
        actorType: token?.actor?.type,
        actorSourceType: token?.actor?._source?.type,
        siblingActorId: sibling?.actorId,
        siblingActorType: sibling?.actor?.type,
        siblingActorSourceType: sibling?.actor?._source?.type,
      };
    }, fixture)).toMatchObject({
      actorLink: false,
      hidden: true,
      siblingActorLink: false,
      siblingHidden: true,
    });
  });

  await phase("render every crew layout and draw each canonical or combined Helm preview", async () => {
    const previews = await page.evaluate(async actorId => {
      const { HelmPreview, ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const state = ShipCombatState.forShip(actor);
      const sheet = actor.sheet;
      const useV1 = SystemAdapter.current.useApplicationV1;
      const expectedTabs = {
        3: ["captain4man", "engineer3man", "gunner4man"],
        4: ["captain4man", "engineer5man", "pilot", "gunner4man"],
        5: ["captain5man", "engineer5man", "pilot", "sensors", "gunner5man"],
        6: ["captain", "engineer", "pilot", "sensors", "gunner", "ordnance"],
      };
      const allRoleTabs = [...new Set(Object.values(expectedTabs).flat())];
      const results = [];
      for (const crewSize of [3, 4, 5, 6]) {
        await state.update({
          crewSize,
          "resources.pilot.fuelBurned": 0,
          "resources.pilot.prevTurnMove": 0,
        });
        await sheet.render(useV1 ? true : { force: true });
        const deadline = Date.now() + 10_000;
        const expected = [...expectedTabs[crewSize]].sort();
        let renderedTabs = [];
        let navigationTabs = [];
        let root;
        // AppV1 render() returns before its replacement DOM is ready. AppV2
        // can update parts in place. Wait for the actual station panels, not
        // merely a connected application root from the previous layout.
        do {
          root = globalThis.__shipCombatAppRoot(sheet);
          renderedTabs = allRoleTabs.filter(tabId => useV1
            ? root?.querySelector(`.sheet-body .tab[data-tab="${tabId}"]`)
            : root?.querySelector(`[data-application-part="${tabId}"]`)).sort();
          navigationTabs = allRoleTabs.filter(tabId => root?.querySelector(`nav [data-tab="${tabId}"]`)).sort();
          if (root?.isConnected
            && JSON.stringify(renderedTabs) === JSON.stringify(expected)
            && JSON.stringify(navigationTabs) === JSON.stringify(expected)) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        if (JSON.stringify(renderedTabs) !== JSON.stringify(expected)
          || JSON.stringify(navigationTabs) !== JSON.stringify(expected)) {
          throw new Error(`Crew layout ${crewSize}: panels [${renderedTabs.join(", ")}], navigation [${navigationTabs.join(", ")}]; expected [${expected.join(", ")}]`);
        }
        const helmTab = crewSize === 3 ? "engineer3man" : "pilot";
        if (useV1) sheet._tabs[0].active = helmTab;
        else sheet.tabGroups.primary = helmTab;
        sheet._helmState = { fuelSlider: 50, bearing: 15, confirmed: false };
        sheet._updateHelmPreview();
        results.push({
          crewSize,
          renderedTabs,
          activeTab: useV1 ? sheet._tabs[0].active : sheet.tabGroups.primary,
          containerName: HelmPreview._container?.name ?? null,
          lineName: HelmPreview._line?.name ?? null,
        });
        HelmPreview.hide();
      }
      await sheet.close();
      return results;
    }, fixture.actorId);
    expect(previews).toEqual([
      { crewSize: 3, renderedTabs: ["captain4man", "engineer3man", "gunner4man"], activeTab: "engineer3man", containerName: "shipcombat-helm-ghost", lineName: "shipcombat-helm-line" },
      { crewSize: 4, renderedTabs: ["captain4man", "engineer5man", "gunner4man", "pilot"], activeTab: "pilot", containerName: "shipcombat-helm-ghost", lineName: "shipcombat-helm-line" },
      { crewSize: 5, renderedTabs: ["captain5man", "engineer5man", "gunner5man", "pilot", "sensors"], activeTab: "pilot", containerName: "shipcombat-helm-ghost", lineName: "shipcombat-helm-line" },
      { crewSize: 6, renderedTabs: ["captain", "engineer", "gunner", "ordnance", "pilot", "sensors"], activeTab: "pilot", containerName: "shipcombat-helm-ghost", lineName: "shipcombat-helm-line" },
    ]);
  });

  await phase("commit a Pilot Core action across real Actor and Token documents", async () => {
    const result = await page.evaluate(async ({ actorId, shipTokenId }) => {
      const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const token = canvas.scene.tokens.get(shipTokenId);
      const state = ShipCombatState.forShip(actor);
      await state.update({
        "resources.pilot.coreCount": 1,
        "resources.pilot.coreActionsPlayed": [],
        "resources.pilot.fuelBurned": 0,
      });
      const oldX = token.x;
      const gridSize = canvas.grid.size;
      if (!Number.isFinite(gridSize) || gridSize <= 0) {
        throw new Error(`Foundry exposed an invalid canvas grid size: ${gridSize}`);
      }
      const requestedX = oldX + gridSize;
      const committed = await state.pilotStrafe(
        game.user.id,
        requestedX,
        token.y,
        token.rotation,
        1,
        [],
      );
      const data = SystemAdapter.current.getShipData(actor);
      return {
        committed,
        requestedX,
        activeTokenId: actor.getActiveTokens()[0]?.document?.id ?? null,
        coreCount: data.resources.pilot.coreCount,
        played: data.resources.pilot.coreActionsPlayed,
      };
    }, fixture);
    expect(result).toMatchObject({
      committed: true,
      activeTokenId: fixture.shipTokenId,
      coreCount: 0,
      played: ["strafe"],
    });
    await expect.poll(() => page.evaluate(shipTokenId => (
      canvas.scene.tokens.get(shipTokenId)?.x ?? null
    ), fixture.shipTokenId)).toBe(result.requestedX);
  });

  await phase("preserve independent state across unlinked NPC tokens", async () => {
    const isolation = await page.evaluate(async ({ sceneId, npcActorId, npcTokenId, siblingNpcTokenId }) => {
      const { SystemAdapter } = globalThis.ShipCombat._api;
      const scene = game.scenes.get(sceneId);
      const source = game.actors.get(npcActorId);
      const primary = scene.tokens.get(npcTokenId).actor;
      const sibling = scene.tokens.get(siblingNpcTokenId).actor;
      await primary.update({
        [SystemAdapter.current.systemPath("shields.bow")]: 7,
        [SystemAdapter.current.systemPath("resources.pilot.bearing")]: 33,
      });
      const snapshot = actor => {
        const data = SystemAdapter.current.getShipData(actor);
        return { bow: data.shields?.bow ?? 0, bearing: data.resources?.pilot?.bearing ?? 0 };
      };
      return {
        actorsDistinct: primary !== source && sibling !== source && primary !== sibling,
        primary: snapshot(primary),
        source: snapshot(source),
        sibling: snapshot(sibling),
      };
    }, fixture);
    expect(isolation.actorsDistinct).toBe(true);
    expect(isolation.primary).toEqual({ bow: 7, bearing: 33 });
    expect(isolation.source).not.toEqual(isolation.primary);
    expect(isolation.sibling).not.toEqual(isolation.primary);
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
    await page.evaluate(async npcTokenId => {
      const sheet = canvas.scene.tokens.get(npcTokenId).actor.sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      await sheet.render(isV1 ? true : { force: true });
    }, fixture.npcTokenId);
    const ordnanceTab = page.locator(
      'nav [data-tab="ordnance"], .tabs [data-tab="ordnance"], [data-action="tab"][data-tab="ordnance"]',
    ).filter({ visible: true }).last();
    await expect(ordnanceTab).toBeVisible();
    await ordnanceTab.click();
    await expect(page.locator('[data-action="npcLaunchTorpedo"]')).toBeVisible();
    await expect(page.locator('[data-action="npcLaunchStrikeCraft"]')).toBeVisible();
  });

  await phase("verify NPC ordnance selectors and launch controls fit their rendered rows", async () => {
    const layout = await page.locator(".shipcombat-npc-launch-row:visible").evaluateAll(rows => rows.map(row => {
      const select = row.querySelector(".shipcombat-npc-launch-template");
      const controls = row.querySelector(".shipcombat-npc-launch-controls");
      const count = row.querySelector(".shipcombat-npc-launch-count");
      const button = row.querySelector(".shipcombat-npc-launch-btn");
      const rowRect = row.getBoundingClientRect();
      const selectRect = select.getBoundingClientRect();
      const countRect = count.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        optionText: select.selectedOptions[0]?.textContent?.trim() ?? "",
        selectorUsesRow: selectRect.width / rowRect.width,
        controlsFit: controls.scrollWidth <= controls.clientWidth + 1,
        buttonWiderThanTall: buttonRect.width > buttonRect.height * 1.5,
        alignedHeights: Math.abs(buttonRect.height - countRect.height) <= 2,
      };
    }));
    expect(layout).toHaveLength(2);
    for (const row of layout) {
      expect(row.optionText.length).toBeGreaterThan(0);
      expect(row.selectorUsesRow).toBeGreaterThan(0.9);
      expect(row.controlsFit).toBe(true);
      expect(row.buttonWiderThanTall).toBe(true);
      expect(row.alignedHeights).toBe(true);
    }
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
    await canvas.scene.tokens.get(npcTokenId).actor.sheet.close();
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
      const updatedNpcToken = await npcToken.update({ hidden: false });
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
        npcHidden: scene.tokens.get(npcTokenId)?.hidden,
        npcHiddenSource: scene.tokens.get(npcTokenId)?._source?.hidden,
        npcHiddenFromUpdate: updatedNpcToken.hidden,
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
    expect(tokenState.npcLinked).toBe(false);
    expect(tokenState.npcHidden).toBe(false);
    expect(tokenState.npcHiddenSource).toBe(false);
    expect(tokenState.npcHidden).toBe(tokenState.npcHiddenFromUpdate);
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
        const element = globalThis.__shipCombatAppRoot(app);
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
      return token.update({ rotation: (token.rotation + 45) % 360 });
    }, fixture);
    await expect.poll(() => page.evaluate(npcTokenId => {
      const app = globalThis.__shipCombatIntegrationPopup;
      const root = globalThis.__shipCombatAppRoot(app);
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
      await token.update({ rotation: (token.rotation + 45) % 360 });
      await new Promise(resolve => setTimeout(resolve, 300));
    }, fixture);
    expect(await page.evaluate(() => {
      const app = globalThis.__shipCombatIntegrationPopup;
      const root = globalThis.__shipCombatAppRoot(app);
      return !app?.rendered && !root?.isConnected && globalThis.__shipCombatPopupTarget?.isConnected === false;
    })).toBe(true);
  });

  await phase("keep the Ordnance roll available while commitments lock allocation", async () => {
    const state = await page.evaluate(async actorId => {
      const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      await ShipCombatState.forShip(actor).update({
        "resources.ordnance.bosunRolled": false,
        "resources.ordnance.commitments": [{
          id: "integration-queued-action",
          action: "loadAmmo",
          crewCount: 2,
          turnsRemaining: 0,
          addedRound: 0,
        }],
      });
      const sheet = actor.sheet;
      const isV1 = sheet instanceof foundry.appv1.api.Application;
      await sheet.render(isV1 ? true : { force: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      const root = globalThis.__shipCombatAppRoot(sheet);
      const roll = root?.querySelector('[data-action="rollOrdnanceMaster"]');
      const allocationPanel = roll?.closest(".shipcombat-helm-stats, .sc-skill-row");
      const allocationButtons = [...(allocationPanel?.querySelectorAll('[data-action="allocOrdnanceSL"]') ?? [])];
      const result = {
        rollExists: !!roll,
        rollPointerEvents: roll ? getComputedStyle(roll).pointerEvents : null,
        allocationPanelExists: !!allocationPanel,
        allocationPanelPointerEvents: allocationPanel ? getComputedStyle(allocationPanel).pointerEvents : null,
        allocationsExist: allocationButtons.length > 0,
        allocationsDisabled: allocationButtons.every(button => button.disabled),
        systemPath: SystemAdapter.current.systemPath("resources.ordnance.commitments"),
      };
      await ShipCombatState.forShip(actor).update({ "resources.ordnance.commitments": [] });
      await sheet.close();
      return result;
    }, fixture.actorId);
    expect(state).toEqual({
      rollExists: true,
      rollPointerEvents: "auto",
      allocationPanelExists: true,
      allocationPanelPointerEvents: "auto",
      allocationsExist: true,
      allocationsDisabled: true,
      systemPath: "system.resources.ordnance.commitments",
    });
  });

  const combatFixture = await phase("start real combat with player and NPC combatants", () => page.evaluate(async ({
    actorId, crewActorId, playerId, npcActorId, sceneId, shipTokenId, npcTokenId,
  }) => {
    const { ShipCombatState, SystemAdapter } = globalThis.ShipCombat._api;
    const ship = game.actors.get(actorId);
    const crew = game.actors.get(crewActorId);
    const npc = game.scenes.get(sceneId).tokens.get(npcTokenId).actor;
    const hpRemaining = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    const shipState = ShipCombatState.forShip(ship);
    await shipState.update({
      "hull.max": 20,
      "hull.value": hpRemaining ? 20 : 0,
      internalFire: 2,
      "resources.ordnance.manpower": 12,
      "resources.ordnance.manpowerMax": 12,
      "resources.captain.hand": [{
        instanceId: "integration-hold-the-line",
        cardId: "holdTheLine",
        salvaged: false,
      }],
      "resources.pilot.fuelBurned": 25,
      "resources.pilot.bearing": 45,
      "resources.pilot.prevTurnMove": 0,
    });
    await shipState.playCard({
      cardId: "holdTheLine",
      cardInstanceId: "integration-hold-the-line",
    });
    await shipState.assignRole(playerId, "captain", {
      id: crew.id,
      uuid: crew.uuid,
      name: crew.name,
      img: crew.img,
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
      [SystemAdapter.current.systemPath("resources.pilot.pilotingSL")]: 4,
      [SystemAdapter.current.systemPath("resources.pilot.pilotingMessageId")]: "integration-piloting-roll",
      [SystemAdapter.current.systemPath("resources.gunner.ordnanceSL")]: 3,
      [SystemAdapter.current.systemPath("resources.gunner.ordnanceRolled")]: true,
      [SystemAdapter.current.systemPath("resources.gunner.slLocked")]: true,
      "system.engActionUsed": true,
    });
    const combat = await Combat.create({
      scene: sceneId,
      active: true,
      combatants: [
        { actorId, tokenId: shipTokenId, sceneId },
        { actorId: npcActorId, tokenId: npcTokenId, sceneId },
      ],
    });
    const combatantIds = combat.combatants.map(combatant => combatant.id);
    await combat.rollInitiative(combatantIds);
    const rolledInitiatives = combat.combatants.map(combatant => combatant.initiative);
    if (rolledInitiatives.some(value => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
      const diagnostics = combat.combatants.map(combatant => ({
        id: combatant.id,
        actorId: combatant.actorId,
        initiative: combatant.initiative,
        actorType: combatant.actor?.type,
        actorSourceType: combatant.actor?._source?.type,
        worldActorType: game.actors.get(combatant.actorId)?.type,
        worldActorSourceType: game.actors.get(combatant.actorId)?._source?.type,
        tokenBaseType: combatant.token?.baseActor?.type,
        tokenBaseSourceType: combatant.token?.baseActor?._source?.type,
      }));
      throw new Error(`Ship tracker initiative did not resolve: ${JSON.stringify(diagnostics)}`);
    }
    const playerCombatant = combat.combatants.find(combatant => combatant.actorId === actorId);
    const npcCombatant = combat.combatants.find(combatant => combatant.actorId === npcActorId);
    await combat.setInitiative(playerCombatant.id, 20);
    await combat.setInitiative(npcCombatant.id, 10);
    await combat.startCombat();
    return { combatId: combat.id, hpRemaining, rolledInitiatives };
  }, fixture));

  expect(combatFixture.rolledInitiatives).toHaveLength(2);
  expect(combatFixture.rolledInitiatives.every(value => Number(value) > 0)).toBe(true);

  await phase("verify player turn-start hooks and duplicate-delivery idempotency", async () => {
    const expectedHull = combatFixture.hpRemaining ? 20 : 0;
    await expect.poll(() => page.evaluate(({ actorId, combatId }) => {
      const { SystemAdapter } = globalThis.ShipCombat._api;
      const actor = game.actors.get(actorId);
      const data = SystemAdapter.current.getShipData(actor);
      return {
        currentActorId: game.combats.get(combatId)?.combatant?.actorId,
        active: data.active,
        hull: data.hull.value,
        fuelBurned: data.resources.pilot.fuelBurned,
        bearing: data.resources.pilot.bearing,
        manpower: data.resources.ordnance.manpower,
        manpowerMax: data.resources.ordnance.manpowerMax,
        holdTheLineActive: data.resources.captain.holdTheLineActive,
        captainHand: data.resources.captain.hand.length,
        captainDraw: data.resources.captain.drawPile.length,
        captainDiscard: data.resources.captain.discardPile.length,
        captainUnique: new Set([
          ...data.resources.captain.hand,
          ...data.resources.captain.drawPile,
          ...data.resources.captain.discardPile,
        ].map(card => card.instanceId)).size,
      };
    }, { ...fixture, ...combatFixture })).toEqual({
      currentActorId: fixture.actorId,
      active: true,
      hull: expectedHull,
      fuelBurned: 0,
      bearing: 0,
      manpower: 12,
      manpowerMax: 12,
      holdTheLineActive: false,
      captainHand: 3,
      captainDraw: 20,
      captainDiscard: 0,
      captainUnique: 23,
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
    await expect.poll(() => page.evaluate(({ sceneId, npcActorId, npcTokenId, siblingNpcTokenId, combatId, ordnanceMatrix }) => {
      const npc = game.scenes.get(sceneId).tokens.get(npcTokenId).actor;
      const data = npc.system;
      const source = game.actors.get(npcActorId).system;
      const sibling = game.scenes.get(sceneId).tokens.get(siblingNpcTokenId).actor.system;
      const playerTorpedo = canvas.scene.tokens.get(ordnanceMatrix.playerTorpedo.tokenId)?.actor?.system;
      const playerCraft = canvas.scene.tokens.get(ordnanceMatrix.playerStrikeCraft.tokenId)?.actor?.system;
      return {
        currentActorId: game.combats.get(combatId)?.combatant?.actorId,
        hull: data.hull.value,
        flux: data.voidshieldFluxRemaining,
        fuelBurned: data.resources.pilot.fuelBurned,
        bearing: data.resources.pilot.bearing,
        pilotingMessageId: data.resources.pilot.pilotingMessageId,
        ordnanceRolled: data.resources.gunner.ordnanceRolled,
        engActionUsed: data.engActionUsed,
        sourceBearing: source.resources.pilot.bearing,
        siblingBearing: sibling.resources.pilot.bearing,
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
      pilotingMessageId: "",
      ordnanceRolled: false,
      engActionUsed: false,
      sourceBearing: 0,
      siblingBearing: 0,
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

  await phase("seed one authoritative Ordnance Core action for the player socket", () => page.evaluate(async actorId => {
    const state = globalThis.ShipCombat._api.ShipCombatState.forShip(game.actors.get(actorId));
    await state.update({
      "resources.ordnance.coreCount": 1,
      "resources.ordnance.coreActionsPlayed": [],
      "resources.ordnance.craftDestroyed": 1,
      "resources.ordnance.craftPartialRecovery": 0,
    });
  }, fixture.actorId));

  await phase("stop the GM canvas before starting the player client", () => page.evaluate(async () => {
    if (canvas?.ready) await canvas.tearDown();
  }));

  const { playerContext, playerPage, playerErrors } = await phase("join a second browser session as the owning player", async () => {
    const playerContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await playerContext.addInitScript(() => localStorage.setItem("core.noCanvas", "true"));
    const playerPage = await playerContext.newPage();
    const playerErrors = collectModuleErrors(playerPage);
    await joinWorld(playerPage, playerName, playerPassword);
    await installAppRootResolver(playerPage);
    return { playerContext, playerPage, playerErrors };
  });

  await phase("mulligan a real initialized Captain card through the rendered player sheet", async () => {
    const replacedInstanceId = await playerPage.evaluate(async actorId => {
      const actor = game.actors.get(actorId);
      const sheet = actor.sheet;
      const useV1 = globalThis.ShipCombat._api.SystemAdapter.current.useApplicationV1;
      await sheet.render(useV1 ? true : { force: true });
      const deadline = Date.now() + 5_000;
      let root;
      while (!(root = globalThis.__shipCombatAppRoot(sheet))?.isConnected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      root?.querySelector('[data-action="tab"][data-tab="captain"], nav [data-tab="captain"], .tabs [data-tab="captain"]')?.click();
      let button;
      while (!(button = globalThis.__shipCombatAppRoot(sheet)?.querySelector('[data-action="captainMulligan"]'))
        && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!button) throw new Error("Initialized Captain hand did not render a Mulligan control");
      const card = button.closest("[data-card-instance-id]");
      const instanceId = card?.dataset.cardInstanceId;
      if (!instanceId) throw new Error("Rendered Mulligan control has no card instance identity");
      button.click();
      return instanceId;
    }, fixture.actorId);

    // A Captain action with unrolled Leadership must cross the real
    // allocation-warning dialog before its socket request is dispatched.
    // Clicking the card alone correctly leaves the authoritative hand intact.
    const warning = playerPage.locator(".shipcombat-allocation-warning");
    await warning.waitFor({ state: "visible" });
    await warning.locator('button[data-action="continue"], button[data-button="continue"]').click();

    await expect.poll(() => page.evaluate(({ actorId, replacedInstanceId }) => {
      const data = globalThis.ShipCombat._api.SystemAdapter.current.getShipData(game.actors.get(actorId));
      const captain = data.resources.captain;
      const allCards = [...captain.hand, ...captain.drawPile, ...captain.discardPile];
      return {
        hand: captain.hand.length,
        draw: captain.drawPile.length,
        discard: captain.discardPile.length,
        spent: captain.mulligansSpent,
        oldLeftHand: !captain.hand.some(card => card.instanceId === replacedInstanceId),
        oldInDiscard: captain.discardPile.some(card => card.instanceId === replacedInstanceId),
        unique: new Set(allCards.map(card => card.instanceId)).size,
      };
    }, { actorId: fixture.actorId, replacedInstanceId })).toEqual({
      hand: 3,
      draw: 19,
      discard: 1,
      spent: 1,
      oldLeftHand: true,
      oldInDiscard: true,
      unique: 23,
    });
    await playerPage.evaluate(actorId => game.actors.get(actorId).sheet.close(), fixture.actorId);
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

  await phase("commit an Ordnance Core spend and effect through one player-to-GM request", async () => {
    const result = await playerPage.evaluate(async actorId => {
      const actor = game.actors.get(actorId);
      const requestGM = globalThis.ShipCombat._api.createActionRequester(() => actor);
      return requestGM(null, "executeOrdnanceCoreAction", {
        requestId: "integration-ordnance-core-atomic",
        actionId: "combatRecoveryDoctrine",
        choice: "destroyed",
      });
    }, fixture.actorId);
    expect(result).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(actorId => {
      const data = globalThis.ShipCombat._api.SystemAdapter.current.getShipData(game.actors.get(actorId));
      return {
        coreCount: data.resources.ordnance.coreCount,
        destroyed: data.resources.ordnance.craftDestroyed,
        partial: data.resources.ordnance.craftPartialRecovery,
        played: data.resources.ordnance.coreActionsPlayed,
      };
    }, fixture.actorId)).toEqual({
      coreCount: 0,
      destroyed: 0,
      partial: 1,
      played: ["combatRecoveryDoctrine"],
    });
  });

  const duplicateRequest = await phase("send a duplicated player-to-GM resource request", () => playerPage.evaluate(async actorId => {
    const actor = game.actors.get(actorId);
    const requestGM = globalThis.ShipCombat._api.createActionRequester(() => actor);
    const before = globalThis.ShipCombat._api.SystemAdapter.current
      .getShipData(actor)?.resources?.engineer?.auxiliaryPower;
    const payload = {
      requestId: "integration-duplicate-request",
      adjustments: [{ roleId: "engineer", key: "auxiliaryPower", delta: 1 }],
    };
    const results = await Promise.race([
      Promise.all([
        requestGM(null, "adjustResources", payload),
        requestGM(null, "adjustResources", payload),
      ]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Duplicated player-to-GM request did not resolve within 30 seconds")),
        30_000,
      )),
    ]);
    return { before, results };
  }, fixture.actorId));

  await phase("verify duplicate delivery committed exactly once", async () => {
    expect(duplicateRequest.results).toEqual([{ ok: true }, { ok: true }]);
    await expect.poll(() => page.evaluate(actorId => {
      const actor = game.actors.get(actorId);
      return globalThis.ShipCombat._api.SystemAdapter.current
        .getShipData(actor)?.resources?.engineer?.auxiliaryPower;
    }, fixture.actorId)).toBe(duplicateRequest.before + 1);
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
    actorId, crewActorId, npcActorId, ordnanceActorId, ordnanceMatrix, sceneId, playerId,
  }) => {
    await game.scenes.get(sceneId)?.delete();
    const generatedIds = Object.values(ordnanceMatrix).map(entry => entry.actorId);
    const actorIds = [actorId, crewActorId, npcActorId, ordnanceActorId, ...generatedIds]
      .filter(id => game.actors.has(id));
    if (actorIds.length) await Actor.deleteDocuments(actorIds);
    await game.users.get(playerId)?.delete();
  }, fixture));
});
