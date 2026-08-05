export function installMockChrome() {
  const areas = { local: new Map(), session: new Map() };
  function makeArea(name) {
    return {
      get(keys, cb) {
        const store = areas[name];
        let res;
        if (keys === null || keys === undefined) res = Object.fromEntries(store);
        else if (Array.isArray(keys)) res = Object.fromEntries(keys.map(k => [k, store.get(k)]).filter(([, v]) => v !== undefined));
        else res = store.has(keys) ? { [keys]: store.get(keys) } : {};
        cb(res);
      },
      set(obj, cb) {
        for (const [k, v] of Object.entries(obj)) areas[name].set(k, v);
        cb();
      },
      getBytesInUse(keys, cb) { cb(JSON.stringify(Object.fromEntries(areas[name])).length); }
    };
  }
  globalThis.__mockChrome = {
    storage: { local: makeArea('local'), session: makeArea('session') },
    runtime: { lastError: null }
  };
  return { local: areas.local, session: areas.session };
}
