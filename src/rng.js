// Deterministic seeded RNG — the same generator the offline pipeline uses, so a
// scene laid out here can be reproduced exactly in a build script or a QA run.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
