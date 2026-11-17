// Score library in browser storage (DESIGN §12). No DOM: the storage object is passed in, so
// tests can use a separate prefix or a fake. Each score is one key, `<prefix>doc.<id>`, holding
// {modified, score}; there is no index key, so two tabs never overwrite each other's list.
import { isValidScore as valid, upgradeScore } from "./model.js";

const isValidScore = (score) => valid(upgradeScore(score)); // older saves are brought up to date first

const docKey = (prefix, id) => `${prefix}doc.${id}`;

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Newest first. Entries that can't be read are listed with ok: false, not hidden.
export function list(storage, prefix) {
  const out = [];
  try {
    const head = prefix + "doc.";
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(head)) continue;
      const id = k.slice(head.length);
      try {
        const { modified, score } = JSON.parse(storage.getItem(k));
        if (!isValidScore(score)) throw new Error("invalid");
        out.push({ id, ok: true, modified: +modified || 0, title: String(score.title || "Untitled"),
          composer: String(score.composer || ""), bars: score.measures.length });
      } catch { out.push({ id, ok: false, modified: 0, title: "", composer: "", bars: 0 }); }
    }
  } catch { /* storage blocked */ }
  return out.sort((a, b) => b.modified - a.modified);
}

export function load(storage, prefix, id) {
  try {
    const { score } = JSON.parse(storage.getItem(docKey(prefix, id)));
    return isValidScore(score) ? score : null;
  } catch { return null; }
}

// false when storage is full or blocked.
export function save(storage, prefix, id, score) {
  try { storage.setItem(docKey(prefix, id), JSON.stringify({ modified: Date.now(), score })); return true; }
  catch { return false; }
}

export function remove(storage, prefix, id) {
  try { storage.removeItem(docKey(prefix, id)); } catch { /* blocked */ }
}

// Move a single autosaved score from before the library existed into it. Returns its id or null.
// The old key is removed only after the new entry is written.
export function migrate(storage, prefix, legacyKey) {
  try {
    const raw = storage.getItem(legacyKey);
    if (!raw) return null;
    const score = JSON.parse(raw);
    if (!isValidScore(score)) return null;
    const id = newId();
    if (!save(storage, prefix, id, score)) return null;
    storage.removeItem(legacyKey);
    return id;
  } catch { return null; }
}
