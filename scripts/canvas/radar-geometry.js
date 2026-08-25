const TAU = Math.PI * 2;

/** Foundry token rotation 0 points toward canvas south in ship-combat art. */
export function tokenRotationToCanvasHeading(rotation = 0) {
  return (Number(rotation) + 90) * (Math.PI / 180);
}

/**
 * Transform a canvas/world angle into radar space.
 * TRUE is north-up; REL rotates the world until the own ship points up.
 */
export function worldAngleToRadar(worldAngle, shipHeading, trueBearing = false) {
  return trueBearing ? worldAngle : worldAngle - shipHeading - Math.PI / 2;
}

/** Transform another token's forward heading into the active radar frame. */
export function tokenHeadingOnRadar(rotation, shipHeading, trueBearing = false) {
  return worldAngleToRadar(tokenRotationToCanvasHeading(rotation), shipHeading, trueBearing);
}

/** Position of a true compass bearing (0=N, 90=E) in the active radar frame. */
export function compassBearingOnRadar(bearingDegrees, shipHeading, trueBearing = false) {
  const worldAngle = (Number(bearingDegrees) * Math.PI / 180) - Math.PI / 2;
  return worldAngleToRadar(worldAngle, shipHeading, trueBearing);
}

/** Relative bearing clockwise from the ship's bow, normalized to 000–359°. */
export function relativeBearingDegrees(worldAngle, shipHeading) {
  const degrees = (worldAngle - shipHeading) * (180 / Math.PI);
  return ((degrees % 360) + 360) % 360;
}

/** Sweep phase uses 0 at radar-up and increases clockwise. */
export function radarAngleToSweepPhase(radarAngle) {
  return ((radarAngle + Math.PI / 2) % TAU + TAU) % TAU;
}
