import { Fragment, useEffect, useRef, useState } from 'react';
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
          <span className="tooltip-host">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="11" x2="12" y2="16"/>
              <line x1="12" y1="7" x2="12.01" y2="7"/>
            </svg>
            <span className="tooltip">
              <span className="stat-remove">Removed</span> / <span className="stat-add">Added</span> / <span className="stat-modify">Modified</span>
              {'\n\n'}
              <span className="stat-remove">Removed</span> : number of lines from the left environment that are not in the right environment{'\n'}
              <span className="stat-add">Added</span> : number of lines from the right environment that are not in the left environment{'\n'}
              <span className="stat-modify">Modified</span> : number of lines present in both environments but with a different value
            </span>
          </span>
        </div>
      </div>
      <div className="file-list-scroll">
        {files.map((file) => {
          const stats = diffStats[file];
          return (
            <Fragment key={file}>
              <button
                className={`file-btn${file === selectedFile ? ' active' : ''}`}
                onClick={() => onSelect(file)}
              >
                {file.replace(/\.json$/, '')}
              </button>
              <span className="diff-stats">
                {stats && <>
                  <span className={stats.removes === 0 ? 'stat-zero' : 'stat-remove'}>{stats.removes}</span>
                  {' / '}
                  <span className={stats.adds === 0 ? 'stat-zero' : 'stat-add'}>{stats.adds}</span>
                  {' / '}
                  <span className={stats.modifies === 0 ? 'stat-zero' : 'stat-modify'}>{stats.modifies}</span>
                </>}
              </span>
            </Fragment>
          );
        })}
      </div>
      {Object.keys(diffStats).length > 0 && (
        <div className="diff-totals">
          <span className="diff-totals-label">Total</span>
          <span className="diff-stats">
            <span className="stat-remove">{totals.removes}</span>
            {' / '}
            <span className="stat-add">{totals.adds}</span>
            {' / '}
            <span className="stat-modify">{totals.modifies}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function FolderDropZone({ onFoldersDrop, onSwap, leftEnvironment, rightEnvironment, large }) {
  const [isDragging, setIsDragging] = useState(false);

  const readZipFile = async (file) => {
    const zip = await JSZip.loadAsync(file);

    let environment = file.name.replace(/\.zip$/i, '');
    let siteId = null;
    let siteName = null;

    const infoFile = zip.file('export.info');
    if (infoFile) {
      try {
        const info = JSON.parse(await infoFile.async('text'));
        if (info.environment) environment = info.environment;
        if (info.site_id) siteId = info.site_id;
        if (info.site_name) siteName = info.site_name;
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

    return { environment, siteId, siteName, files: jsonFiles };
  };

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
  const classes = ['folder-drop-zone',
    large && 'folder-drop-zone--large',
    !large && isFilled && 'folder-drop-zone--compact',
    isDragging && 'dragging',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {large && (
        <svg className="drop-zone-border" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0.5" y="0.5" width="99" height="99" rx="1.8" ry="4.5"
            fill="none"
            stroke={isDragging ? '#6366f1' : '#3e4049'}
            strokeWidth="1"
            strokeDasharray="10 14"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {isFilled ? (
        <div className="drop-slots">
          <span className={large ? 'slot-value' : 'env-badge'}>{large ? (leftEnvironment ?? '—') : toSentenceCase(leftEnvironment)}</span>
          <button className="swap-btn" onClick={(e) => { e.stopPropagation(); onSwap(); }} title="Swap folders">⇄</button>
          <span className={large ? 'slot-value' : 'env-badge'}>{large ? (rightEnvironment ?? '—') : toSentenceCase(rightEnvironment)}</span>
        </div>
      ) : (
        <>
          <span className="drop-icon">📁</span>
          <p className="drop-hint">Drop two configuration zip folders here</p>
        </>
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState('home');
  const [hideUnchangedLines, setHideUnchangedLines] = useState(false);
  const [internalFiles, setInternalFiles] = useState([]);
  const [leftEnvironment, setLeftEnvironment] = useState(null);
  const [leftSiteId, setLeftSiteId] = useState(null);
  const [leftSiteName, setLeftSiteName] = useState(null);
  const [stagingFiles, setStagingFiles] = useState([]);
  const [rightEnvironment, setRightEnvironment] = useState(null);
  const [rightSiteId, setRightSiteId] = useState(null);
  const [rightSiteName, setRightSiteName] = useState(null);
  const [commonFiles, setCommonFiles] = useState([]);
  const [diffStats, setDiffStats] = useState({});
  const [allDiffs, setAllDiffs] = useState({});
  const [diff, setDiff] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [scrollMarks, setScrollMarks] = useState([]);
  const [sameEnvWarning, setSameEnvWarning] = useState(null);
  const contentRef = useRef(null);

  const handleSwap = () => {
    setInternalFiles(stagingFiles);
    setStagingFiles(internalFiles);
    setLeftEnvironment(rightEnvironment);
    setLeftSiteId(rightSiteId);
    setLeftSiteName(rightSiteName);
    setRightEnvironment(leftEnvironment);
    setRightSiteId(leftSiteId);
    setRightSiteName(leftSiteName);

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
      setLeftSiteName(folders[0].siteName);
      setStagingFiles(folders[1].files);
      setRightEnvironment(folders[1].environment);
      setRightSiteId(folders[1].siteId);
      setRightSiteName(folders[1].siteName);
    } else if (folders.length === 1) {
      if (!leftEnvironment) {
        setInternalFiles(folders[0].files);
        setLeftEnvironment(folders[0].environment);
        setLeftSiteId(folders[0].siteId);
        setLeftSiteName(folders[0].siteName);
      } else {
        setStagingFiles(folders[0].files);
        setRightEnvironment(folders[0].environment);
        setRightSiteId(folders[0].siteId);
        setRightSiteName(folders[0].siteName);
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
        setLeftSiteName(null);
        setStagingFiles([]);
        setRightEnvironment(null);
        setRightSiteId(null);
        setRightSiteName(null);
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
    if (!diff) { setScrollMarks([]); return; }
    let rafId;
    const timer = setTimeout(() => {
      rafId = requestAnimationFrame(() => {
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
      });
    }, 50);
    return () => { clearTimeout(timer); cancelAnimationFrame(rafId); };
  }, [diff, hideUnchangedLines]);

  useEffect(() => {
    if (internalFiles.length > 0 && stagingFiles.length > 0) {
      const internalFileNames = internalFiles.map((file) => file.name);
      const stagingFileNames = stagingFiles.map((file) => file.name);
      const common = internalFileNames.filter((file) => stagingFileNames.includes(file)).sort();
      setCommonFiles(common);

      computeAllDiffs(internalFiles, stagingFiles, common).then(({ stats, diffs }) => {
        setDiffStats(stats);
        setAllDiffs(diffs);
        setDiff(null);
        setSelectedFile(null);
      });
    }
  }, [internalFiles, stagingFiles]);

  const handleGoHome = () => {
    setView('home');
    setInternalFiles([]);
    setLeftEnvironment(null);
    setLeftSiteId(null);
    setLeftSiteName(null);
    setStagingFiles([]);
    setRightEnvironment(null);
    setRightSiteId(null);
    setRightSiteName(null);
    setCommonFiles([]);
    setDiffStats({});
    setAllDiffs({});
    setDiff(null);
    setSelectedFile(null);
    setScrollMarks([]);
    setHideUnchangedLines(false);
    setSameEnvWarning(null);
  };

  const handleFileSelect = (fileName) => {
    setDiff(allDiffs[fileName] ?? null);
    setSelectedFile(fileName);
    contentRef.current?.scrollTo({ top: 0 });
  };

  if (view === 'home') {
    return (
      <div className="home-page">
        <h1 className="home-title">Confdiff</h1>
        <p className="home-motto">Check the difference of configuration files for two environments</p>
        <FolderDropZone
          large
          onFoldersDrop={handleFoldersDrop}
          onSwap={handleSwap}
          leftEnvironment={leftEnvironment}
          rightEnvironment={rightEnvironment}
        />
        {sameEnvWarning && (
          <p className="home-warning">Both folders have the same environment: <strong>{sameEnvWarning}</strong></p>
        )}
      </div>
    );
  }

  return (
    <div className="diff-layout">
      <div className="sidebar">
        <button className="home-btn" onClick={handleGoHome} title="Back to home">Confdiff</button>
        {(leftSiteId || rightSiteId) && (
          <div className="site-id">
            <span className="site-id-code">{leftSiteId ?? rightSiteId}</span>
            <span className="site-id-name">{leftSiteName ?? rightSiteName}</span>
          </div>
        )}
        <FolderDropZone
          onFoldersDrop={handleFoldersDrop}
          onSwap={handleSwap}
          leftEnvironment={leftEnvironment}
          rightEnvironment={rightEnvironment}
        />
        <label className="unchanged-lines-label">
          <span className="toggle">
            <input
              type="checkbox"
              checked={hideUnchangedLines}
              onChange={(e) => setHideUnchangedLines(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
          Hide unchanged lines
        </label>
        <FileSelector files={commonFiles} onSelect={handleFileSelect} selectedFile={selectedFile} diffStats={diffStats} />
      </div>
      <div ref={contentRef} className={`diff-content${scrollMarks.length > 0 ? ' diff-content--with-map' : ''}`}>
        <div className="diff-pane">
          {diff ? (
            <Viewer
              key={hideUnchangedLines}
              diff={diff}
              indent={4}
              lineNumbers={true}
              syntaxHighlight={{ theme: 'monokai' }}
              hideUnchangedLines={hideUnchangedLines}
              highlightInlineDiff={true}
              inlineDiffOptions={{ mode: 'word', wordSeparator: ' ' }}
            />
          ) : (
            <div className="empty-state">
              <p className="empty-state-title">Select a file to compare</p>
              <p className="empty-state-body">
                Click on any file from the list on the left to see a side-by-side diff between the <strong>{leftEnvironment}</strong> and <strong>{rightEnvironment}</strong> environments.
              </p>
              <p className="empty-state-body">
                The numbers next to each file show how many lines were <span className="stat-remove">removed</span>, <span className="stat-add">added</span>, or <span className="stat-modify">modified</span> between the two environments.
              </p>
            </div>
          )}
        </div>
        {scrollMarks.length > 0 && (
          <div
            className="scroll-map"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = (e.clientY - rect.top) / rect.height;
              contentRef.current?.scrollTo({ top: ratio * contentRef.current.scrollHeight });
            }}
          >
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
