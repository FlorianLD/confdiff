import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import JSZip from 'jszip';
import './App.css';
import { Differ, Viewer, markMovedBlocks } from 'json-diff-kit';

// ── JSON preprocessing ────────────────────────────────────

const FILES_WITH_KEY_DELETE = new Set([
  'stock_requests', 'item_requests', 'endpoint_requests', 'delivery_configs',
  'delivery_routes', 'groups', 'rulesets', 'ruleset_chainings', 'sort_orders',
  'zones', 'subscriptionables', 'timetables', 'execution_times',
]);

function deleteFields(obj, fields) {
  if (Array.isArray(obj)) return obj.map(i => deleteFields(i, fields));
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !fields.has(k))
        .map(([k, v]) => [k, deleteFields(v, fields)])
    );
  }
  return obj;
}

function deleteIdWhere(obj, predicate) {
  if (Array.isArray(obj)) return obj.map(i => deleteIdWhere(i, predicate));
  if (obj !== null && typeof obj === 'object') {
    const result = Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, deleteIdWhere(v, predicate)])
    );
    if (result.id != null && predicate(String(result.id))) delete result.id;
    return result;
  }
  return obj;
}

function deleteNestedId(obj, outerKey) {
  if (Array.isArray(obj)) return obj.map(i => deleteNestedId(i, outerKey));
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (k === outerKey && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          const { id: _id, ...rest } = v;
          return [k, deleteNestedId(rest, outerKey)];
        }
        return [k, deleteNestedId(v, outerKey)];
      })
    );
  }
  return obj;
}

function trimNameFields(obj) {
  if (Array.isArray(obj)) return obj.map(trimNameFields);
  if (obj !== null && typeof obj === 'object')
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, k === 'name' && typeof v === 'string' ? v.trim() : trimNameFields(v)])
    );
  return obj;
}

function rekey(obj, keyFn) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [keyFn(v) ?? k, v])
  );
}

// Treat string[] as unordered: sort them alphabetically (A→Z) so a different
// element order does not register as a diff. Arrays of objects / mixed arrays
// are left untouched (kept positional).
function sortStringArrays(obj) {
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every(v => typeof v === 'string')) {
      return [...obj].sort((a, b) => a.localeCompare(b));
    }
    return obj.map(sortStringArrays);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sortStringArrays(v)])
    );
  }
  return obj;
}

const TYPED_ARRAY_FIELDS = new Set(['actions_after', 'actions_after_creation', 'conditions', 'execution_conditions']);

function prefixTransitionKeys(obj, parentKey = null) {
  if (Array.isArray(obj)) return obj.map(i => prefixTransitionKeys(i, null));
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (k === 'transitions' && parentKey != null && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          const prefixed = Object.fromEntries(
            Object.entries(v).map(([childK, childV]) => [`${parentKey}/${childK}`, prefixTransitionKeys(childV, childK)])
          );
          return [k, prefixed];
        }
        return [k, prefixTransitionKeys(v, k)];
      })
    );
  }
  return obj;
}

function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => o != null ? o[k] : undefined, obj);
}

// Per-type identity fields. Two items of the same type are considered the
// "same logical action" when their values at all listed paths match. Add an
// entry here to opt another type into content-hash-based key disambiguation.
const IDENTITY_FIELDS = {
  send_alert: ['parameters.alert_id', 'parameters.notification_name'],
  update_entities_state: ['parameters.link_key'],
};

function identitySignature(item, paths) {
  return paths.map(p => JSON.stringify(getByPath(item, p) ?? null)).join('|');
}

function indexTypedArray(arr) {
  return Object.fromEntries(arr.map((item, i) => {
    const t = item !== null && typeof item === 'object' && typeof item.type === 'string' ? item.type : 'item';
    const paths = IDENTITY_FIELDS[t];
    const suffix = paths ? `#${shortHash(identitySignature(item, paths))}` : '';
    return [`${String(i + 1).padStart(4, '0')}_${t}${suffix}`, rekeyTypedArraysWithIndex(item)];
  }));
}

function rekeyTypedArraysWithIndex(obj) {
  if (Array.isArray(obj)) return obj.map(rekeyTypedArraysWithIndex);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => {
      if (TYPED_ARRAY_FIELDS.has(k) && Array.isArray(v)) return [k, indexTypedArray(v)];
      return [k, rekeyTypedArraysWithIndex(v)];
    }));
  }
  return obj;
}

function indexOrderedKeys(obj, parentKey = null, depth = 0) {
  if (Array.isArray(obj)) return obj.map(i => indexOrderedKeys(i, null, depth + 1));
  if (obj === null || typeof obj !== 'object') return obj;
  const shouldIndex = parentKey === null
    || parentKey === 'states'
    || parentKey === 'transitions'
    || (typeof parentKey === 'string' && parentKey.startsWith('preparation.workflows.') && depth === 3);
  const entries = Object.entries(obj);
  return Object.fromEntries(entries.map(([k, v], i) => {
    const newKey = shouldIndex ? `${String(i + 1).padStart(4, '0')}_${k}` : k;
    return [newKey, indexOrderedKeys(v, k, depth + 1)];
  }));
}

function stripIndexPrefixes(diffResult) {
  const re = /^"\d{4}_([^"#]+)(?:#[^"]*)?":/;
  const transform = (lines) => lines.map(l => re.test(l.text) ? { ...l, text: l.text.replace(re, '"$1":') } : l);
  return [transform(diffResult[0]), transform(diffResult[1])];
}

function buildWorkflowOutline(diffResult) {
  if (!diffResult) return [];
  const [leftLines, rightLines] = diffResult;
  const lines = leftLines;
  const stack = [];
  const entities = [];
  const findInStack = (type) => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].node?.type === type) return stack[i].node;
    return null;
  };
  const popDownTo = (lvl, idx) => {
    while (stack.length && stack[stack.length - 1].level >= lvl) {
      const popped = stack.pop();
      if (popped.node && popped.node.endLine === -1) popped.node.endLine = idx - 1;
    }
  };
  const openRe = /^"([^"]+)":\s*[{[]/;
  for (let i = 0; i < lines.length; i++) {
    const lOpen = openRe.exec(leftLines[i]?.text ?? '');
    const rOpen = openRe.exec(rightLines[i]?.text ?? '');
    const open = lOpen ?? rOpen;
    if (open) {
      const level = lOpen ? leftLines[i].level : rightLines[i].level;
      popDownTo(level, i);
      const key = open[1];
      const parent = stack[stack.length - 1];
      let node = null;
      if (key.startsWith('workflows.') && level === 1) {
        node = { type: 'entity', key, name: key.replace(/^workflows\./, ''), startLine: i, endLine: -1, states: [] };
        entities.push(node);
      } else if (parent?.key?.startsWith('preparation.workflows.') && parent.level === 3) {
        node = { type: 'entity', key, name: key, startLine: i, endLine: -1, states: [] };
        entities.push(node);
      } else if (parent?.key === 'states') {
        const entity = findInStack('entity');
        if (entity) {
          node = { type: 'state', key, name: key, startLine: i, endLine: -1, transitions: [] };
          entity.states.push(node);
        }
      } else if (parent?.key === 'transitions') {
        const state = findInStack('state');
        if (state) {
          node = { type: 'transition', key, name: key, startLine: i, endLine: -1 };
          state.transitions.push(node);
        }
      }
      stack.push({ level, key, node });
    }
  }
  while (stack.length) {
    const popped = stack.pop();
    if (popped.node && popped.node.endLine === -1) popped.node.endLine = lines.length - 1;
  }
  const hasDiffInRange = (start, end) => {
    for (let i = start; i <= end; i++) {
      if (leftLines[i]?.type !== 'equal' && leftLines[i]?.type !== undefined) return true;
      if (rightLines[i]?.type !== 'equal' && rightLines[i]?.type !== undefined) return true;
    }
    return false;
  };
  for (const e of entities) {
    let entityDiff = hasDiffInRange(e.startLine, e.endLine);
    for (const s of e.states) {
      let stateDiff = hasDiffInRange(s.startLine, s.endLine);
      for (const t of s.transitions) {
        t.hasDiff = hasDiffInRange(t.startLine, t.endLine);
        stateDiff = stateDiff || t.hasDiff;
      }
      s.hasDiff = stateDiff;
      entityDiff = entityDiff || stateDiff;
    }
    e.hasDiff = entityDiff;
  }
  return entities;
}

function replaceTimetableIds(obj, timetableMap) {
  if (Array.isArray(obj)) return obj.map(i => replaceTimetableIds(i, timetableMap));
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (['pickup_timetable_id', 'opening_timetable_id', 'delivery_timetable_id'].includes(k) && typeof v === 'string') {
          return [k, timetableMap[v] ?? v];
        }
        return [k, replaceTimetableIds(v, timetableMap)];
      })
    );
  }
  return obj;
}

function preprocessJson(baseName, data, context = {}) {
  if (FILES_WITH_KEY_DELETE.has(baseName)) {
    let result = deleteFields(data, new Set(['created', 'creation_date', 'last_update', 'version', 'from']));
    result = deleteIdWhere(result, id => /\d{3},?$/.test(id));
    result = deleteIdWhere(result, id => /-/.test(id));
    result = deleteIdWhere(result, id => /endpoints_|items__/.test(id));
    if ((baseName === 'delivery_routes' || baseName === 'zones') && context.timetableMap) {
      result = replaceTimetableIds(result, context.timetableMap);
    }
    if (['delivery_configs', 'delivery_routes', 'execution_times', 'timetables'].includes(baseName) && result[baseName]) {
      result = { ...result, [baseName]: rekey(result[baseName], v => v?.name?.trim()) };
      result = deleteFields(result, new Set(['id']));
      result = trimNameFields(result);
    }
    if (baseName === 'sort_orders' && result.sort_orders)
      result = { ...result, sort_orders: rekey(result.sort_orders, v => {
        const dm = v?.value?.delivery_method;
        const sc = v?.value?.sales_channel;
        return dm && sc ? `${dm}_${sc}` : null;
      }) };
    if (baseName === 'zones') {
      result = deleteFields(result, new Set(['endpoint_ids', 'public_id']));
      result = deleteNestedId(result, 'routes');
    }
    return result;
  }
  if (baseName === 'modules') return deleteNestedId(data, 'module');
  if (baseName === 'request_couples') return deleteNestedId(data, 'value');
  if (baseName === 'workflows') return indexOrderedKeys(rekeyTypedArraysWithIndex(prefixTransitionKeys(sortStringArrays(data))));
  return data;
}

async function buildTimetableMap(filesArr) {
  const tf = filesArr.find((f) => f.name === 'timetables.json');
  if (!tf) return {};
  try {
    const data = JSON.parse(await tf.text());
    const timetables = data.timetables;
    if (!timetables || typeof timetables !== 'object') return {};
    const map = {};
    for (const [id, obj] of Object.entries(timetables)) {
      const name = obj?.name?.trim();
      if (name) map[id] = name;
    }
    return map;
  } catch (e) {
    console.warn('Failed to build timetable map:', e);
    return {};
  }
}

const toSentenceCase = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '—';

const ChevronIcon = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l4 4 4-4"/></svg>
);

function parseVersionDate(filename) {
  const match = filename.replace(/\.zip$/i, '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function formatVersionDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

const differ = new Differ({ detectCircular: true, maxDepth: Infinity, showModifications: true, arrayDiffMethod: 'lcs', recursiveEqual: true });

const moveDetectionOptions = { normalizeText: (text) => text.replace(/^"\d{4}_/, '"') };
const workflowDiffer = new Differ({ detectCircular: true, maxDepth: Infinity, showModifications: true, arrayDiffMethod: 'lcs' });

async function splitConfigurations(filesArr) {
  const result = [];
  for (const file of filesArr) {
    if (file.name !== 'configuration.json') {
      result.push(file);
      continue;
    }
    const data = JSON.parse(await file.text());
    const inner = data.configuration ?? data;
    const workflows = {};
    const rest = {};
    for (const [key, value] of Object.entries(inner)) {
      if (key.startsWith('workflows.') || key.startsWith('preparation.workflows')) {
        workflows[key] = value;
      } else {
        rest[key] = value;
      }
    }
    const restData = data.configuration ? { configuration: rest } : rest;
    result.push(new File([JSON.stringify(restData)], 'configuration.json', { type: 'application/json' }));
    if (Object.keys(workflows).length > 0) {
      result.push(new File([JSON.stringify(workflows)], 'workflows.json', { type: 'application/json' }));
    }
  }
  return result;
}

async function computeAllDiffs(leftFiles, rightFiles, fileNames) {
  const stats = {};
  const diffs = {};
  const beforeCtx = { timetableMap: await buildTimetableMap(leftFiles) };
  const afterCtx = { timetableMap: await buildTimetableMap(rightFiles) };
  for (const fileName of fileNames) {
    try {
      const baseName = fileName.replace(/\.json$/, '');
      const before = preprocessJson(baseName, JSON.parse(await leftFiles.find((f) => f.name === fileName).text()), beforeCtx);
      const after = preprocessJson(baseName, JSON.parse(await rightFiles.find((f) => f.name === fileName).text()), afterCtx);
      let result = (fileName === 'workflows.json' ? workflowDiffer : differ).diff(before, after);
      if (fileName === 'workflows.json') {
        result = stripIndexPrefixes(result);
        result = markMovedBlocks(result, moveDetectionOptions);
      }
      const [leftLines, rightLines] = result;
      const moves = leftLines.filter((l) => l.moved).length;
      stats[fileName] = {
        removes: leftLines.filter((l) => l.type === 'remove' && !l.moved).length,
        adds: rightLines.filter((l) => l.type === 'add' && !l.moved).length,
        modifies: leftLines.filter((l) => l.type === 'modify').length,
        moves,
      };
      diffs[fileName] = result;
    } catch (e) {
      console.warn(`Failed to diff ${fileName}:`, e);
      stats[fileName] = { removes: 0, adds: 0, modifies: 0, moves: 0 };
    }
  }
  return { stats, diffs };
}

function DiffTooltip({ context = 'environment' }) {
  return (
    <span className="tooltip-host">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="11" x2="12" y2="16"/>
        <line x1="12" y1="7" x2="12.01" y2="7"/>
      </svg>
      <span className="tooltip">
        <span className="stat-remove">Removed</span> / <span className="stat-add">Added</span> / <span className="stat-modify">Changed</span> / <span className="stat-move">Moved</span>
        {'\n\n'}
        {context === 'version' ? (<>
          <span className="stat-remove">Removed</span> : number of lines removed since the previous version{'\n'}
          <span className="stat-add">Added</span> : number of lines added since the previous version{'\n'}
          <span className="stat-modify">Changed</span> : number of lines changed since the previous version{'\n'}
          <span className="stat-move">Moved</span> : number of lines present in both versions but at a different position (workflow only)
        </>) : (<>
          <span className="stat-remove">Removed</span> : number of lines from the left {context} that are not in the right {context}{'\n'}
          <span className="stat-add">Added</span> : number of lines from the right {context} that are not in the left {context}{'\n'}
          <span className="stat-modify">Changed</span> : number of lines present in both {context}s but with a different value{'\n'}
          <span className="stat-move">Moved</span> : number of lines present in both {context}s but at a different position (workflow only)
        </>)}
      </span>
    </span>
  );
}

function FileSelector({ files, onSelect, selectedFile, diffStats, showHeader = true, showTooltip = true }) {
  const totals = files.reduce(
    (acc, file) => {
      const s = diffStats[file];
      if (s) {
        acc.removes += s.removes;
        acc.adds += s.adds;
        acc.modifies += s.modifies;
        acc.moves += s.moves ?? 0;
      }
      return acc;
    },
    { removes: 0, adds: 0, modifies: 0, moves: 0 }
  );

  const renderStats = (stats) => (
    <>
      <span className={stats.removes === 0 ? 'stat-zero' : 'stat-remove'}>{stats.removes}</span>
      {' / '}
      <span className={stats.adds === 0 ? 'stat-zero' : 'stat-add'}>{stats.adds}</span>
      {' / '}
      <span className={stats.modifies === 0 ? 'stat-zero' : 'stat-modify'}>{stats.modifies}</span>
      {stats.moves > 0 && (<>
        {' / '}
        <span className="stat-move">{stats.moves}</span>
      </>)}
    </>
  );

  return (
    <div className="file-selector">
      {showHeader && (
        <div className="file-section-header">
          <p className="section-label">Files</p>
          <div className="section-label diff-header">
            Diff
            {showTooltip && <DiffTooltip />}
          </div>
        </div>
      )}
      <div className="file-list-scroll">
        {files.map((file) => {
          const stats = diffStats[file];
          return (
            <button
              key={file}
              className={`file-row${file === selectedFile ? ' active' : ''}`}
              onClick={() => onSelect(file)}
            >
              <span className="file-name" title={file.replace(/\.json$/, '')}>{file.replace(/\.json$/, '')}</span>
              <span className="diff-stats">
                {stats && renderStats(stats)}
              </span>
            </button>
          );
        })}
      </div>
      {Object.keys(diffStats).length > 0 && (
        <div className="diff-totals">
          <span className="diff-totals-label">Total</span>
          <span className="diff-stats">{renderStats(totals)}</span>
        </div>
      )}
    </div>
  );
}

function WorkflowOutline({ entities, onJump }) {
  const [search, setSearch] = useState('');
  const [expandedEntities, setExpandedEntities] = useState(() => new Set());
  const [collapsedStates, setCollapsedStates] = useState(() => new Set());
  const toggleEntity = (id) => {
    setExpandedEntities(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleState = (id) => {
    setCollapsedStates(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const q = search.trim().toLowerCase();
  const matches = (s) => !q || s.toLowerCase().includes(q);
  const searchActive = q.length > 0;

  const visibleEntities = entities.filter(e => {
    if (matches(e.name)) return true;
    return e.states.some(s => matches(s.name) || s.transitions.some(t => matches(t.name)));
  });

  return (
    <div className="workflow-outline">
      <input
        type="search"
        className="workflow-outline__search"
        placeholder="Filter entities, states, and transitions"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="workflow-outline__tree">
        {visibleEntities.map(entity => {
          const eopen = searchActive || expandedEntities.has(entity.key);
          const visibleStates = entity.states.filter(s => matches(s.name) || s.transitions.some(t => matches(t.name)));
          return (
            <div key={entity.key} className="workflow-outline__group">
              <div className={`workflow-outline__node workflow-outline__node--entity${entity.hasDiff ? ' has-diff' : ''}`}>
                <button className="workflow-outline__chev" onClick={() => toggleEntity(entity.key)} title={eopen ? 'Collapse' : 'Expand'}>{eopen ? '▾' : '▸'}</button>
                <button className="workflow-outline__label" onClick={() => onJump(entity.startLine)} title={entity.key}>{entity.name}</button>
                {entity.hasDiff && <span className="workflow-outline__dot" />}
              </div>
              {eopen && visibleStates.map(state => {
                const sid = `${entity.key}>${state.key}`;
                const sopen = !collapsedStates.has(sid);
                const visibleTransitions = state.transitions.filter(t => matches(t.name));
                return (
                  <div key={state.key} className="workflow-outline__group workflow-outline__group--state">
                    <div className={`workflow-outline__node workflow-outline__node--state${state.hasDiff ? ' has-diff' : ''}`}>
                      <button className="workflow-outline__chev" onClick={() => toggleState(sid)}>{state.transitions.length > 0 ? (sopen ? '▾' : '▸') : ' '}</button>
                      <button className="workflow-outline__label" onClick={() => onJump(state.startLine)}>{state.name}</button>
                      {state.hasDiff && <span className="workflow-outline__dot" />}
                    </div>
                    {sopen && visibleTransitions.map(t => (
                      <div key={t.key} className={`workflow-outline__node workflow-outline__node--transition${t.hasDiff ? ' has-diff' : ''}`}>
                        <button className="workflow-outline__label" onClick={() => onJump(t.startLine)}>{t.name}</button>
                        {t.hasDiff && <span className="workflow-outline__dot" />}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        {visibleEntities.length === 0 && q && (
          <div className="workflow-outline__empty">No matches</div>
        )}
      </div>
    </div>
  );
}

async function readZipFile(file) {
  const zip = await JSZip.loadAsync(file);

  let environment = file.name.replace(/\.zip$/i, '');
  let siteId = null;
  let siteName = null;
  let datetime = null;
  let team = null;

  const infoFile = zip.file('export.info');
  if (infoFile) {
    try {
      const info = JSON.parse(await infoFile.async('text'));
      if (info.environment) environment = info.environment;
      if (info.site_id) siteId = info.site_id;
      if (info.site_name) siteName = info.site_name;
      if (info.date) datetime = info.date;
      if (info.team) team = info.team;
    } catch (e) { console.warn('Failed to parse export.info:', e); }
  }

  const jsonFiles = await Promise.all(
    Object.values(zip.files)
      .filter((f) => !f.dir && f.name.endsWith('.json'))
      .map(async (f) => {
        const content = await f.async('blob');
        return new File([content], f.name, { type: 'application/json' });
      })
  );

  return { environment, siteId, siteName, datetime, team, files: jsonFiles };
}

async function loadAllVersions() {
  const base = import.meta.env.BASE_URL + 'versions/';
  const manifest = await fetch(base + 'manifest.json').then(r => r.json());
  const versions = await Promise.all(manifest.map(async (name) => {
    const resp = await fetch(base + name);
    const blob = await resp.blob();
    const file = new File([blob], name, { type: 'application/zip' });
    const { files, siteId, siteName, environment, datetime, team } = await readZipFile(file);
    const splitFiles = await splitConfigurations(files);
    const date = parseVersionDate(name);
    const rawTime = datetime ? datetime.split(' ')[1] ?? null : null;
    const time = rawTime ? rawTime.split(':').slice(0, 2).join(':') : null;
    return { date, dateLabel: formatVersionDate(date), filename: name, files: splitFiles, siteId, siteName, environment, time, team };
  }));
  versions.sort((a, b) => b.date - a.date);
  return versions;
}

function getAncestorKeys(lines, changedIdx) {
  const keyRegex = /"([^"]+)"\s*:/;
  const keys = [];
  // Include the changed line's own key
  const ownMatch = lines[changedIdx].text.match(keyRegex);
  if (ownMatch) keys.push(ownMatch[1]);
  // Walk backwards using `level` to find parent keys
  let targetLevel = lines[changedIdx].level;
  for (let j = changedIdx - 1; j >= 0; j--) {
    const line = lines[j];
    if (line.level < targetLevel) {
      const match = line.text.match(keyRegex);
      if (match) keys.push(match[1]);
      targetLevel = line.level;
      if (targetLevel <= 1) break;
    }
  }
  return keys;
}

function collectSearchTexts(lines, side) {
  const byType = { remove: [], add: [], modify: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const type = side === 'left'
      ? (line.type === 'remove' ? 'remove' : line.type === 'modify' ? 'modify' : null)
      : (line.type === 'add' ? 'add' : line.type === 'modify' ? 'modify' : null);
    if (!type) continue;
    const ancestors = getAncestorKeys(lines, i);
    const text = line.text + ' ' + ancestors.join(' ');
    byType[type].push(text);
  }
  return byType;
}

async function computeConsecutiveStats(versions) {
  const pairStats = {};
  const pairDiffTexts = {};
  for (let i = 0; i < versions.length - 1; i++) {
    const newer = versions[i];
    const older = versions[i + 1];
    const newerNames = newer.files.map(f => f.name);
    const olderNames = older.files.map(f => f.name);
    const common = olderNames.filter(n => newerNames.includes(n)).sort();
    const { stats, diffs } = await computeAllDiffs(older.files, newer.files, common);
    const totals = Object.values(stats).reduce(
      (acc, s) => ({ removes: acc.removes + s.removes, adds: acc.adds + s.adds, modifies: acc.modifies + s.modifies }),
      { removes: 0, adds: 0, modifies: 0 }
    );
    pairStats[newer.filename] = totals;
    // Collect changed line texts for search by type (with ancestor keys)
    const allByType = { remove: [], add: [], modify: [] };
    const fileByType = {};
    for (const [fileName, [left, right]] of Object.entries(diffs)) {
      const leftTexts = collectSearchTexts(left, 'left');
      const rightTexts = collectSearchTexts(right, 'right');
      const fb = {
        remove: [...leftTexts.remove].join('\n').toLowerCase(),
        add: [...rightTexts.add].join('\n').toLowerCase(),
        modify: [...leftTexts.modify, ...rightTexts.modify].join('\n').toLowerCase(),
      };
      fileByType[fileName] = fb;
      allByType.remove.push(...leftTexts.remove);
      allByType.add.push(...rightTexts.add);
      allByType.modify.push(...leftTexts.modify, ...rightTexts.modify);
    }
    pairDiffTexts[newer.filename] = {
      remove: allByType.remove.join('\n').toLowerCase(),
      add: allByType.add.join('\n').toLowerCase(),
      modify: allByType.modify.join('\n').toLowerCase(),
      files: fileByType,
    };
  }
  return { pairStats, pairDiffTexts };
}

function FolderDropZone({ onFoldersDrop, leftEnvironment, rightEnvironment }) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files)
      .filter((f) => f.name.endsWith('.zip'))
      .slice(0, 2);

    if (files.length === 0) return;

    const results = await Promise.all(files.map(readZipFile));
    onFoldersDrop(results);
  };

  const isFilled = !!(leftEnvironment || rightEnvironment);

  return (
    <div
      className={`folder-drop-zone folder-drop-zone--large${isDragging ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <svg className="drop-zone-border" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0.5" y="0.5" width="99" height="99" rx="1.8" ry="4.5"
          fill="none"
          stroke={isDragging ? '#6366f1' : '#3e4049'}
          strokeWidth="1"
          strokeDasharray="10 14"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {isFilled ? (
        <div className="drop-slots">
          <span className="slot-value">{toSentenceCase(leftEnvironment)}</span>
          <span className="slot-value">{toSentenceCase(rightEnvironment)}</span>
        </div>
      ) : (
        <span className="drop-icon">📁</span>
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState('home');
  const [hideUnchangedLines, setHideUnchangedLines] = useState(false);
  const [isDiffPending, startDiffTransition] = useTransition();
  const toggleHideUnchanged = (checked) => startDiffTransition(() => setHideUnchangedLines(checked));
  const [leftFiles, setLeftFiles] = useState([]);
  const [leftEnvironment, setLeftEnvironment] = useState(null);
  const [leftSiteId, setLeftSiteId] = useState(null);
  const [rightFiles, setRightFiles] = useState([]);
  const [rightEnvironment, setRightEnvironment] = useState(null);
  const [rightSiteId, setRightSiteId] = useState(null);
  const [commonFiles, setCommonFiles] = useState([]);
  const [diffStats, setDiffStats] = useState({});
  const [allDiffs, setAllDiffs] = useState({});
  const [diff, setDiff] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [scrollMarks, setScrollMarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);

  // History state
  const [historyEnv, setHistoryEnv] = useState('');
  const [envDropdownOpen, setEnvDropdownOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [historySearchTypes, setHistorySearchTypes] = useState(new Set(['remove', 'add', 'modify']));
  const [historyDiffTexts, setHistoryDiffTexts] = useState({});
  const [historyVersions, setHistoryVersions] = useState([]);
  const [historyPairStats, setHistoryPairStats] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySelectedPair, setHistorySelectedPair] = useState(null);
  const [historyPairIsCtrl, setHistoryPairIsCtrl] = useState(false);
  const [historyCtrlFirst, setHistoryCtrlFirst] = useState(null);
  const [historyCommonFiles, setHistoryCommonFiles] = useState([]);
  const [historyFileStats, setHistoryFileStats] = useState({});
  const [historyAllDiffs, setHistoryAllDiffs] = useState({});
  const [historySelectedFile, setHistorySelectedFile] = useState(null);
  const [historyPairFileTexts, setHistoryPairFileTexts] = useState({});
  const [historyDiff, setHistoryDiff] = useState(null);
  const [historyDiffLoading, setHistoryDiffLoading] = useState(false);

  const workflowOutline = useMemo(() => {
    if (selectedFile !== 'workflows.json' || !diff) return null;
    return buildWorkflowOutline(diff);
  }, [diff, selectedFile]);

  const handleWorkflowJump = (lineIdx) => {
    const container = contentRef.current;
    if (!container) return;
    const targetLineNumber = diff?.[0]?.[lineIdx]?.lineNumber ?? lineIdx + 1;
    const trs = container.querySelectorAll('tr');
    let target = null;
    for (const tr of trs) {
      const ln = tr.querySelector('td.line-number');
      const num = ln ? Number(ln.textContent) : NaN;
      if (!Number.isNaN(num) && num >= targetLineNumber) { target = tr; break; }
    }
    if (!target) target = trs[lineIdx] ?? trs[trs.length - 1];
    if (target) container.scrollTo({ top: target.offsetTop - 8, behavior: 'instant' });
  };

  const hideUnchangedConfig = useMemo(() => hideUnchangedLines ? {
    expandLineRenderer: ({ hasLinesBefore, hasLinesAfter, onExpandBefore, onExpandAfter }) => (
      <div>
        {hasLinesBefore && <button onClick={() => onExpandBefore(20)}>↑ Show 20 lines before</button>}
        {hasLinesAfter && <button onClick={() => onExpandAfter(20)}>↓ Show 20 lines after</button>}
      </div>
    ),
  } : false, [hideUnchangedLines]);

  const handleSwap = () => {
    startDiffTransition(() => {
      setLeftFiles(rightFiles);
      setRightFiles(leftFiles);
      setLeftEnvironment(rightEnvironment);
      setLeftSiteId(rightSiteId);
      setRightEnvironment(leftEnvironment);
      setRightSiteId(leftSiteId);
    });
  };

  const handleFoldersDrop = (folders) => {
    if (folders.length >= 2) {
      const a = folders[0];
      const b = folders[1];
      setLeftFiles(a.files);
      setLeftEnvironment(a.environment);
      setLeftSiteId(a.siteId);
      setRightFiles(b.files);
      setRightEnvironment(b.environment);
      setRightSiteId(b.siteId);
    } else if (folders.length === 1) {
      if (!leftEnvironment) {
        setLeftFiles(folders[0].files);
        setLeftEnvironment(folders[0].environment);
        setLeftSiteId(folders[0].siteId);
        } else {
        setRightFiles(folders[0].files);
        setRightEnvironment(folders[0].environment);
        setRightSiteId(folders[0].siteId);
      }
    }
  };

  useEffect(() => {
    if (leftEnvironment && rightEnvironment) {
      setView('diff');
    }
  }, [leftEnvironment, rightEnvironment]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    if (!envDropdownOpen) return;
    const close = (e) => { if (!e.target.closest('.pill-dropdown')) setEnvDropdownOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [envDropdownOpen]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(historySearch), 600);
    return () => clearTimeout(id);
  }, [historySearch]);

  const filteredHistoryDiff = useMemo(() => {
    if (!historyDiff) return null;
    const keyword = debouncedSearch.trim().toLowerCase();
    const hasFilter = keyword || historySearchTypes.size < 3;
    if (!hasFilter) return historyDiff;
    const [left, right] = historyDiff;

    const lineMatchesKeyword = (lines, idx, kw) => {
      if (lines[idx].text.toLowerCase().includes(kw)) return true;
      const ancestors = getAncestorKeys(lines, idx);
      return ancestors.some(k => k.toLowerCase().includes(kw));
    };

    const filterLine = (line, i) => {
      if (line.type === 'equal') return line;
      const typeMatch = (line.type === 'remove' && historySearchTypes.has('remove'))
        || (line.type === 'add' && historySearchTypes.has('add'))
        || (line.type === 'modify' && historySearchTypes.has('modify'));
      if (!typeMatch) return { ...line, type: 'equal' };
      if (keyword && !lineMatchesKeyword(left, i, keyword) && !lineMatchesKeyword(right, i, keyword)) {
        return { ...line, type: 'equal' };
      }
      return line;
    };
    return [left.map(filterLine), right.map(filterLine)];
  }, [historyDiff, debouncedSearch, historySearchTypes]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let rafPending = false;
    const update = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= 0) return;
      vp.style.top = `${(scrollTop / scrollHeight) * 100}%`;
      vp.style.height = `${(clientHeight / scrollHeight) * 100}%`;
    };
    const scheduleUpdate = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { update(); rafPending = false; });
    };
    update();
    el.addEventListener('scroll', scheduleUpdate);
    const ro = new ResizeObserver(scheduleUpdate);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', scheduleUpdate); ro.disconnect(); };
  }, [diff, historyDiff, filteredHistoryDiff, hideUnchangedLines, debouncedSearch, historySearchTypes, view, scrollMarks]);

  useEffect(() => {
    const activeDiff = diff || historyDiff;
    if (!activeDiff) { setScrollMarks([]); return; }
    const computeMarks = () => {
      const container = contentRef.current;
      if (!container) return;
      const scrollHeight = container.scrollHeight;
      const cells = container.querySelectorAll('.line-remove, .line-add, .line-modify, .line-moved');
      const seen = new Set();
      const marks = [];
      for (const cell of cells) {
        const tr = cell.closest('tr');
        if (!tr || seen.has(tr)) continue;
        seen.add(tr);
        const type = cell.classList.contains('line-moved') ? 'moved'
                   : cell.classList.contains('line-remove') ? 'remove'
                   : cell.classList.contains('line-add') ? 'add'
                   : 'modify';
        let top = 0;
        let node = tr;
        while (node && node !== container) {
          top += node.offsetTop;
          node = node.offsetParent;
        }
        marks.push({ type, position: top / scrollHeight });
      }
      setScrollMarks(marks);
    };
    let rafId;
    const timer = setTimeout(() => { rafId = requestAnimationFrame(computeMarks); }, 50);
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(computeMarks);
    });
    const container = contentRef.current;
    if (container) mo.observe(container, { childList: true, subtree: true });
    return () => { clearTimeout(timer); cancelAnimationFrame(rafId); mo.disconnect(); };
  }, [diff, historyDiff, hideUnchangedLines, debouncedSearch, historySearchTypes]);

  useEffect(() => {
    const activeFile = selectedFile ?? historySelectedFile;
    if (activeFile !== 'workflows.json') return;
    const container = contentRef.current;
    if (!container) return;
    const apply = () => {
      const trs = container.querySelectorAll('tr');
      const leftScope = { inPrep: false, indent: -1 };
      const rightScope = { inPrep: false, indent: -1 };
      const handlePre = (pre, scope) => {
        if (!pre || pre.textContent === '') return;
        const indent = pre.firstChild?.nodeType === Node.TEXT_NODE
          ? pre.firstChild.textContent.length
          : 0;
        if (scope.inPrep && indent <= scope.indent) scope.inPrep = false;
        const keySpan = pre.querySelector('.key');
        if (!keySpan) return;
        keySpan.classList.remove('key--transition', 'key--entity');
        const txt = keySpan.textContent ?? '';
        if (txt.includes('/')) {
          keySpan.classList.add('key--transition');
        } else if (indent === 4 && txt.startsWith('"workflows.')) {
          keySpan.classList.add('key--entity');
        } else if (indent === 4 && txt.startsWith('"preparation.workflows.')) {
          scope.inPrep = true;
          scope.indent = 4;
        } else if (scope.inPrep && indent === 16) {
          keySpan.classList.add('key--entity');
        }
      };
      for (const tr of trs) {
        const pres = tr.querySelectorAll('pre');
        handlePre(pres[0], leftScope);
        handlePre(pres[1], rightScope);
      }
    };
    let rafId;
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(apply);
    };
    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(rafId); mo.disconnect(); };
  }, [selectedFile, historySelectedFile, diff, historyDiff, hideUnchangedLines]);

  useEffect(() => {
    if (leftFiles.length > 0 && rightFiles.length > 0) {
      Promise.all([splitConfigurations(leftFiles), splitConfigurations(rightFiles)]).then(([splitLeft, splitRight]) => {
      const leftFileNames = splitLeft.map((file) => file.name);
      const rightFileNames = splitRight.map((file) => file.name);
      const common = leftFileNames.filter((file) => rightFileNames.includes(file)).sort();
      setCommonFiles(common);

      computeAllDiffs(splitLeft, splitRight, common).then(({ stats, diffs }) => {
        setDiffStats(stats);
        setAllDiffs(diffs);
        setDiff(null);
        setSelectedFile(null);
      });
      });
    }
  }, [leftFiles, rightFiles]);

  useEffect(() => {
    if (view === 'history' && historyVersions.length === 0) {
      setHistoryLoading(true);
      loadAllVersions().then(async (versions) => {
        setHistoryVersions(versions);
        const { pairStats, pairDiffTexts } = await computeConsecutiveStats(versions);
        setHistoryPairStats(pairStats);
        setHistoryDiffTexts(pairDiffTexts);
        setHistoryLoading(false);
      });
    }
  }, [view]);

  const loadHistoryPair = async (older, newer) => {
    setHistorySelectedPair([older, newer]);
    setHistorySelectedFile(null);
    setHistoryDiff(null);
    setHistoryDiffLoading(true);
    const olderNames = older.files.map(f => f.name);
    const newerNames = newer.files.map(f => f.name);
    const common = olderNames.filter(n => newerNames.includes(n)).sort();
    setHistoryCommonFiles(common);
    const { stats, diffs } = await computeAllDiffs(older.files, newer.files, common);
    setHistoryFileStats(stats);
    setHistoryAllDiffs(diffs);
    const fileByType = {};
    for (const [fileName, [left, right]] of Object.entries(diffs)) {
      const leftTexts = collectSearchTexts(left, 'left');
      const rightTexts = collectSearchTexts(right, 'right');
      fileByType[fileName] = {
        remove: leftTexts.remove.join('\n').toLowerCase(),
        add: rightTexts.add.join('\n').toLowerCase(),
        modify: [...leftTexts.modify, ...rightTexts.modify].join('\n').toLowerCase(),
      };
    }
    setHistoryPairFileTexts(fileByType);
    setHistoryDiffLoading(false);
  };

  const handleVersionClick = async (version, event) => {
    if (event.ctrlKey || event.metaKey) {
      if (!historyCtrlFirst) {
        setHistoryCtrlFirst(version);
        return;
      }
      const [older, newer] = [historyCtrlFirst, version].sort((a, b) => a.date - b.date);
      setHistoryCtrlFirst(null);
      setHistoryPairIsCtrl(true);
      await loadHistoryPair(older, newer);
    } else {
      setHistoryCtrlFirst(null);
      setHistoryPairIsCtrl(false);
      const idx = historyVersions.findIndex(v => v.filename === version.filename);
      if (idx < historyVersions.length - 1) {
        const older = historyVersions[idx + 1];
        await loadHistoryPair(older, version);
      }
    }
  };

  const handleHistoryFileSelect = (fileName) => {
    setHistorySelectedFile(fileName);
    setHistoryDiff(null);
    setHistoryDiffLoading(true);
    contentRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setHistoryDiff(historyAllDiffs[fileName] ?? null);
        setHistoryDiffLoading(false);
      });
    });
  };

  const handleScrollMapMouseDown = (e) => {
    e.preventDefault();
    const map = e.currentTarget;
    const scrollTo = (clientY) => {
      const rect = map.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      contentRef.current?.scrollTo({ top: ratio * contentRef.current.scrollHeight });
    };
    scrollTo(e.clientY);
    const onMove = (ev) => scrollTo(ev.clientY);
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleGoHome = () => {
    setView('home');
    setLeftFiles([]);
    setLeftEnvironment(null);
    setLeftSiteId(null);
    setRightFiles([]);
    setRightEnvironment(null);
    setRightSiteId(null);
    setCommonFiles([]);
    setDiffStats({});
    setAllDiffs({});
    setDiff(null);
    setSelectedFile(null);
    setScrollMarks([]);
    setHideUnchangedLines(false);
    // Reset history selection but keep cached versions
    setHistorySelectedPair(null);
    setHistoryPairIsCtrl(false);
    setHistoryCtrlFirst(null);
    setHistoryCommonFiles([]);
    setHistoryFileStats({});
    setHistoryAllDiffs({});
    setHistorySelectedFile(null);
    setHistoryDiff(null);
    setHistoryPairFileTexts({});
    setHistorySearch('');
    setHistorySearchTypes(new Set(['remove', 'add', 'modify']));
  };

  const matchesSearch = (textsObj, keyword) => {
    if (!keyword || !textsObj) return true;
    const k = keyword.toLowerCase();
    for (const type of historySearchTypes) {
      if (textsObj[type]?.includes(k)) return true;
    }
    return false;
  };

  const handleFileSelect = (fileName) => {
    setSelectedFile(fileName);
    setDiff(null);
    setLoading(true);
    contentRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setDiff(allDiffs[fileName] ?? null);
        setLoading(false);
      });
    });
  };

  if (view === 'home') {
    return (
      <div className="home-page">
        <h1 className="home-title">
          <svg className="home-title-icon" viewBox="0 0 5 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 5H8C6.89543 5 6 5.89543 6 7V9.43845C6 10.3562 5.37541 11.1561 4.48507 11.3787L2.97014 11.7575C2.71765 11.8206 2.71765 12.1794 2.97014 12.2425L4.48507 12.6213C5.37541 12.8439 6 13.6438 6 14.5616V19H10" stroke="#ffffff" strokeWidth="2"/>
          </svg>
          Confdiff
          <svg className="home-title-icon" viewBox="8 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 19H16C17.1046 19 18 18.1046 18 17V14.5616C18 13.6438 18.6246 12.8439 19.5149 12.6213L21.0299 12.2425C21.2823 12.1794 21.2823 11.8206 21.0299 11.7575L19.5149 11.3787C18.6246 11.1561 18 10.3562 18 9.43845V5H14" stroke="#ffffff" strokeWidth="2"/>
          </svg>
        </h1>
        <p className="home-motto">Compare configurations across environments and versions</p>
        <div className="home-cards">
          <div className="home-card">
            <h2 className="home-card-title">Environment diff</h2>
            <p className="home-card-desc">Drop two zip files to compare the configuration between two environments</p>
            <FolderDropZone
              onFoldersDrop={handleFoldersDrop}
              leftEnvironment={leftEnvironment}
              rightEnvironment={rightEnvironment}
            />
          </div>
          <div className="home-card">
            <h2 className="home-card-title">Version diff</h2>
            <p className="home-card-desc">Browse the version history of an environment</p>
            <div className="home-card-action">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="4" x2="6" y2="20"/>
                <circle cx="6" cy="4" r="2" fill="#1e1e1e"/>
                <circle cx="6" cy="12" r="2" fill="#1e1e1e"/>
                <circle cx="6" cy="20" r="2" fill="#1e1e1e"/>
                <line x1="10" y1="4" x2="20" y2="4"/>
                <line x1="10" y1="12" x2="18" y2="12"/>
                <line x1="10" y1="20" x2="16" y2="20"/>
              </svg>
              <button className="history-btn" onClick={() => setView('history')}>Go to version diff</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'history') {
    const activeDiff = filteredHistoryDiff;
    const hasFilteredChanges = !activeDiff || activeDiff[0].some(l => l.type !== 'equal') || activeDiff[1].some(l => l.type !== 'equal');
    const hasOriginalChanges = !historyDiff || historyDiff[0].some(l => l.type !== 'equal') || historyDiff[1].some(l => l.type !== 'equal');
    const isFilterActive = debouncedSearch.trim() || historySearchTypes.size < 3;
    return (
      <div className="diff-layout">
        <div className="sidebar history-sidebar">
          <button className="home-btn" onClick={handleGoHome} title="Go to homepage"><svg className="home-btn-icon" viewBox="0 0 24 24" fill="none"><path d="M14 19H16C17.1046 19 18 18.1046 18 17V14.5616C18 13.6438 18.6246 12.8439 19.5149 12.6213L21.0299 12.2425C21.2823 12.1794 21.2823 11.8206 21.0299 11.7575L19.5149 11.3787C18.6246 11.1561 18 10.3562 18 9.43845V5H14" stroke="currentColor" strokeWidth="2"/><path d="M10 5H8C6.89543 5 6 5.89543 6 7V9.43845C6 10.3562 5.37541 11.1561 4.48507 11.3787L2.97014 11.7575C2.71765 11.8206 2.71765 12.1794 2.97014 12.2425L4.48507 12.6213C5.37541 12.8439 6 13.6438 6 14.5616V19H10" stroke="currentColor" strokeWidth="2"/></svg>Confdiff</button>
          <p className="sidebar-section-label">Site</p>
          <div className="site-env-row">
            {historyVersions.length > 0 && historyVersions[0].siteId && (
              <div className="pill-dropdown">
                <button className="pill-dropdown-toggle" disabled>
                  <span className="pill-dropdown-label">ID</span>
                  <span className="pill-dropdown-value">{historyVersions[0].siteId}</span>
                  <ChevronIcon />
                </button>
              </div>
            )}
            <div className="pill-dropdown">
              <button className="pill-dropdown-toggle" onClick={() => setEnvDropdownOpen(!envDropdownOpen)}>
                <span className="pill-dropdown-label">Env</span>
                <span className="pill-dropdown-value">{historyEnv || 'Select'}</span>
                <ChevronIcon />
              </button>
              {envDropdownOpen && (
                <div className="pill-dropdown-menu">
                  {['Internal', 'Qualif', 'Staging', 'Prod'].map(env => (
                    <button
                      key={env}
                      className={`pill-dropdown-item${historyEnv === env ? ' active' : ''}`}
                      onClick={() => { setHistoryEnv(env); setEnvDropdownOpen(false); }}
                    >{env}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {historyEnv && (<>
          <p className="sidebar-section-label">Search</p>
          <div className="history-search-wrapper">
            <svg className="history-search-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="10" cy="10" r="7"/><line x1="15" y1="15" x2="21" y2="21"/></svg>
            <input
              className="history-search"
              type="text"
              spellCheck={false}
              placeholder="Find a diff by field name or value"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
            {historySearch && (
              <button className="history-search-clear" onClick={() => { setHistorySearch(''); setDebouncedSearch(''); }} title="Clear search">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708z"/></svg>
              </button>
            )}
          </div>
          <div className="search-type-filters">
            {[['remove', 'Removed'], ['add', 'Added'], ['modify', 'Changed']].map(([type, label]) => (
              <button
                key={type}
                className={`search-type-btn search-type-btn--${type}${historySearchTypes.has(type) ? ' active' : ''}`}
                onClick={() => setHistorySearchTypes(prev => {
                  const next = new Set(prev);
                  if (next.has(type)) { if (next.size > 1) next.delete(type); } else next.add(type);
                  return next;
                })}
              >{label}</button>
            ))}
          </div>
          <div className="file-section-header">
            <p className="section-label">Versions</p>
            <div className="section-label diff-header">
              Diff
              <DiffTooltip context="version" />
            </div>
          </div>
          {historyLoading ? (
            <div className="empty-state"><div className="loading-spinner" /><p className="empty-state-body">Loading versions...</p></div>
          ) : historySearch !== debouncedSearch ? (
            <div className="search-loading"><div className="loading-spinner" /><span>Searching...</span></div>
          ) : (
            <div className="version-list">
              {historyVersions.reduce((acc, version, idx) => {
                if (debouncedSearch.trim() && !matchesSearch(historyDiffTexts[version.filename], debouncedSearch.toLowerCase())) return acc;
                const originalIdx = idx;
                const isCtrlSelected = historyCtrlFirst?.filename === version.filename;
                const isPairSelected = !historyCtrlFirst && (
                  historyPairIsCtrl
                    ? historySelectedPair?.some(v => v.filename === version.filename)
                    : historySelectedPair?.[1]?.filename === version.filename
                );
                const stats = historyPairStats[version.filename];
                const isOldest = originalIdx === historyVersions.length - 1;
                acc.push(
                  <div key={version.filename} className="version-row-wrapper">
                  {originalIdx === 0 && <span className="version-section-label">Current</span>}
                  {originalIdx === 1 && <span className="version-section-label version-section-label--previous">Previous</span>}
                  <button
                    className={`version-row${isPairSelected ? ' active' : ''}${isCtrlSelected ? ' ctrl-selected' : ''}`}
                    onClick={(e) => handleVersionClick(version, e)}
                    disabled={isOldest && !historyCtrlFirst}
                    title={isOldest && !historyCtrlFirst ? 'No previous version to compare' : undefined}
                  >
                    <span className="version-info">
                      <span className="version-datetime">{version.dateLabel}{version.time ? ` ${version.time}` : ''}</span>
                      {version.team && <span className={`team-badge team-badge--${version.team.toLowerCase()}`}>{toSentenceCase(version.team)}</span>}
                    </span>
                    {stats && (
                      <span className="diff-stats">
                        <span className={stats.removes === 0 ? 'stat-zero' : 'stat-remove'}>{stats.removes}</span>
                        {' / '}
                        <span className={stats.adds === 0 ? 'stat-zero' : 'stat-add'}>{stats.adds}</span>
                        {' / '}
                        <span className={stats.modifies === 0 ? 'stat-zero' : 'stat-modify'}>{stats.modifies}</span>
                      </span>
                    )}
                  </button>
                  </div>
                );
                return acc;
              }, [])}
            </div>
          )}
          </>)}
        </div>
        {historySelectedPair && (
          <div className="history-files-pane">
            <div className="history-files-header">
              <div className="history-files-dates">
                <div className="history-date-row">
                  <span className="history-date-label">From</span>
                  <span className="history-date-value">{historySelectedPair[0].dateLabel} {historySelectedPair[0].time ?? ''}</span>
                </div>
                <div className="history-date-row">
                  <span className="history-date-label">To</span>
                  <span className="history-date-value">{historySelectedPair[1].dateLabel} {historySelectedPair[1].time ?? ''}</span>
                </div>
              </div>
            </div>
            <label className="unchanged-lines-label">
              <span className="toggle">
                <input type="checkbox" checked={hideUnchangedLines} onChange={(e) => toggleHideUnchanged(e.target.checked)} />
                <span className="toggle-slider" />
              </span>
              Only show diff
            </label>
            {historySearch !== debouncedSearch ? (
              <div className="search-loading"><div className="loading-spinner" /><span>Searching...</span></div>
            ) : (
              <FileSelector
                files={debouncedSearch.trim() ? historyCommonFiles.filter(f => matchesSearch(historyPairFileTexts[f], debouncedSearch)) : historyCommonFiles}
                onSelect={handleHistoryFileSelect}
                selectedFile={historySelectedFile}
                diffStats={historyFileStats}
                showTooltip={false}
              />
            )}
          </div>
        )}
        <div ref={contentRef} className={`diff-content${scrollMarks.length > 0 ? ' diff-content--with-map' : ''}`}>
          <div className="diff-pane">
            {historyDiffLoading || isDiffPending ? (
              <div className="empty-state"><div className="loading-spinner" /><p className="empty-state-body">Loading diff...</p></div>
            ) : activeDiff && (!hasFilteredChanges && isFilterActive && hasOriginalChanges) ? (
              <div className="empty-state">
                <p className="empty-state-title">No change detected</p>
                <p className="empty-state-body">No changes match the current filters for this file.</p>
              </div>
            ) : activeDiff ? (
              <Viewer
                key={`${hideUnchangedLines}-${debouncedSearch}-${[...historySearchTypes].join()}`}
                diff={activeDiff}
                indent={4}
                lineNumbers={true}
                syntaxHighlight={{ theme: 'monokai' }}
                hideUnchangedLines={hideUnchangedConfig}
                highlightInlineDiff={true}
                inlineDiffOptions={{ mode: 'word', wordSeparator: ' ' }}
                highlightMoved={moveDetectionOptions}
              />
            ) : (
              <div className="empty-state">
                <svg className="empty-state-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  {historySelectedPair ? (<>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </>) : (<>
                    <line x1="6" y1="4" x2="6" y2="20"/>
                    <circle cx="6" cy="4" r="2" fill="#1e1e1e"/><circle cx="6" cy="12" r="2" fill="#1e1e1e"/><circle cx="6" cy="20" r="2" fill="#1e1e1e"/>
                    <line x1="10" y1="4" x2="20" y2="4"/><line x1="10" y1="12" x2="18" y2="12"/><line x1="10" y1="20" x2="16" y2="20"/>
                  </>)}
                </svg>
                <p className="empty-state-title">{historySelectedPair ? 'Select a file to compare' : 'Select a version'}</p>
                <div className="empty-state-body">
                  {historySelectedPair
                    ? 'Click on any file to see the diff between the two versions'
                    : <ul className="empty-state-features">
                        <li>Click on a version to compare it with the previous one</li>
                        <li>CTRL + click on two versions to compare them</li>
                        <li>Use the search bar to find diffs by field name or value</li>
                        <li>Toggle the <span style={{color:'#f87171'}}>Removed</span> / <span style={{color:'#4ade80'}}>Added</span> / <span style={{color:'#facc15'}}>Changed</span> filters to narrow results</li>
                      </ul>}
                </div>
              </div>
            )}
          </div>
          {scrollMarks.length > 0 && (
            <div className="scroll-map" onMouseDown={handleScrollMapMouseDown}>
              <div ref={viewportRef} className="scroll-map-viewport" />
              {scrollMarks.map((mark, i) => (
                <div key={i} className={`scroll-mark scroll-mark--${mark.type}`} style={{ top: `${mark.position * 100}%` }} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="diff-layout">
      <div className="sidebar">
        <button className="home-btn" onClick={handleGoHome} title="Back to home"><svg className="home-btn-icon" viewBox="0 0 24 24" fill="none"><path d="M14 19H16C17.1046 19 18 18.1046 18 17V14.5616C18 13.6438 18.6246 12.8439 19.5149 12.6213L21.0299 12.2425C21.2823 12.1794 21.2823 11.8206 21.0299 11.7575L19.5149 11.3787C18.6246 11.1561 18 10.3562 18 9.43845V5H14" stroke="currentColor" strokeWidth="2"/><path d="M10 5H8C6.89543 5 6 5.89543 6 7V9.43845C6 10.3562 5.37541 11.1561 4.48507 11.3787L2.97014 11.7575C2.71765 11.8206 2.71765 12.1794 2.97014 12.2425L4.48507 12.6213C5.37541 12.8439 6 13.6438 6 14.5616V19H10" stroke="currentColor" strokeWidth="2"/></svg>Confdiff</button>
        <div className="site-env-row">
          {(leftSiteId || rightSiteId) && (
            <div className="env-pill-dropdown">
              <button className="pill-dropdown-toggle" disabled>
                <span className="pill-dropdown-label">ID</span>
                <span className="pill-dropdown-value">{leftSiteId ?? rightSiteId}</span>
                <ChevronIcon />
              </button>
            </div>
          )}
          {leftEnvironment && rightEnvironment && (
            <div className="env-swap-row">
              <span className={`env-pill env-pill--${leftEnvironment?.toLowerCase()}`}>{toSentenceCase(leftEnvironment)}</span>
              <button className="swap-btn" onClick={handleSwap} title="Swap environments">⇄</button>
              <span className={`env-pill env-pill--${rightEnvironment?.toLowerCase()}`}>{toSentenceCase(rightEnvironment)}</span>
            </div>
          )}
        </div>
        <label className="unchanged-lines-label">
          <span className="toggle">
            <input
              type="checkbox"
              checked={hideUnchangedLines}
              onChange={(e) => toggleHideUnchanged(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
          Only show diff
        </label>
        <FileSelector files={commonFiles} onSelect={handleFileSelect} selectedFile={selectedFile} diffStats={diffStats} />
        {workflowOutline && workflowOutline.length > 0 && (
          hideUnchangedLines ? (
            <div className="workflow-outline workflow-outline--disabled">
              <p className="workflow-outline__message">Turn off the <strong>Only show diff</strong> option to use the search feature</p>
            </div>
          ) : (
            <WorkflowOutline entities={workflowOutline} onJump={handleWorkflowJump} />
          )
        )}
      </div>
      <div ref={contentRef} className={`diff-content${scrollMarks.length > 0 ? ' diff-content--with-map' : ''}`}>
        <div className="diff-pane">
          {loading || isDiffPending ? (
            <div className="empty-state">
              <div className="loading-spinner" />
              <p className="empty-state-body">Loading diff...</p>
            </div>
          ) : diff ? (
            <Viewer
              key={hideUnchangedLines}
              diff={diff}
              indent={4}
              lineNumbers={true}
              syntaxHighlight={{ theme: 'monokai' }}
              hideUnchangedLines={hideUnchangedConfig}
              highlightInlineDiff={true}
              inlineDiffOptions={{ mode: 'word', wordSeparator: ' ' }}
              highlightMoved={moveDetectionOptions}
            />
          ) : (
            <div className="empty-state">
              <svg className="empty-state-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <p className="empty-state-title">Select a file to compare</p>
              <p className="empty-state-body">
                Click on any file from the list on the left to see a side-by-side diff between the <strong>{toSentenceCase(leftEnvironment)}</strong> and <strong>{toSentenceCase(rightEnvironment)}</strong> environments
              </p>
              <p className="empty-state-body">
                The numbers next to each file show how many lines were <span className="stat-remove">removed</span>, <span className="stat-add">added</span>, or <span className="stat-modify">changed</span> between the two environments
              </p>
            </div>
          )}
        </div>
        {scrollMarks.length > 0 && (
          <div
            className="scroll-map"
            onMouseDown={handleScrollMapMouseDown}
          >
            <div ref={viewportRef} className="scroll-map-viewport" />
            {scrollMarks.map((mark, i) => (
              <div key={i} className={`scroll-mark scroll-mark--${mark.type}`} style={{ top: `${mark.position * 100}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
