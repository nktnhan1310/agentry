// Settings merge that remembers what the kit added ("owned"), so a later sync or `kit uninstall` can take
// exactly those entries back out. Entries the project already had are never owned and never removed.
const empty = () => ({ allow: [], deny: [], hooks: [] });
const hookCmds = (kit) => Object.entries(kit.hooks || {}).flatMap(([event, groups]) =>
  groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, command: h.command, hook: h }))));

// Remove owned entries for which keep() is false. Containers emptied by the removal are dropped too.
function strip(r, owned, keep, changes) {
  for (const k of ['allow', 'deny']) {
    const list = r.permissions?.[k];
    if (!list) continue;
    const next = list.filter((x) => !owned[k]?.includes(x) || keep(k, x));
    for (const x of list) if (!next.includes(x)) changes.push(`- ${k} ${x}`);
    if (next.length) r.permissions[k] = next;
    else if (list.length) delete r.permissions[k];
  }
  if (r.permissions && !Object.keys(r.permissions).length) delete r.permissions;
  for (const o of owned.hooks || []) {
    if (keep('hooks', o)) continue;
    const groups = r.hooks?.[o.event];
    if (!groups) continue;
    for (const g of groups) {
      const before = g.hooks?.length || 0;
      g.hooks = (g.hooks || []).filter((h) => h.command !== o.command);
      if (g.hooks.length < before) changes.push(`- hook ${o.event} ${o.command}`);
    }
    r.hooks[o.event] = groups.filter((g) => g.hooks.length);
    if (!r.hooks[o.event].length) delete r.hooks[o.event];
  }
  if (r.hooks && !Object.keys(r.hooks).length) delete r.hooks;
}

export function applySettings(cur = {}, kit = {}, prev = empty()) {
  const r = structuredClone(cur);
  const changes = [];
  const want = { allow: new Set(kit.permissions?.allow || []), deny: new Set(kit.permissions?.deny || []) };
  const kitHooks = hookCmds(kit);
  strip(r, prev, (k, x) => (k === 'hooks' ? kitHooks.some((h) => h.command === x.command) : want[k].has(x)), changes);

  const owned = empty();
  for (const k of ['allow', 'deny']) {
    for (const x of want[k]) {
      const had = r.permissions?.[k]?.includes(x);
      if (!had) {
        r.permissions ??= {};
        (r.permissions[k] ??= []).push(x);
        changes.push(`+ ${k} ${x}`);
      }
      if (!had || prev[k]?.includes(x)) owned[k].push(x);
    }
  }
  for (const h of kitHooks) {
    const had = r.hooks?.[h.event]?.some((g) => g.hooks?.some((y) => y.command === h.command));
    if (!had) {
      r.hooks ??= {};
      r.hooks[h.event] ??= [];
      let g = r.hooks[h.event].find((x) => x.matcher === h.matcher);
      if (!g) r.hooks[h.event].push((g = { matcher: h.matcher, hooks: [] }));
      g.hooks.push(h.hook);
      changes.push(`+ hook ${h.event} ${h.command}`);
    }
    if (!had || prev.hooks?.some((p) => p.command === h.command)) owned.hooks.push({ event: h.event, command: h.command });
  }
  return { next: r, owned, changes };
}

export function removeSettings(cur = {}, owned = empty()) {
  const r = structuredClone(cur);
  const changes = [];
  strip(r, owned, () => false, changes);
  return { next: r, changes };
}
