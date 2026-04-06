import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import './App.css';
import { Differ, Viewer } from 'json-diff-kit';

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

function preprocessJson(baseName, data) {
  if (FILES_WITH_KEY_DELETE.has(baseName)) {
    let result = deleteFields(data, new Set(['created', 'creation_date', 'last_update', 'version', 'from']));
    result = deleteIdWhere(result, id => /\d{3},?$/.test(id));
    result = deleteIdWhere(result, id => /-/.test(id));
    result = deleteIdWhere(result, id => /endpoints_|items__/.test(id));
    if (baseName === 'delivery_configs' && result.delivery_configs) {
      result = { ...result, delivery_configs: rekey(result.delivery_configs, v => v?.name?.trim()) };
      result = deleteFields(result, new Set(['id']));
      result = trimNameFields(result);
    }
    if (baseName === 'sort_orders' && result.sort_orders)
      result = { ...result, sort_orders: rekey(result.sort_orders, v => {
        const dm = v?.value?.delivery_method;
        const sc = v?.value?.sales_channel;
        return dm && sc ? `${dm}_${sc}` : null;
      }) };
    if (baseName === 'zones')
      result = deleteFields(result, new Set(['endpoint_ids']));
    return result;
  }
  if (baseName === 'modules') return deleteNestedId(data, 'module');
  if (baseName === 'request_couples') return deleteNestedId(data, 'value');
  return data;
}

const toSentenceCase = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '—';

const differ = new Differ({ detectCircular: true, maxDepth: Infinity, showModifications: true, arrayDiffMethod: 'lcs' });

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

async function computeAllDiffs(internalFilesArr, stagingFilesArr, fileNames) {
  const stats = {};
  const diffs = {};
  for (const fileName of fileNames) {
    try {
      const baseName = fileName.replace(/\.json$/, '');
      const before = preprocessJson(baseName, JSON.parse(await internalFilesArr.find((f) => f.name === fileName).text()));
      const after = preprocessJson(baseName, JSON.parse(await stagingFilesArr.find((f) => f.name === fileName).text()));
      const result = differ.diff(before, after);
      const [leftLines, rightLines] = result;
      stats[fileName] = {
        removes: leftLines.filter((l) => l.type === 'remove').length,
        adds: rightLines.filter((l) => l.type === 'add').length,
        modifies: leftLines.filter((l) => l.type === 'modify').length,
      };
      diffs[fileName] = result;
    } catch (e) {
      console.warn(`Failed to diff ${fileName}:`, e);
      stats[fileName] = { removes: 0, adds: 0, modifies: 0 };
    }
  }
  return { stats, diffs };
}

function DiffTooltip() {
  return (
    <span className="tooltip-host">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="11" x2="12" y2="16"/>
        <line x1="12" y1="7" x2="12.01" y2="7"/>
      </svg>
      <span className="tooltip">
        <span className="stat-remove">Removed</span> / <span className="stat-add">Added</span> / <span className="stat-modify">Changed</span>
        {'\n\n'}
        <span className="stat-remove">Removed</span> : number of lines from the left environment that are not in the right environment{'\n'}
        <span className="stat-add">Added</span> : number of lines from the right environment that are not in the left environment{'\n'}
        <span className="stat-modify">Changed</span> : number of lines present in both environments but with a different value
      </span>
    </span>
  );
}

function FileSelector({ files, onSelect, selectedFile, diffStats }) {
  const totals = files.reduce(
    (acc, file) => {
      const s = diffStats[file];
      if (s) {
        acc.removes += s.removes;
        acc.adds += s.adds;
        acc.modifies += s.modifies;
      }
      return acc;
    },
    { removes: 0, adds: 0, modifies: 0 }
  );

  return (
    <div className="file-selector">
      <div className="file-section-header">
        <p className="section-label">Files</p>
        <div className="section-label diff-header">
          Diff
          <DiffTooltip />
        </div>
      </div>
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
                {stats && <>
                  <span className={stats.removes === 0 ? 'stat-zero' : 'stat-remove'}>{stats.removes}</span>
                  {' / '}
                  <span className={stats.adds === 0 ? 'stat-zero' : 'stat-add'}>{stats.adds}</span>
                  {' / '}
                  <span className={stats.modifies === 0 ? 'stat-zero' : 'stat-modify'}>{stats.modifies}</span>
                </>}
              </span>
            </button>
          );
        })}
      </div>
      {Object.keys(diffStats).length > 0 && (
        <div className="diff-totals">
          <span className="diff-totals-label">Total</span>
          <span className="diff-stats">
            <span className={totals.removes === 0 ? 'stat-zero' : 'stat-remove'}>{totals.removes}</span>
            {' / '}
            <span className={totals.adds === 0 ? 'stat-zero' : 'stat-add'}>{totals.adds}</span>
            {' / '}
            <span className={totals.modifies === 0 ? 'stat-zero' : 'stat-modify'}>{totals.modifies}</span>
          </span>
        </div>
      )}
    </div>
  );
}

async function readZipFile(file) {
  const zip = await JSZip.loadAsync(file);

  let environment = file.name.replace(/\.zip$/i, '');
  let siteId = null;
  const infoFile = zip.file('export.info');
  if (infoFile) {
    try {
      const info = JSON.parse(await infoFile.async('text'));
      if (info.environment) environment = info.environment;
      if (info.site_id) siteId = info.site_id;
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

  return { environment, siteId, files: jsonFiles };
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
          <span className="slot-value">{leftEnvironment ?? '—'}</span>
          <span className="slot-value">{rightEnvironment ?? '—'}</span>
        </div>
      ) : (
        <span className="drop-icon">📁</span>
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState('home');
  const [hideUnchangedLines, setHideUnchangedLines] = useState(true);
  const [internalFiles, setInternalFiles] = useState([]);
  const [leftEnvironment, setLeftEnvironment] = useState(null);
  const [leftSiteId, setLeftSiteId] = useState(null);
  const [stagingFiles, setStagingFiles] = useState([]);
  const [rightEnvironment, setRightEnvironment] = useState(null);
  const [rightSiteId, setRightSiteId] = useState(null);
  const [commonFiles, setCommonFiles] = useState([]);
  const [diffStats, setDiffStats] = useState({});
  const [allDiffs, setAllDiffs] = useState({});
  const [diff, setDiff] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [scrollMarks, setScrollMarks] = useState([]);
  const [sameEnvWarning, setSameEnvWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);


  const hideUnchangedConfig = useMemo(() => hideUnchangedLines ? {
    expandLineRenderer: ({ hasLinesBefore, hasLinesAfter, onExpandBefore, onExpandAfter }) => (
      <div>
        {hasLinesBefore && <button onClick={() => onExpandBefore(20)}>↑ Show 20 lines before</button>}
        {hasLinesAfter && <button onClick={() => onExpandAfter(20)}>↓ Show 20 lines after</button>}
      </div>
    ),
  } : false, [hideUnchangedLines]);

  const handleSwap = () => {
    setInternalFiles(stagingFiles);
    setStagingFiles(internalFiles);
    setLeftEnvironment(rightEnvironment);
    setLeftSiteId(rightSiteId);
    setRightEnvironment(leftEnvironment);
    setRightSiteId(leftSiteId);

    const swappedStats = {};
    const swappedDiffs = {};
    for (const [file, [left, right]] of Object.entries(allDiffs)) {
      swappedDiffs[file] = [right, left];
      swappedStats[file] = {
        removes: diffStats[file]?.adds ?? 0,
        adds: diffStats[file]?.removes ?? 0,
        modifies: diffStats[file]?.modifies ?? 0,
      };
    }
    setDiffStats(swappedStats);
    setAllDiffs(swappedDiffs);
    if (selectedFile) setDiff(swappedDiffs[selectedFile] ?? null);
  };

  const handleFoldersDrop = (folders) => {
    if (folders.length >= 2) {
      setInternalFiles(folders[0].files);
      setLeftEnvironment(folders[0].environment);
      setLeftSiteId(folders[0].siteId);
      setStagingFiles(folders[1].files);
      setRightEnvironment(folders[1].environment);
      setRightSiteId(folders[1].siteId);
    } else if (folders.length === 1) {
      if (!leftEnvironment) {
        setInternalFiles(folders[0].files);
        setLeftEnvironment(folders[0].environment);
        setLeftSiteId(folders[0].siteId);
        } else {
        setStagingFiles(folders[0].files);
        setRightEnvironment(folders[0].environment);
        setRightSiteId(folders[0].siteId);
      }
    }
  };

  useEffect(() => {
    if (leftEnvironment && rightEnvironment) {
      if (leftEnvironment === rightEnvironment) {
        setSameEnvWarning(leftEnvironment);
        setInternalFiles([]);
        setLeftEnvironment(null);
        setLeftSiteId(null);
        setStagingFiles([]);
        setRightEnvironment(null);
        setRightSiteId(null);
          } else {
        setSameEnvWarning(null);
        setView('diff');
      }
    }
  }, [leftEnvironment, rightEnvironment]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

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
  }, [diff, hideUnchangedLines, scrollMarks]);

  useEffect(() => {
    if (!diff) { setScrollMarks([]); return; }
    const computeMarks = () => {
      const container = contentRef.current;
      if (!container) return;
      const scrollHeight = container.scrollHeight;
      const cells = container.querySelectorAll('.line-remove, .line-add, .line-modify');
      const seen = new Set();
      const marks = [];
      for (const cell of cells) {
        const tr = cell.closest('tr');
        if (!tr || seen.has(tr)) continue;
        seen.add(tr);
        const type = cell.classList.contains('line-remove') ? 'remove'
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
  }, [diff, hideUnchangedLines]);

  useEffect(() => {
    if (internalFiles.length > 0 && stagingFiles.length > 0) {
      Promise.all([splitConfigurations(internalFiles), splitConfigurations(stagingFiles)]).then(([splitInternal, splitStaging]) => {
      const internalFileNames = splitInternal.map((file) => file.name);
      const stagingFileNames = splitStaging.map((file) => file.name);
      const common = internalFileNames.filter((file) => stagingFileNames.includes(file)).sort();
      setCommonFiles(common);

      computeAllDiffs(splitInternal, splitStaging, common).then(({ stats, diffs }) => {
        setDiffStats(stats);
        setAllDiffs(diffs);
        setDiff(null);
        setSelectedFile(null);
      });
      });
    }
  }, [internalFiles, stagingFiles]);

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
    setInternalFiles([]);
    setLeftEnvironment(null);
    setLeftSiteId(null);
    setStagingFiles([]);
    setRightEnvironment(null);
    setRightSiteId(null);
    setCommonFiles([]);
    setDiffStats({});
    setAllDiffs({});
    setDiff(null);
    setSelectedFile(null);
    setScrollMarks([]);
    setHideUnchangedLines(true);
    setSameEnvWarning(null);
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
        <p className="home-motto">Compare configurations across environments</p>
        <div className="home-cards">
          <div className="home-card">
            <h2 className="home-card-title">Environment diff</h2>
            <p className="home-card-desc">Drop two zip files to compare the configuration between two environments</p>
            <FolderDropZone
              onFoldersDrop={handleFoldersDrop}
              leftEnvironment={leftEnvironment}
              rightEnvironment={rightEnvironment}
            />
            {sameEnvWarning && (
              <p className="home-warning">Both files have the same environment: <strong>{sameEnvWarning}</strong></p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-layout">
      <div className="sidebar">
        <button className="home-btn" onClick={handleGoHome} title="Back to home"><svg className="home-btn-icon" viewBox="0 0 24 24" fill="none"><path d="M14 19H16C17.1046 19 18 18.1046 18 17V14.5616C18 13.6438 18.6246 12.8439 19.5149 12.6213L21.0299 12.2425C21.2823 12.1794 21.2823 11.8206 21.0299 11.7575L19.5149 11.3787C18.6246 11.1561 18 10.3562 18 9.43845V5H14" stroke="currentColor" strokeWidth="2"/><path d="M10 5H8C6.89543 5 6 5.89543 6 7V9.43845C6 10.3562 5.37541 11.1561 4.48507 11.3787L2.97014 11.7575C2.71765 11.8206 2.71765 12.1794 2.97014 12.2425L4.48507 12.6213C5.37541 12.8439 6 13.6438 6 14.5616V19H10" stroke="currentColor" strokeWidth="2"/></svg>Confdiff</button>
        <p className="sidebar-section-label">Site</p>
        <div className="site-env-row">
          {(leftSiteId || rightSiteId) && (
            <div className="pill-dropdown">
              <button className="pill-dropdown-toggle" disabled>
                <span className="pill-dropdown-label">ID</span>
                <span className="pill-dropdown-value">{leftSiteId ?? rightSiteId}</span>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l4 4 4-4"/></svg>
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
              onChange={(e) => setHideUnchangedLines(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
          Only show diff
        </label>
        <FileSelector files={commonFiles} onSelect={handleFileSelect} selectedFile={selectedFile} diffStats={diffStats} />
      </div>
      <div ref={contentRef} className={`diff-content${scrollMarks.length > 0 ? ' diff-content--with-map' : ''}`}>
        <div className="diff-pane">
          {loading ? (
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
            />
          ) : (
            <div className="empty-state">
              <svg className="empty-state-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <p className="empty-state-title">Select a file to compare</p>
              <p className="empty-state-body">
                Click on any file from the list on the left to see a side-by-side diff between the <strong>{leftEnvironment}</strong> and <strong>{rightEnvironment}</strong> environments
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
