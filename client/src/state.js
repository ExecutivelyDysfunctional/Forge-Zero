/**
 * Single store, explicit subscribers, and a debounce on composition.
 *
 * Composing a pack is local arithmetic on the server side and costs nothing, so
 * the brief is *live*: editing a feature line re-fits the stages while you type.
 * That is deliberate - seeing the stage count move as you add scope is how the
 * tool teaches the cost of a feature on a free model.
 */
import { api } from './api.js';
import { debounce, toast } from './ui.js';

const LS_KEY = 'forge-zero.workbench.v1';

export const state = {
  boot: null,
  mode: 'single-file',
  modelId: 'gemini-2.5-flash',
  options: { strategy: 'auto', planFirst: true, includeAudit: true, compactRules: 'auto' },
  spec: null,
  pack: null,
  packId: null,
  projectId: null,
  ui: { stages: {}, briefOpen: true, tab: 'user', showSystem: false },
  keys: [],
  runs: [],
  projects: [],
  busy: { compose: false, run: null, save: false },
  status: '',
  error: null,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(reason = 'update') { for (const fn of subs) { try { fn(reason); } catch (e) { console.error('render failed', e); } } }

export function patch(obj, reason) {
  Object.assign(state, obj);
  emit(reason);
}

export const stageUi = (id) => (state.ui.stages[id] ??= { open: false, out: '', status: '', verify: null, preview: null, meta: null });

/* ---------------------------- spec helpers ---------------------------- */

const EMPTY = {
  name: '', idea: '', audience: '', ambition: 'polished', features: [], entities: [],
  mustHave: [], avoid: [], notes: '',
  single: { persistence: 'local', layout: 'both', allowCdn: [], offlineFirst: true, keyboardShortcuts: false, shareData: false },
  stack: { stackId: 'node-express-sqlite', auth: 'none', realtime: 'none', deploy: 'local', tests: 'smoke', seedVolume: 40, multiUser: false },
};

export function emptySpec(mode) {
  return structuredClone({ ...EMPTY, mode });
}

export function setSpec(partial, reason = 'spec') {
  state.spec = { ...state.spec, ...partial };
  persist();
  emit(reason);
  scheduleCompose();
}

export function setSpecSection(section, partial, reason = 'spec') {
  state.spec = { ...state.spec, [section]: { ...(state.spec[section] ?? {}), ...partial } };
  persist();
  emit(reason);
  scheduleCompose();
}

export function setMode(mode) {
  if (mode === state.mode) return;
  const keep = state.spec ?? emptySpec(mode);
  state.mode = mode;
  // The brief survives the toggle; only mode-specific sections are reset, because
  // carrying e.g. a stack choice into a single-file build is how nonsense prompts
  // get written.
  state.spec = { ...keep, mode, single: keep.single ?? emptySpec('single-file').single, stack: keep.stack ?? emptySpec('full-stack').stack };
  state.pack = null;
  state.packId = null;
  persist();
  emit('mode');
  composeNow();
}

export function setModel(modelId) {
  if (modelId === state.modelId) return;
  state.modelId = modelId;
  persist();
  emit('model');
  composeNow();
}

export function setOption(key, value) {
  state.options = { ...state.options, [key]: value };
  persist();
  emit('options');
  composeNow();
}

export const models = {
  flat() {
    return (state.boot?.models ?? []).flatMap((g) => g.models.map((m) => ({ ...m, provider: g.provider, providerLabel: g.label, tierNote: g.tierNote, keyUrl: g.keyUrl })));
  },
  byId(id) {
    return models.flat().find((m) => m.id === id) ?? null;
  },
  keyState(id) {
    const m = models.byId(id);
    if (!m) return null;
    return state.keys.find((k) => k.provider === m.provider) ?? null;
  },
};

/* ------------------------------ actions ------------------------------- */

export const composeNow = async () => {
  if (!state.spec) return;
  state.busy.compose = true;
  state.error = null;
  emit('busy');
  try {
    const res = await api.compose({ mode: state.mode, spec: state.spec, modelId: state.modelId, options: state.options, persist: true, projectId: state.projectId ?? undefined });
    state.pack = res.pack;
    state.packId = res.packId ?? null;
    state.status = `Pack composed · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    state.error = err.payload?.errors?.[0] ?? err.message;
    state.pack = null;
    state.packId = null;
  } finally {
    state.busy.compose = false;
    persist();
    emit('pack');
  }
};

export const scheduleCompose = debounce(composeNow, 420);

export async function loadBoot() {
  state.boot = await api.bootstrap();
  state.modelId = state.boot.defaultModelId ?? state.modelId;
  state.spec = emptySpec(state.mode);
  await Promise.allSettled([loadKeys(), loadProjects(), loadRuns(), restore()]);
  if (!state.spec.idea) applyPreset(state.boot.presets?.[0]?.id);
  else scheduleCompose();
  emit('boot');
  composeNow();
}

export function applyPreset(presetId) {
  const preset = (state.boot?.presets ?? []).find((p) => p.id === presetId);
  if (!preset) return;
  state.mode = preset.mode;
  state.spec = structuredClone({ ...emptySpec(preset.mode), ...preset.spec });
  state.pack = null;
  persist();
  emit('preset');
  composeNow();
  toast(`Loaded “${preset.label}”`, 'ok');
}

export function newBrief() {
  state.spec = emptySpec(state.mode);
  state.projectId = null;
  state.pack = null;
  persist();
  emit('reset');
  composeNow();
}

async function loadKeys() {
  try { state.keys = (await api.keys()).keys ?? []; } catch { state.keys = []; }
}
async function loadRuns() {
  try { state.runs = (await api.runs()).runs ?? []; } catch { state.runs = []; }
}
async function loadProjects() {
  try { state.projects = (await api.projects()).projects ?? []; } catch { state.projects = []; }
}
export { loadKeys, loadRuns, loadProjects };

/* ---------------------------- persistence ----------------------------- */

/**
 * Two-tier persistence: localStorage for instant restore, and the server's
 * settings table so the same brief is waiting for you on another browser. The
 * server copy is best-effort - offline-first behaviour, same as the apps we
 * generate prompts for.
 */
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const snapshot = { mode: state.mode, modelId: state.modelId, options: state.options, spec: state.spec, projectId: state.projectId, savedAt: Date.now() };
    try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch { /* private mode */ }
    api.saveState(snapshot).catch(() => { /* not fatal */ });
  }, 700);
}

async function restore() {
  let snapshot = null;
  try { snapshot = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); } catch { snapshot = null; }
  if (!snapshot) {
    try { snapshot = (await api.loadState())?.state; } catch { snapshot = null; }
  }
  if (!snapshot?.spec) return;
  state.mode = snapshot.mode ?? state.mode;
  state.modelId = snapshot.modelId ?? state.modelId;
  state.options = { ...state.options, ...(snapshot.options ?? {}) };
  state.spec = { ...emptySpec(state.mode), ...snapshot.spec };
  state.projectId = snapshot.projectId ?? null;
}

export async function saveProject() {
  if (!state.spec?.name?.trim()) { toast('Give the brief a name first', 'err'); return; }
  state.busy.save = true;
  emit('busy');
  try {
    if (state.projectId) {
      await api.updateProject(state.projectId, { name: state.spec.name, mode: state.mode, modelId: state.modelId, spec: state.spec, options: state.options });
    } else {
      const row = await api.createProject({ name: state.spec.name, mode: state.mode, modelId: state.modelId, spec: state.spec, options: state.options });
      state.projectId = row.project.id;
    }
    await loadProjects();
    if (state.packId) await api.packProject(state.projectId, { modelId: state.modelId, options: state.options });
    toast('Project saved', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'err');
  } finally {
    state.busy.save = false;
    emit('saved');
  }
}

export async function openProject(id) {
  try {
    const { project } = await apiGetProject(id);
    state.mode = project.mode;
    state.spec = { ...emptySpec(project.mode), ...project.spec };
    state.modelId = project.model_id ?? state.modelId;
    state.options = { ...state.options, ...(project.options ?? {}) };
    state.projectId = project.id;
    emit('project');
    composeNow();
  } catch (err) {
    toast(`Could not open project: ${err.message}`, 'err');
  }
}

async function apiGetProject(id) { return api.get(`/api/projects/${id}`); }

export async function deleteProject(id) {
  try {
    await api.deleteProject(id);
    if (state.projectId === id) state.projectId = null;
    await loadProjects();
    emit('projects');
    toast('Project deleted');
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'err');
  }
}
