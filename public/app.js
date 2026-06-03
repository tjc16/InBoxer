'use strict';

// Credentials kept only in memory for the session; never persisted.
const creds = { email: '', password: '', host: '', port: '', limit: 100000 };
let allEmails = [];
let unsubData = { senders: [], totalEmails: 0, oneClickCount: 0 };
let planFolders = [];          // [{id, segments, uids, count, dispKey}]
let unsortedInfo = { count: 0 };
let activeFolder = 'all';      // 'all' | 'inbox' | full folder path string
let navState = { parent: 'InBoxer', folders: [], applied: false }; // mailbox the dashboard browses
let folderKeyByUid = {};       // uid → leaf folder path (undefined = still in Inbox)
let isDemo = false;
let rendered = 0;
const PAGE = 80;

const DISPO_ORDER = ['file', 'hold', 'cleanup'];
const CAT_MIN = 5;    // min emails for a dedicated category folder (else roll up)
const GROUP_MIN = 3;  // min emails for a File group (else roll to File root)

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

// ---------------------------------------------------------------------------
// View routing
// ---------------------------------------------------------------------------

function showLanding() {
  ['app', 'review', 'connectModal', 'scanOverlay', 'donateModal', 'successModal', 'tourOverlay'].forEach(hide);
  show('landing'); $('password').value = '';
}
const openConnect = () => show('connectModal');
const closeConnect = () => hide('connectModal');

['navConnect', 'heroConnect'].forEach((id) => $(id).addEventListener('click', openConnect));
['navDemo', 'heroDemo', 'howDemo', 'modalDemo'].forEach((id) => $(id).addEventListener('click', startDemo));
$('modalClose').addEventListener('click', closeConnect);
$('connectModal').addEventListener('click', (e) => { if (e.target.id === 'connectModal') closeConnect(); });
$('backHome').addEventListener('click', (e) => { e.preventDefault(); exitToLanding(); });
$('reviewHome').addEventListener('click', (e) => { e.preventDefault(); exitToLanding(); });
$('logoutBtn').addEventListener('click', exitToLanding);
$('reviewExit').addEventListener('click', exitToLanding);
$('backToPlan').addEventListener('click', () => { hide('app'); show('review'); });
$('browseDetail').addEventListener('click', () => enterDashboard());

function exitToLanding() {
  creds.email = ''; creds.password = ''; allEmails = []; isDemo = false;
  endTour(); showLanding();
}

// ---------------------------------------------------------------------------
// Demo + scan
// ---------------------------------------------------------------------------

async function startDemo() {
  closeConnect(); show('scanOverlay');
  $('scanTitle').textContent = 'Loading demo inbox…';
  $('scanStatus').textContent = 'Generating realistic sample emails';
  $('progressBar').style.width = '45%';
  try {
    const res = await fetch('/api/demo');
    const data = await res.json();
    $('progressBar').style.width = '100%';
    allEmails = data.emails; isDemo = true; creds.email = 'demo@inboxer.app';
    setTimeout(() => { hide('scanOverlay'); enterReview(true); setTimeout(startTour, 400); }, 300);
  } catch (e) { hide('scanOverlay'); toast('Could not load demo: ' + e.message, true); }
}

$('connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  creds.email = $('email').value.trim(); creds.password = $('password').value;
  creds.host = $('host').value.trim(); creds.port = $('port').value.trim();
  creds.limit = $('limit').value || 100000;
  const err = $('connectError'); err.classList.add('hidden');
  closeConnect(); show('scanOverlay');
  $('scanTitle').textContent = 'Scanning your inbox…'; $('scanStatus').textContent = 'Connecting…';
  $('progressBar').style.width = '3%'; allEmails = []; isDemo = false;
  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to connect'); }
    await consumeStream(res.body, (evt) => {
      if (evt.type === 'start') {
        $('scanStatus').textContent = evt.total === 0 ? 'Inbox is empty.'
          : `Found ${evt.mailboxTotal.toLocaleString()} emails. Scanning the newest ${evt.total.toLocaleString()}…`;
      } else if (evt.type === 'batch') {
        allEmails.push(...evt.emails);
        $('progressBar').style.width = Math.min(99, Math.round((evt.scanned / evt.total) * 100)) + '%';
        $('scanStatus').textContent = `Scanned ${evt.scanned.toLocaleString()} of ${evt.total.toLocaleString()}…`;
      } else if (evt.type === 'done') { $('progressBar').style.width = '100%'; }
      else if (evt.type === 'error') { throw new Error(evt.error); }
    });
    setTimeout(() => { hide('scanOverlay'); enterReview(false); }, 250);
  } catch (e2) { hide('scanOverlay'); openConnect(); err.textContent = e2.message; err.classList.remove('hidden'); }
});

async function consumeStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf.trim()));
}

$('email').addEventListener('blur', async () => {
  const email = $('email').value.trim();
  if (!email.includes('@') || $('host').value) return;
  try {
    const res = await fetch('/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (data.host) $('host').placeholder = `${data.host}:${data.port}`;
  } catch (_) {}
});

// ---------------------------------------------------------------------------
// Stats + unsubscribe analysis
// ---------------------------------------------------------------------------

function computeStats(emails) {
  let unread = 0, high = 0, cleanup = 0, unsub = 0, unsorted = 0;
  for (const e of emails) {
    if (!e.seen) unread++;
    if (e.priority === 'high') high++;
    if (e.dispKey === 'cleanup') cleanup++;
    if (e.dispKey === 'unsorted') unsorted++;
    if (e.unsubscribeUrl || e.unsubscribeMailto) unsub++;
  }
  return { total: emails.length, unread, high, cleanup, unsub, unsorted };
}

function buildUnsub(emails) {
  const map = {};
  for (const e of emails) {
    if (!e.unsubscribeUrl && !e.unsubscribeMailto) continue;
    const key = e.fromAddress || e.from;
    if (!map[key]) map[key] = { sender: e.from, address: e.fromAddress, count: 0, url: e.unsubscribeUrl, mailto: e.unsubscribeMailto, oneClick: false };
    map[key].count++;
    if (e.unsubscribeUrl) map[key].url = e.unsubscribeUrl;
    if (e.unsubscribeMailto && !map[key].mailto) map[key].mailto = e.unsubscribeMailto;
    if (e.unsubscribeOneClick) map[key].oneClick = true;
  }
  const senders = Object.values(map).sort((a, b) => b.count - a.count);
  return { senders, totalEmails: senders.reduce((n, s) => n + s.count, 0), oneClickCount: senders.filter((s) => s.oneClick).length };
}

// ---------------------------------------------------------------------------
// Plan builder (dynamic taxonomy with rollup)
// ---------------------------------------------------------------------------

function buildPlan(emails) {
  planFolders = [];
  let fid = 0;
  // meta carries the fields the uncheck logic reads:
  //   kind: 'leaf' (own category) | 'roll' (a group/disposition "other" bucket)
  //         | 'misc' (File root) | 'unsorted'
  //   groupKey/groupName: set for File leaves & File "(other)" buckets
  //   rollupSegments: where a *leaf's* emails go when it's unticked (its parent
  //         "(other)" folder). Absent on non-leaf folders, which fall to Inbox.
  const mk = (segments, uids, dispKey, meta) => {
    const f = { id: fid++, segments, uids, count: uids.length, dispKey, kind: 'leaf', groupKey: null, ...(meta || {}) };
    planFolders.push(f); return f;
  };
  const rows = [];           // render rows
  const byDisp = { file: [], hold: [], cleanup: [], unsorted: [] };
  for (const e of emails) (byDisp[e.dispKey] || byDisp.unsorted).push(e);

  // ---- FILE: Disposition → Group → Category ----
  if (byDisp.file.length) {
    rows.push({ type: 'dispo', dispKey: 'file', icon: '📂', name: 'File', total: byDisp.file.length });
    const groups = {};
    for (const e of byDisp.file) {
      const g = (groups[e.groupKey] = groups[e.groupKey] || { key: e.groupKey, name: e.groupName, icon: e.groupIcon, order: e.groupOrder, cats: {} });
      const c = (g.cats[e.categoryKey] = g.cats[e.categoryKey] || { name: e.categoryName, icon: e.categoryIcon, order: e.categoryOrder, uids: [] });
      c.uids.push(e.uid);
    }
    const fileRoot = [];
    Object.values(groups).sort((a, b) => a.order - b.order).forEach((g) => {
      const cats = Object.values(g.cats);
      const groupTotal = cats.reduce((n, c) => n + c.uids.length, 0);
      if (groupTotal < GROUP_MIN) { cats.forEach((c) => fileRoot.push(...c.uids)); return; }
      rows.push({ type: 'group', dispKey: 'file', groupKey: g.key, icon: g.icon, name: g.name, total: groupTotal });
      const rolled = [];
      cats.sort((a, b) => a.order - b.order).forEach((c) => {
        if (c.uids.length >= CAT_MIN) {
          const f = mk(['File', g.name, c.name], c.uids, 'file', { kind: 'leaf', groupKey: g.key, groupName: g.name, rollupSegments: ['File', g.name] });
          rows.push({ type: 'folder', id: f.id, icon: c.icon, label: c.name, count: c.uids.length, indent: 2, dispKey: 'file' });
        } else rolled.push(...c.uids);
      });
      if (rolled.length) {
        const f = mk(['File', g.name], rolled, 'file', { kind: 'roll', groupKey: g.key, groupName: g.name });
        rows.push({ type: 'folder', id: f.id, icon: '📁', label: `${g.name} (other)`, count: rolled.length, indent: 2, dispKey: 'file' });
      }
    });
    if (fileRoot.length) {
      const f = mk(['File'], fileRoot, 'file', { kind: 'misc' });
      rows.push({ type: 'folder', id: f.id, icon: '📁', label: 'File (misc)', count: fileRoot.length, indent: 1, dispKey: 'file' });
    }
  }

  // ---- HOLD / CLEAN UP: Disposition → Category (the disposition plays the
  //      "group" role here, so a leaf rolls up into "<Disposition> (other)") ----
  [['hold', '⏳', 'Hold'], ['cleanup', '🧹', 'Clean up']].forEach(([dk, icon, name]) => {
    const list = byDisp[dk];
    if (!list.length) return;
    rows.push({ type: 'dispo', dispKey: dk, icon, name, total: list.length });
    const cats = {};
    for (const e of list) {
      const c = (cats[e.categoryKey] = cats[e.categoryKey] || { name: e.categoryName, icon: e.categoryIcon, order: e.categoryOrder, uids: [] });
      c.uids.push(e.uid);
    }
    const rootUids = [];
    Object.values(cats).sort((a, b) => a.order - b.order).forEach((c) => {
      if (c.uids.length >= CAT_MIN) {
        const f = mk([name, c.name], c.uids, dk, { kind: 'leaf', rollupSegments: [name] });
        rows.push({ type: 'folder', id: f.id, icon: c.icon, label: c.name, count: c.uids.length, indent: 1, dispKey: dk });
      } else rootUids.push(...c.uids);
    });
    if (rootUids.length) {
      const f = mk([name], rootUids, dk, { kind: 'roll' });
      rows.push({ type: 'folder', id: f.id, icon: icon, label: `${name} (other)`, count: rootUids.length, indent: 1, dispKey: dk });
    }
  });

  // ---- UNSORTED: its own folder, so confirming leaves the Inbox empty ----
  if (byDisp.unsorted.length) {
    rows.push({ type: 'dispo', dispKey: 'unsorted', icon: '❓', name: 'Unsorted', total: byDisp.unsorted.length });
    const f = mk(['Unsorted'], byDisp.unsorted.map((e) => e.uid), 'unsorted', { kind: 'unsorted' });
    rows.push({ type: 'folder', id: f.id, icon: '❓', label: 'Unidentified', count: f.count, indent: 1, dispKey: 'unsorted' });
  }
  unsortedInfo = { count: byDisp.unsorted.length };
  return rows;
}

// Re-derive the folders-to-create from the live tick state. A leaf that's been
// unticked rolls its emails up into its parent group's "(other)" folder; a
// group or disposition that's been unticked drops its emails back to the Inbox
// (they're simply omitted). Folders are merged by path so a rolled-up leaf and
// an existing "(other)" bucket combine into one move.
function computeApplyPlan() {
  const dispChecked = {};
  document.querySelectorAll('.dispoToggle').forEach((cb) => { dispChecked[cb.dataset.disp] = cb.checked; });
  const groupChecked = {};
  document.querySelectorAll('.groupToggle').forEach((cb) => { groupChecked[cb.dataset.group] = cb.checked; });
  const leafChecked = {};
  document.querySelectorAll('.folderToggle').forEach((cb) => { leafChecked[cb.dataset.fid] = cb.checked; });

  const byPath = new Map();
  const emit = (segments, uids) => {
    const key = segments.join('/');
    const cur = byPath.get(key) || { segments, uids: [] };
    cur.uids.push(...uids);
    byPath.set(key, cur);
  };
  for (const f of planFolders) {
    if (dispChecked[f.dispKey] === false) continue;                  // disposition → Inbox
    if (f.groupKey && groupChecked[f.groupKey] === false) continue;  // group → Inbox
    const checked = leafChecked[f.id] !== false;
    if (f.kind === 'leaf' && !checked && f.rollupSegments) emit(f.rollupSegments, f.uids); // roll up a level
    else if (checked) emit(f.segments, f.uids);                      // file as proposed
    // a non-leaf bucket (roll/misc/unsorted) that's been unticked → Inbox
  }
  return [...byPath.values()].filter((g) => g.uids.length);
}

// ---------------------------------------------------------------------------
// Review screen
// ---------------------------------------------------------------------------

function enterReview(demo) {
  ['landing', 'app'].forEach(hide); show('review');
  isDemo = demo;
  $('reviewBadge').classList.toggle('hidden', !demo);
  unsubData = buildUnsub(allEmails);
  renderSummaryInto('reviewSummary', computeStats(allEmails));
  renderTree();
  renderUnsub();
}

function renderSummaryInto(id, s) {
  $(id).innerHTML = `
    <div class="stat"><div class="num">${s.total.toLocaleString()}</div><div class="lbl">Emails scanned</div></div>
    <div class="stat"><div class="num">${s.unread.toLocaleString()}</div><div class="lbl">Unread</div></div>
    <div class="stat high"><div class="num">${s.high.toLocaleString()}</div><div class="lbl">Need attention</div></div>
    <div class="stat green"><div class="num">${s.cleanup.toLocaleString()}</div><div class="lbl">To clean up</div></div>
    <div class="stat"><div class="num">${s.unsub.toLocaleString()}</div><div class="lbl">Can unsubscribe</div></div>`;
}

const DISPO_LABEL = { file: 'File', hold: 'Hold', cleanup: 'Clean up', unsorted: 'Unsorted' };
const pfById = {};   // id → planFolder, rebuilt on every renderTree

function renderTree() {
  const rows = buildPlan(allEmails);
  Object.keys(pfById).forEach((k) => delete pfById[k]);
  planFolders.forEach((f) => { pfById[f.id] = f; });
  // The dashboard mailbox browses the proposed structure until apply narrows it.
  navState = { parent: ($('parentName').value || 'InBoxer').trim(), folders: planFolders.map((f) => ({ segments: f.segments, uids: f.uids })), applied: false };
  const html = rows.map((r) => {
    if (r.type === 'dispo') {
      return `<div class="tr-dispo" data-disp="${r.dispKey}">
          <label class="tr-master"><input type="checkbox" class="dispoToggle" data-disp="${r.dispKey}" checked />
          <span class="td-ic">${r.icon}</span> <b>${r.name}</b></label>
          <span class="tr-count">${r.total.toLocaleString()}</span></div>`;
    }
    if (r.type === 'group') {
      return `<div class="tr-group" data-group="${r.groupKey}">
          <label class="tg-label"><input type="checkbox" class="groupToggle" data-group="${r.groupKey}" data-disp="${r.dispKey}" checked />
          <span class="tg-ic">${r.icon}</span> ${escapeHtml(r.name)}</label>
          <span class="tr-count muted">${r.total.toLocaleString()}</span></div>`;
    }
    const f = pfById[r.id];
    const rollLabel = f.kind === 'leaf' && f.rollupSegments ? `${f.rollupSegments[f.rollupSegments.length - 1]} (other)` : '';
    return `<div class="tr-folder ind${r.indent}" data-disp="${r.dispKey}" data-fid="${r.id}">
        <label><input type="checkbox" class="folderToggle" data-fid="${r.id}" data-disp="${r.dispKey}" data-kind="${f.kind}"${f.groupKey ? ` data-group="${f.groupKey}"` : ''} checked />
        <span class="tf-ic">${r.icon}</span> ${escapeHtml(r.label)}</label>
        <span class="tr-note" data-roll="${escapeHtml(rollLabel)}"></span>
        <span class="tr-count">${r.count.toLocaleString()}</span></div>`;
  }).join('');
  $('folderTree').innerHTML = html || '<p class="muted">Nothing to file — your inbox is already tidy! 🎉</p>';
  refreshFolderHint();

  const tree = $('folderTree');

  // Disposition master — ticking restores the whole disposition; unticking
  // sends every email in it back to the Inbox, so confirm first.
  tree.querySelectorAll('.dispoToggle').forEach((cb) => cb.addEventListener('change', async () => {
    const disp = cb.dataset.disp;
    if (!cb.checked) {
      const n = planCount((f) => f.dispKey === disp);
      const ok = await confirmDialog({
        title: `Leave ${n.toLocaleString()} email${n === 1 ? '' : 's'} in your Inbox?`,
        body: `Unticking <b>${DISPO_LABEL[disp] || disp}</b> means none of these get filed — they’ll stay in your Inbox instead of being sorted.`,
        confirmText: 'Yes, keep in Inbox', cancelText: 'Keep filing them',
      });
      if (!ok) { cb.checked = true; return; }
    }
    tree.querySelectorAll(`.groupToggle[data-disp="${disp}"]`).forEach((g) => { g.checked = cb.checked; setGroupDisabled(g.dataset.group, !cb.checked); });
    tree.querySelectorAll(`.folderToggle[data-disp="${disp}"]`).forEach((fcb) => { fcb.checked = cb.checked; fcb.disabled = !cb.checked; });
    syncLeafNotes(); refreshFolderHint();
  }));

  // Group — unticking a whole group (e.g. Finance) drops it to the Inbox; warn.
  tree.querySelectorAll('.groupToggle').forEach((cb) => cb.addEventListener('change', async () => {
    const gk = cb.dataset.group;
    if (!cb.checked) {
      const n = planCount((f) => f.groupKey === gk);
      const name = (planFolders.find((f) => f.groupKey === gk) || {}).groupName || 'this group';
      const ok = await confirmDialog({
        title: `Leave ${n.toLocaleString()} email${n === 1 ? '' : 's'} in your Inbox?`,
        body: `Unticking the whole <b>${escapeHtml(name)}</b> group means these emails won’t be filed — they’ll stay in your Inbox. To file them under a single <b>${escapeHtml(name)}</b> folder instead, untick its sub-folders rather than the group.`,
        confirmText: 'Yes, keep in Inbox', cancelText: 'Keep the group',
      });
      if (!ok) { cb.checked = true; return; }
    }
    setGroupDisabled(gk, !cb.checked);
    syncLeafNotes(); refreshFolderHint();
  }));

  // Leaf — a category folder. Unticking an ordinary leaf rolls it up into its
  // group’s "(other)" folder (silent). Unticking a terminal bucket
  // ("(other)" / misc / Unsorted) has nowhere to roll, so it goes to the Inbox
  // and we confirm.
  tree.querySelectorAll('.folderToggle').forEach((cb) => cb.addEventListener('change', async () => {
    const f = pfById[cb.dataset.fid];
    const rollsUp = f.kind === 'leaf' && f.rollupSegments;
    if (!cb.checked && !rollsUp) {
      const dest = DISPO_LABEL[f.dispKey] || 'your Inbox';
      const ok = await confirmDialog({
        title: `Leave ${f.count.toLocaleString()} email${f.count === 1 ? '' : 's'} in your Inbox?`,
        body: `These don’t belong to a sub-folder, so unticking them keeps them in your Inbox rather than filing them under <b>${escapeHtml(dest)}</b>.`,
        confirmText: 'Yes, keep in Inbox', cancelText: 'Keep filing them',
      });
      if (!ok) { cb.checked = true; return; }
    }
    syncLeafNotes(); refreshFolderHint();
  }));
}

// Show "→ Group (other)" on each leaf that's currently unticked but rolling up.
function syncLeafNotes() {
  $('folderTree').querySelectorAll('.tr-folder').forEach((row) => {
    const cb = row.querySelector('.folderToggle');
    const note = row.querySelector('.tr-note');
    const rolling = cb && !cb.checked && !cb.disabled && note && note.dataset.roll;
    row.classList.toggle('rolled', !!rolling);
    if (note) note.textContent = rolling ? `→ ${note.dataset.roll}` : '';
  });
}

// Enable/disable & dim all of a group's leaf rows when the group is toggled off.
function setGroupDisabled(groupKey, disabled) {
  $('folderTree').querySelectorAll(`.folderToggle[data-group="${groupKey}"]`).forEach((fcb) => {
    fcb.disabled = disabled;
    fcb.closest('.tr-folder').classList.toggle('group-off', disabled);
  });
}

const planCount = (pred) => planFolders.filter(pred).reduce((n, f) => n + f.uids.length, 0);

function refreshFolderHint() {
  const plan = computeApplyPlan();
  const folders = plan.length;
  const filed = plan.reduce((n, g) => n + g.uids.length, 0);
  const toInbox = allEmails.length - filed;
  $('folderHint').textContent = `${folders} folder${folders === 1 ? '' : 's'} · ${filed.toLocaleString()} filed`;
  $('unsortedNote').innerHTML = toInbox > 0
    ? `📥 <b>${toInbox.toLocaleString()}</b> email${toInbox === 1 ? '' : 's'} will stay in your Inbox (unticked above); the rest are filed.`
    : (unsortedInfo.count
      ? `✅ Every email gets a home — including <b>${unsortedInfo.count.toLocaleString()}</b> unidentified ones in their own <b>Unsorted</b> folder. Your Inbox will be left empty.`
      : '✅ Every email gets a home — your Inbox will be left empty.');
}

function renderUnsub() {
  const u = unsubData;
  $('unsubLead').innerHTML = u.senders.length
    ? `<b>${u.totalEmails.toLocaleString()}</b> emails from <b>${u.senders.length}</b> senders — <b>${u.oneClickCount}</b> support instant one-click unsubscribe. All are ticked; untick any you’d like to keep.`
    : 'No unsubscribe lists found. 🎉';
  if (!u.senders.length) {
    $('massUnsub').disabled = true; $('massUnsub').textContent = 'Nothing to unsubscribe';
    $('unsubList').innerHTML = ''; hide('toggleUnsubList'); return;
  }
  show('toggleUnsubList');
  const head = `<li class="unsub-head"><label><input type="checkbox" id="unsubAll" checked /> Select all</label><span class="muted" id="unsubSelCount"></span></li>`;
  $('unsubList').innerHTML = head + u.senders.map((s, i) => `<li>
      <label><input type="checkbox" class="unsubPick" data-idx="${i}" checked />
      <span class="sname" title="${escapeHtml(s.address)}">${escapeHtml(s.sender)}</span></label>
      ${s.oneClick ? '<span class="oneclick">1-click</span>' : ''}
      <span class="scount">${s.count}×</span></li>`).join('');
  $('unsubList').querySelectorAll('.unsubPick').forEach((cb) => cb.addEventListener('change', () => { syncUnsubAll(); updateUnsubButton(); }));
  $('unsubAll').addEventListener('change', (e) => {
    $('unsubList').querySelectorAll('.unsubPick').forEach((cb) => { cb.checked = e.target.checked; });
    updateUnsubButton();
  });
  updateUnsubButton();
}

const selectedUnsubSenders = () => [...document.querySelectorAll('.unsubPick:checked')].map((cb) => unsubData.senders[Number(cb.dataset.idx)]);

function syncUnsubAll() {
  const all = document.querySelectorAll('.unsubPick').length;
  const checked = document.querySelectorAll('.unsubPick:checked').length;
  const a = $('unsubAll'); if (!a) return;
  a.checked = checked === all; a.indeterminate = checked > 0 && checked < all;
}
function updateUnsubButton() {
  const n = document.querySelectorAll('.unsubPick:checked').length;
  $('massUnsub').disabled = n === 0;
  $('massUnsub').textContent = n === 0 ? 'Select senders to unsubscribe' : `Unsubscribe from ${n} selected`;
  const c = $('unsubSelCount'); if (c) c.textContent = `${n} of ${unsubData.senders.length} selected`;
}

$('toggleUnsubList').addEventListener('click', () => {
  const hidden = $('unsubList').classList.toggle('hidden');
  $('toggleUnsubList').textContent = hidden ? 'Show senders ▾' : 'Hide senders ▴';
});

// Mass unsubscribe (streams progress through the scan overlay)
$('massUnsub').addEventListener('click', async () => {
  const targets = selectedUnsubSenders().map((s) => ({ sender: s.sender, address: s.address, url: s.url, oneClick: s.oneClick, mailto: s.mailto }));
  if (!targets.length) return toast('Tick at least one subscription to unsubscribe from.', true);
  show('scanOverlay');
  $('scanTitle').textContent = 'Unsubscribing…';
  $('scanStatus').textContent = `Sending unsubscribe requests to ${targets.length} senders…`;
  $('progressBar').style.width = '4%';
  try {
    const res = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...creds, demo: isDemo, targets }) });
    let result = null;
    await consumeStream(res.body, (evt) => {
      if (evt.type === 'progress') {
        $('progressBar').style.width = Math.min(99, Math.round((evt.done / Math.max(1, evt.total)) * 100)) + '%';
        $('scanStatus').textContent = `Unsubscribed from ${evt.done} of ${evt.total} — ${escapeHtml(evt.sender)}`;
      } else if (evt.type === 'done') { $('progressBar').style.width = '100%'; result = evt; }
      else if (evt.type === 'error') { throw new Error(evt.error); }
    });
    setTimeout(() => {
      hide('scanOverlay');
      const r = result || { ok: targets.length, failed: 0, manual: 0 };
      let msg = `Unsubscribed from ${r.ok} sender(s).`;
      if (r.manual) msg += ` ${r.manual} need a manual click.`;
      if (r.failed) msg += ` ${r.failed} couldn’t be reached.`;
      toast(msg + (isDemo ? ' (demo)' : ''));
    }, 300);
  } catch (e) { hide('scanOverlay'); toast(e.message, true); }
});

// ---------------------------------------------------------------------------
// Apply taxonomy
// ---------------------------------------------------------------------------

$('confirmApply').addEventListener('click', async () => {
  const parent = ($('parentName').value || 'InBoxer').trim();
  const groups = computeApplyPlan();
  const totalToMove = groups.reduce((n, g) => n + g.uids.length, 0);
  if (!totalToMove) return toast('Nothing selected to move. Tick at least one folder.', true);

  show('scanOverlay');
  $('scanTitle').textContent = 'Organising your inbox…';
  $('scanStatus').textContent = 'Creating folders…'; $('progressBar').style.width = '4%';
  try {
    const res = await fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...creds, demo: isDemo, parent, plan: groups }) });
    let result = null;
    await consumeStream(res.body, (evt) => {
      if (evt.type === 'progress') {
        $('progressBar').style.width = Math.min(99, Math.round((evt.moved / Math.max(1, evt.totalToMove)) * 100)) + '%';
        $('scanStatus').textContent = `Filing into “${escapeHtml(evt.folder)}” — ${evt.moved.toLocaleString()} of ${evt.totalToMove.toLocaleString()}…`;
      } else if (evt.type === 'done') { $('progressBar').style.width = '100%'; result = evt; }
      else if (evt.type === 'error') { throw new Error(evt.error); }
    });
    // Keep the emails in memory and record where each one went, so the dashboard
    // can browse the inbox and every created folder.
    navState = { parent, folders: groups.map((g) => ({ segments: g.segments, uids: g.uids })), applied: true };
    setTimeout(() => {
      hide('scanOverlay');
      const left = allEmails.length - totalToMove;
      const inboxNote = left > 0
        ? `<b>${left.toLocaleString()}</b> email${left === 1 ? '' : 's'} you unticked stay in your Inbox.`
        : 'your Inbox is now empty. 🎉';
      $('successTitle').textContent = isDemo ? 'Here’s what InBoxer would do' : 'Your inbox is organised!';
      $('successBody').innerHTML = `Created <b>${result ? result.folders : groups.length}</b> folders under <b>${escapeHtml(parent)}</b>
        and filed <b>${totalToMove.toLocaleString()}</b> emails — ${inboxNote} Clean-up mail is staged for you to
        review and delete; InBoxer never deletes anything.${isDemo ? '<br><br><i>This is demo data — nothing was changed.</i>' : ''}`;
      show('successModal');
    }, 350);
  } catch (e) { hide('scanOverlay'); toast(e.message, true); }
});

$('successView').addEventListener('click', () => { hide('successModal'); enterDashboard(); });
$('successDonate').addEventListener('click', () => { hide('successModal'); openDonate(); });

// ---------------------------------------------------------------------------
// Dashboard (browse in detail) — sidebar grouped by disposition
// ---------------------------------------------------------------------------

function enterDashboard() {
  ['landing', 'review'].forEach(hide); show('app');
  $('accountLabel').textContent = creds.email;
  $('demoBadge').classList.toggle('hidden', !isDemo);
  const pin = $('parentName');
  if (pin && !navState.applied) {
    // Browsing before applying: reflect the live tick state (rolled-up leaves,
    // groups left in the Inbox) rather than the untouched proposal.
    navState.parent = (pin.value || 'InBoxer').trim();
    if (document.querySelector('.folderToggle')) navState.folders = computeApplyPlan();
  }
  computeMailbox();
  activeFolder = 'all';
  renderSummaryInto('summary', computeStats(allEmails));
  renderSidebar();
  renderEmails(true);
}

// Build the uid → folder-path map and a name→icon lookup from the current plan.
let nameIcon = {};
function computeMailbox() {
  folderKeyByUid = {};
  for (const f of navState.folders) {
    const leaf = [navState.parent, ...f.segments].join('/');
    for (const uid of f.uids) folderKeyByUid[uid] = leaf;
  }
  nameIcon = { [navState.parent]: '🥊' };
  for (const e of allEmails) {
    nameIcon[e.dispName] = e.dispIcon;
    if (e.groupName) nameIcon[e.groupName] = e.groupIcon;
    nameIcon[e.categoryName] = e.categoryIcon;
  }
}

function countUnder(key) {
  return allEmails.filter((e) => { const k = folderKeyByUid[e.uid]; return k && (k === key || k.startsWith(key + '/')); }).length;
}

// Render the mailbox as a navigable folder tree: All mail · Inbox · parent → folders.
function renderSidebar() {
  const inboxCount = allEmails.filter((e) => !folderKeyByUid[e.uid]).length;
  let html = `<li data-folder="all" class="active"><span>🗂️ All mail</span><span class="badge">${allEmails.length.toLocaleString()}</span></li>`;
  html += `<li data-folder="inbox" class="fnode depth0"><span>📥 Inbox</span><span class="badge">${inboxCount.toLocaleString()}</span></li>`;

  // Build a nested tree from the folder paths.
  const root = { name: navState.parent, key: navState.parent, children: {}, order: 0 };
  for (const f of navState.folders) {
    const segs = [navState.parent, ...f.segments];
    let node = root;
    for (let i = 1; i < segs.length; i++) {
      const key = segs.slice(0, i + 1).join('/');
      node.children[segs[i]] = node.children[segs[i]] || { name: segs[i], key, children: {} };
      node = node.children[segs[i]];
    }
  }
  const renderNode = (node, depth) => {
    const icon = nameIcon[node.name] || '📁';
    html += `<li data-folder="${escapeHtml(node.key)}" class="fnode depth${depth}"><span>${icon} ${escapeHtml(node.name)}</span><span class="badge">${countUnder(node.key).toLocaleString()}</span></li>`;
    Object.values(node.children).forEach((c) => renderNode(c, depth + 1));
  };
  if (navState.folders.length) renderNode(root, 0);

  const list = $('categoryList');
  list.innerHTML = html;
  list.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    list.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
    li.classList.add('active'); activeFolder = li.dataset.folder; $('selectAll').checked = false; renderEmails(true);
  }));
}

function visibleEmails() {
  if (activeFolder === 'all') return allEmails;
  if (activeFolder === 'inbox') return allEmails.filter((e) => !folderKeyByUid[e.uid]);
  return allEmails.filter((e) => { const k = folderKeyByUid[e.uid]; return k && (k === activeFolder || k.startsWith(activeFolder + '/')); });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d); if (isNaN(date)) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function emailRow(e) {
  const reasons = e.reasons && e.reasons.length ? `<div class="reasons">${escapeHtml(e.reasons.join(' · '))}</div>` : '';
  const unsub = (e.unsubscribeUrl || e.unsubscribeMailto) ? `<span class="unsub-tag">${e.unsubscribeOneClick ? '1-click unsub' : 'unsub'}</span>` : '';
  return `<div class="email ${e.seen ? '' : 'unread'}">
      <input type="checkbox" class="pick" data-uid="${e.uid}" />
      <div class="icon">${e.categoryIcon}</div>
      <div class="body">
        <div class="line1"><span class="from" title="${escapeHtml(e.fromAddress)}">${escapeHtml(e.from)}</span><span class="date">${fmtDate(e.date)}</span></div>
        <div class="subject">${escapeHtml(e.subject)}</div>
        <div class="meta">
          <span class="disp-tag d-${e.dispKey}">${e.dispIcon} ${escapeHtml(e.dispName)}</span>
          <span class="tag cat">${e.categoryIcon} ${escapeHtml(e.categoryName)}</span>
          <span class="pri ${e.priority}">${e.priority}</span>
          <span class="action-hint">→ ${escapeHtml(e.suggestedAction)}</span>
          ${unsub}
        </div>${reasons}
      </div></div>`;
}

function renderEmails(reset) {
  const list = visibleEmails();
  const container = $('emailList');
  if (reset) { rendered = 0; container.innerHTML = ''; }
  if (list.length === 0) { container.innerHTML = `<div class="empty">No emails here.</div>`; hide('loadMoreWrap'); updateSelectedCount(); return; }
  const slice = list.slice(rendered, rendered + PAGE);
  container.insertAdjacentHTML('beforeend', slice.map(emailRow).join(''));
  rendered += slice.length;
  $('loadMoreWrap').classList.toggle('hidden', rendered >= list.length);
  container.querySelectorAll('.pick:not([data-bound])').forEach((cb) => { cb.setAttribute('data-bound', '1'); cb.addEventListener('change', updateSelectedCount); });
  updateSelectedCount();
}
$('loadMore').addEventListener('click', () => renderEmails(false));

const selectedUids = () => [...document.querySelectorAll('.pick:checked')].map((cb) => Number(cb.dataset.uid));
const updateSelectedCount = () => { $('selectedCount').textContent = `${selectedUids().length} selected`; };
$('selectAll').addEventListener('change', (e) => { document.querySelectorAll('.pick').forEach((cb) => { cb.checked = e.target.checked; }); updateSelectedCount(); });

document.querySelectorAll('[data-bulk]').forEach((btn) => btn.addEventListener('click', () => runBulk(btn.dataset.bulk)));
async function runBulk(action) {
  const uids = selectedUids();
  if (!uids.length) return toast('Select some emails first.', true);
  let folder;
  if (action === 'move') { folder = prompt('Move selected emails to which folder?', 'InBoxer/Sorted'); if (!folder) return; }
  try {
    const res = await fetch('/api/organise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...creds, demo: isDemo, action, uids, folder }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Action failed');
    if (action === 'move') {
      allEmails = allEmails.filter((e) => !uids.includes(e.uid));
      renderSummaryInto('summary', computeStats(allEmails)); renderSidebar();
      toast(`Moved ${data.affected} email(s) to “${folder}”.${isDemo ? ' (demo)' : ''}`);
    } else {
      allEmails.forEach((e) => { if (uids.includes(e.uid)) e.seen = true; });
      renderSummaryInto('summary', computeStats(allEmails));
      toast(`Marked ${data.affected} email(s) as read.${isDemo ? ' (demo)' : ''}`);
    }
    $('selectAll').checked = false; renderEmails(true);
  } catch (e) { toast(e.message, true); }
}

$('refreshBtn').addEventListener('click', () => { if (isDemo) return startDemo(); exitToLanding(); openConnect(); });

// ---------------------------------------------------------------------------
// Donate (skeleton)
// ---------------------------------------------------------------------------

let donateAmt = 5;
document.querySelectorAll('[data-donate]').forEach((b) => b.addEventListener('click', openDonate));
$('donateClose').addEventListener('click', () => hide('donateModal'));
$('donateModal').addEventListener('click', (e) => { if (e.target.id === 'donateModal') hide('donateModal'); });
function openDonate() { selectTier(5); show('donateModal'); }
function selectTier(amt) { donateAmt = amt; document.querySelectorAll('.tier').forEach((t) => t.classList.toggle('selected', Number(t.dataset.amt) === amt)); $('customAmt').value = ''; }
document.querySelectorAll('.tier').forEach((t) => t.addEventListener('click', () => selectTier(Number(t.dataset.amt))));
$('customAmt').addEventListener('input', (e) => { document.querySelectorAll('.tier').forEach((t) => t.classList.remove('selected')); donateAmt = Number(e.target.value) || 0; });
$('donateGo').addEventListener('click', async () => {
  const amt = Math.floor(donateAmt);
  if (!amt || amt < 1) { toast('Please choose an amount of at least $1.', true); return; }
  const btn = $('donateGo');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Redirecting…';
  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Could not start the payment.');
    window.location = data.url;            // hand off to Stripe's hosted checkout
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    toast(e.message, true);
  }
});

// After Stripe redirects back, show a thank-you (or a gentle note on cancel).
(function handleDonationReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('donation');
  if (!status) return;
  if (status === 'success') toast('Thank you for supporting InBoxer! 💜');
  else if (status === 'cancelled') toast('Payment cancelled — no charge was made.');
  // Clean the URL after load — doing it mid-parse gets clobbered by the
  // navigation still committing the address bar.
  const clean = () => history.replaceState({}, '', location.pathname);
  if (document.readyState === 'complete') clean();
  else window.addEventListener('load', clean);
})();

// ---------------------------------------------------------------------------
// Guided tour (spotlight) — runs on the review screen
// ---------------------------------------------------------------------------

const TOUR = [
  { sel: '#reviewSummary', title: 'Your whole inbox, at a glance', body: 'InBoxer scanned everything and counted what is unread, what needs you, what can be cleaned up, and what you can unsubscribe from.' },
  { sel: '#folderTree', title: 'A three-tier plan: File · Hold · Clean up', body: 'Every email is sorted into File (keep), Hold (act soon) or Clean up (review & delete), then into topical folders. Untick anything you want to leave alone.' },
  { sel: '.rev-card.accent', title: 'One-click unsubscribe', body: 'InBoxer finds every list you can leave and unsubscribes in bulk — using the email’s built-in one-click unsubscribe wherever it’s supported.' },
  { sel: '#unsortedNote', title: 'An empty Inbox', body: 'Every email gets a home — even ones InBoxer can’t identify go to their own Unsorted folder, so confirming leaves your Inbox completely empty.' },
  { sel: '#confirmApply', title: 'Review, then confirm', body: 'Nothing changes until you click here. Then InBoxer creates the folders in your inbox and files everything away.' },
];
let tourIdx = 0;
let tourTarget = null;   // element the current step points at
['reviewTour', 'tourBtn'].forEach((id) => $(id).addEventListener('click', () => {
  if ($('review').classList.contains('hidden')) { hide('app'); show('review'); }
  startTour();
}));
$('tourNext').addEventListener('click', () => stepTour(1));
$('tourBack').addEventListener('click', () => stepTour(-1));
$('tourSkip').addEventListener('click', endTour);

// Keep the spotlight + tooltip glued to their element while the user scrolls.
// Repositions synchronously (browsers already coalesce scroll events to ~one
// per frame, and placeTour only sets a few styles).
function trackTour() {
  if ($('tourOverlay').classList.contains('hidden') || !tourTarget) return;
  placeTour(tourTarget.getBoundingClientRect());
}
window.addEventListener('scroll', trackTour, { capture: true, passive: true });
window.addEventListener('resize', () => { if (!$('tourOverlay').classList.contains('hidden')) renderTour(); });

function startTour() { tourIdx = 0; show('tourOverlay'); renderTour(); }
function stepTour(d) { tourIdx += d; if (tourIdx >= TOUR.length) return endTour(); if (tourIdx < 0) tourIdx = 0; renderTour(); }
function renderTour() {
  const step = TOUR[tourIdx];
  const target = document.querySelector(step.sel);
  $('tourStep').textContent = `Step ${tourIdx + 1} of ${TOUR.length}`;
  $('tourTitle').textContent = step.title; $('tourBody').textContent = step.body;
  $('tourBack').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
  $('tourNext').textContent = tourIdx === TOUR.length - 1 ? 'Done' : 'Next';
  tourTarget = target;
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => placeTour(target.getBoundingClientRect()), 320); }
  else placeTour(null);
}
function placeTour(rect) {
  const spot = $('tourSpotlight'), tip = $('tourTip');
  if (!rect) { spot.style.display = 'none'; tip.style.left = (innerWidth / 2 - 150) + 'px'; tip.style.top = (innerHeight / 2 - 90) + 'px'; return; }
  const pad = 8;
  spot.style.display = 'block';
  spot.style.left = (rect.left - pad) + 'px'; spot.style.top = (rect.top - pad) + 'px';
  spot.style.width = (rect.width + pad * 2) + 'px'; spot.style.height = (rect.height + pad * 2) + 'px';
  const tw = 300, th = tip.offsetHeight || 180, gap = 16;
  let top = rect.bottom + gap; if (top + th > innerHeight - 10) top = Math.max(10, rect.top - th - gap);
  let left = Math.max(12, Math.min(rect.left + rect.width / 2 - tw / 2, innerWidth - tw - 12));
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function endTour() { hide('tourOverlay'); }

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg, isError) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}

// Promise-based confirm dialog. Resolves true on confirm, false on cancel /
// backdrop / Esc. Body is treated as trusted HTML (callers escape user data).
function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmBody').innerHTML = body;
    $('confirmOk').textContent = confirmText;
    $('confirmCancel').textContent = cancelText;
    const overlay = $('confirmModal');
    show('confirmModal');
    const done = (val) => {
      hide('confirmModal');
      $('confirmOk').removeEventListener('click', onOk);
      $('confirmCancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    $('confirmOk').addEventListener('click', onOk);
    $('confirmCancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
