/* UI: three screens (intake, outcome, tracker) rendered from a small state object. */
(function () {
  const T = window.Triage;
  const MIN = 60 * 1000;
  const STORE_KEY = 'lockout-assist-v1';
  const $app = document.getElementById('app');

  /* ---------- persistence ---------- */

  function freshStore() {
    const seed = window.LockoutData.buildSeed(Date.now());
    return {
      version: 1,
      db: { operator: seed.operator, vehicles: seed.vehicles, rentals: seed.rentals },
      cases: seed.cases,
      seq: seed.nextSeq,
    };
  }
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.version === 1) return s;
    } catch (e) { /* storage blocked or corrupt: start fresh */ }
    return freshStore();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* demo still works in memory */ }
  }

  let store = loadStore();
  const blankAnswers = () => ({
    lockedOut: 'renter', keyLocation: 'phone_key', atVehicle: 'yes',
    safety: [], callback: store.db.operator.phone, notes: '',
  });
  const ui = {
    view: 'intake',
    form: { rentalId: '', vehicleId: '' },
    lookup: null,
    answers: blankAnswers(),
    answerError: null,
    outcome: null, // { kind: 'case' | 'duplicate', caseId, decision, atVehicleChecked }
    filter: 'open',
    selectedId: null,
  };

  /* ---------- helpers ---------- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  const getCase = (id) => store.cases.find((c) => c.id === id);
  const vehicleOf = (c) => store.db.vehicles.find((v) => v.vehicleId === c.vehicleId);
  const rentalOf = (c) => store.db.rentals.find((r) => r.rentalId === c.rentalId);
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDateTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();
  const when = (iso) => (isToday(iso) ? fmtTime(iso) : fmtDateTime(iso));

  function addEvent(c, actor, text) {
    c.events.push({ at: new Date().toISOString(), actor, text });
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function copy(text) {
    const done = () => toast('Copied to clipboard');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed. Select the text manually.'); }
    ta.remove();
  }

  function slaInfo(c, now) {
    if (!T.isOpen(c)) return { text: c.status, tone: 'muted' };
    if (c.status === 'Troubleshooting' && !c.acknowledged) return { text: 'Self-serve in progress', tone: 'neutral' };
    if (c.acknowledged) return { text: 'Support responded', tone: 'ok' };
    const due = Date.parse(c.slaStart) + c.slaMinutes * MIN;
    const diff = Math.ceil((due - now) / MIN);
    if (diff >= 0) return { text: `Response due in ${diff} min`, tone: diff <= 2 ? 'warn' : 'neutral' };
    return { text: `Response overdue ${-diff} min`, tone: 'bad' };
  }

  const statusTone = (s) => ({ Troubleshooting: 'info', Escalated: 'warn', Dispatched: 'info', Resolved: 'ok', New: 'neutral' }[s] || 'neutral');
  const pill = (text, tone) => `<span class="pill ${tone}">${esc(text)}</span>`;
  const priorityPill = (p) => `<span class="prio prio-${p.toLowerCase()}">${esc(T.PRIORITY_LABEL[p])}</span>`;
  const flagPills = (flags) => flags.map((f) => pill(f.label, f.tone)).join(' ');
  const stepsList = (steps) => `<ol class="steps">${steps.map((s) => `<li><strong>${esc(s.strong)}</strong> ${esc(s.text)}</li>`).join('')}</ol>`;

  /* ---------- actions ---------- */

  function setView(view) {
    ui.view = view;
    render();
    window.scrollTo(0, 0);
  }

  function doLookup() {
    ui.lookup = T.validateLookup(store.db, ui.form, store.cases, Date.now());
    ui.answerError = null;
    if (ui.lookup.ok) {
      ui.form.rentalId = ui.lookup.rental.rentalId;
      ui.form.vehicleId = ui.lookup.vehicle.vehicleId;
    }
    render();
    const target = document.querySelector(ui.lookup.ok ? '#lookupResult' : '.field-error');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function submitCase(forceNew) {
    const now = Date.now();
    const digits = (ui.answers.callback || '').replace(/\D/g, '');
    if (digits.length < 10) {
      ui.answerError = 'Enter a callback number with at least 10 digits so support can reach you.';
      render();
      return;
    }
    // Re-validate: another case may have been opened since the lookup.
    const ctx = T.validateLookup(store.db, ui.form, store.cases, now);
    if (!ctx.ok) { ui.lookup = ctx; render(); return; }

    const answers = { ...ui.answers, safety: [...ui.answers.safety], forceNew: !!forceNew };
    const decision = T.assess(ctx, answers, now);

    if (decision.path === 'duplicate') {
      ui.outcome = { kind: 'duplicate', caseId: ctx.openCase.id, decision, answers };
    } else {
      const id = 'CS-' + store.seq++;
      const c = T.createCase(ctx, answers, decision, now, id);
      store.cases.unshift(c);
      save();
      ui.outcome = { kind: 'case', caseId: id, decision, atVehicleChecked: answers.atVehicle === 'yes' };
      if (decision.path === 'emergency' && ctx.vehicle.telematics.online) setTimeout(() => runUnlock(id), 500);
    }
    ui.selectedId = ui.outcome.caseId;
    setView('outcome');
  }

  function runUnlock(caseId) {
    const c = getCase(caseId);
    if (!c || c.remoteUnlock === 'sending') return;
    c.remoteUnlock = 'sending';
    addEvent(c, 'System', 'Remote unlock command sent to vehicle.');
    save();
    render();
    setTimeout(() => {
      const ok = T.remoteUnlockSucceeds(vehicleOf(c));
      if (ok) {
        c.remoteUnlock = 'success';
        addEvent(c, 'System', 'Vehicle confirmed doors unlocked.');
      } else {
        c.remoteUnlock = 'failed';
        addEvent(c, 'System', 'No unlock confirmation from vehicle after 30s.');
        if (c.status === 'Troubleshooting') escalate(c, 'Remote unlock failed');
      }
      save();
      render();
    }, 1800);
  }

  function escalate(c, reason) {
    const v = vehicleOf(c);
    c.status = 'Escalated';
    if (c.priority === 'P3') c.priority = 'P2';
    c.queue = T.QUEUES.dispatch;
    c.slaMinutes = T.SLA_MINUTES[c.priority];
    c.slaStart = new Date().toISOString();
    c.acknowledged = false;
    c.nextSteps = T.escalationSteps(v, c);
    addEvent(c, 'System', `${reason}. Escalated to ${T.PRIORITY_LABEL[c.priority]} → ${c.queue}.`);
  }

  function resolve(c, actor, resolution) {
    c.status = 'Resolved';
    c.resolution = resolution;
    addEvent(c, actor, `Resolved: ${resolution}.`);
    if (c.followUp) addEvent(c, 'System', `Fleet follow-up created: ${c.followUp}`);
  }

  // Stand-in for the support team working the case, so the full loop can be demoed.
  function simulateSupport(c) {
    const v = vehicleOf(c);
    if (c.status === 'Troubleshooting') {
      addEvent(c, 'Support', 'Checked in: waiting for you to finish the remote-unlock steps. Tap “Still locked out” if they didn’t work.');
    } else if (c.status === 'Escalated' && !c.acknowledged) {
      c.acknowledged = true;
      addEvent(c, 'Support', c.priority === 'P1'
        ? `On-call agent Priya is calling you now at ${c.callback}.`
        : 'Priya picked up the case and is checking the telematics unit’s health.');
    } else if (c.status === 'Escalated') {
      if (c.needsLocation && !c.locationConfirmed) {
        addEvent(c, 'Support', 'Can’t dispatch yet. Waiting for the vehicle’s address, so please add it on this case.');
      } else {
        c.status = 'Dispatched';
        const where = c.locationConfirmed || (v.location && v.location.address) || 'the renter’s location';
        addEvent(c, 'Support', v.fallback
          ? `Spare key on the way (${v.fallback.toLowerCase()}). ETA 25 min to ${where}.`
          : `Locksmith dispatched to ${where}. ETA 35 min. Renter notified by SMS.`);
      }
    } else if (c.status === 'Dispatched') {
      resolve(c, 'Support', v.fallback ? 'Spare key delivered, renter back in the vehicle' : 'Locksmith opened the vehicle, renter confirmed access');
    }
    save();
    render();
  }

  function loadScenario(s) {
    ui.form = { rentalId: s.r, vehicleId: s.v || '' };
    ui.answers = blankAnswers();
    if (s.safety) ui.answers.safety = s.safety.slice();
    if (s.atVehicle) ui.answers.atVehicle = s.atVehicle;
    if (s.keyLocation) ui.answers.keyLocation = s.keyLocation;
    ui.view = 'intake';
    doLookup();
  }

  /* ---------- views ---------- */

  const SCENARIOS = [
    { r: 'R-1001', title: 'Happy path', desc: 'Online vehicle → guided remote unlock' },
    { r: 'R-1002', title: 'Vehicle offline', desc: 'No telematics for 3h → Tier 2 + spare key' },
    { r: 'R-1003', title: 'Location unavailable', desc: 'No GPS fix, unlock fails → dispatch blocked until address given' },
    { r: 'R-1004', title: 'Repeat lockout', desc: '3rd in 30 days → P2 + fleet inspection' },
    { r: 'R-1005', title: 'Already reported', desc: 'Open case exists → no duplicate' },
    { r: 'R-1001', title: 'Safety emergency', desc: 'Child/pet inside → P1, call 911', safety: ['child_pet'] },
    { r: 'R-1001', v: 'V-104', title: 'Wrong vehicle', desc: 'Vehicle isn’t on this rental' },
    { r: 'R-1011', title: 'Mistyped rental ID', desc: 'Not found → closest match offered' },
    { r: 'r 1004', title: 'Messy input', desc: '“r 1004” read as R-1004' },
    { r: 'R-1006', title: 'Rental already ended', desc: 'Logged, but flagged as outside a rental' },
  ];

  function fieldError(field) {
    const l = ui.lookup;
    if (!l || l.ok) return '';
    return l.errors.filter((e) => e.field === field).map((e) => `
      <div class="field-error" role="alert">
        <span>${esc(e.message)}</span>
        ${(e.suggestions || []).map((s) => `<button type="button" class="btn tiny" data-action="suggest" data-set='${esc(JSON.stringify(s.set))}'>${esc(s.label)}</button>`).join('')}
      </div>`).join('');
  }

  function radioGroup(name, options, current) {
    return `<div class="chips">${Object.entries(options).map(([value, label]) => `
      <label class="chip"><input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>`;
  }

  function viewIntake() {
    const l = ui.lookup;
    const now = Date.now();
    return `
    <div class="layout-intake">
      <section class="card">
        <div class="card-head">
          <h1>Report a vehicle lockout</h1>
          <p class="muted">Use this when a renter, or you, can’t get into a vehicle. It takes about a minute, and you get next steps straight away.</p>
        </div>

        <form id="lookupForm" class="step" novalidate>
          <div class="step-label"><span class="step-num">1</span> Which rental?</div>
          <div class="grid-2">
            <div class="field">
              <label for="rentalId">Rental ID</label>
              <input id="rentalId" name="rentalId" value="${esc(ui.form.rentalId)}" placeholder="R-1001" autocomplete="off" class="${l && !l.ok && l.errors.some((e) => e.field === 'rentalId') ? 'invalid' : ''}">
              ${fieldError('rentalId')}
            </div>
            <div class="field">
              <label for="vehicleId">Vehicle ID or plate <em>optional</em></label>
              <input id="vehicleId" name="vehicleId" value="${esc(ui.form.vehicleId)}" placeholder="Filled in from the rental" autocomplete="off" class="${l && !l.ok && l.errors.some((e) => e.field === 'vehicleId') ? 'invalid' : ''}">
              ${fieldError('vehicleId')}
            </div>
          </div>
          <button class="btn primary" type="submit">Look up rental</button>
        </form>

        <div id="lookupResult">${l && l.ok ? rentalSummary(l, now) + situationForm(l) : ''}</div>
      </section>

      <aside class="card scenarios">
        <h2>Demo scenarios</h2>
        <p class="muted small">Each one loads a rental that tests a different branch of the triage rules.</p>
        <ul>
          ${SCENARIOS.map((s, i) => `
            <li><button class="scenario" data-action="scenario" data-index="${i}">
              <strong>${esc(s.title)}</strong><span>${esc(s.desc)}</span><code>${esc(s.r)}${s.v ? ' + ' + esc(s.v) : ''}</code>
            </button></li>`).join('')}
        </ul>
        <button class="btn ghost small" data-action="reset">Reset demo data</button>
      </aside>
    </div>`;
  }

  function rentalSummary(l, now) {
    const { rental, vehicle: v, openCase, priorLockouts } = l;
    const online = v.telematics.online;
    return `
    <div class="rental-card">
      <div class="rc-top">
        <div>
          <div class="rc-title">${esc(v.name)}</div>
          <div class="muted small">${esc(v.vehicleId)} · ${esc(v.plate)} · ${esc(v.color)}</div>
        </div>
        ${pill(online ? 'Online' : 'Offline', online ? 'ok' : 'bad')}
      </div>
      <dl class="facts">
        <div><dt>Rental</dt><dd>${esc(rental.rentalId)} · <span class="cap">${esc(rental.status)}</span> · ${esc(rental.channel)}</dd></div>
        <div><dt>Renter</dt><dd>${esc(rental.renter.name)} · ${esc(rental.renter.phone)}</dd></div>
        <div><dt>Rental window</dt><dd>${fmtDateTime(rental.start)} – ${fmtDateTime(rental.end)}</dd></div>
        <div><dt>Access</dt><dd>${esc(v.access)}</dd></div>
        <div><dt>Telematics</dt><dd>${online ? 'Reporting' : '<span class="t-bad">Silent</span>'} · last ping ${T.formatAgo(v.telematics.lastPing, now)}</dd></div>
        <div><dt>Location</dt><dd>${v.location ? `${esc(v.location.address)} <span class="muted">(${esc(v.location.source)}, ${T.formatAgo(v.location.updated, now)})</span>` : '<span class="t-warn">Unavailable: no GPS fix</span>'}</dd></div>
        <div><dt>Lockouts, last 30 days</dt><dd>${priorLockouts ? `<span class="t-warn">${priorLockouts}</span>` : '0'}</dd></div>
      </dl>
      ${l.notes.map((n) => `<p class="note">✓ ${esc(n)}</p>`).join('')}
      ${l.warnings.map((w) => `<div class="alert warn">${esc(w)}</div>`).join('')}
      ${openCase ? `<div class="alert info"><strong>Already reported:</strong> ${esc(openCase.id)} is open for this ${openCase.rentalId === rental.rentalId ? 'rental' : 'vehicle'} (${esc(openCase.status)}, opened ${T.formatAgo(openCase.createdAt, now)}). Submitting will take you to that case rather than open a duplicate.</div>` : ''}
    </div>`;
  }

  function situationForm() {
    const a = ui.answers;
    const call911 = T.SAFETY_OPTIONS.some((o) => o.call911 && a.safety.includes(o.value));
    return `
    <form id="situationForm" class="step" novalidate>
      <div class="step-label"><span class="step-num">2</span> What’s happening?</div>

      <fieldset><legend>Who is locked out?</legend>${radioGroup('lockedOut', T.LOCKED_OUT, a.lockedOut)}</fieldset>
      <fieldset><legend>Where are the keys?</legend>${radioGroup('keyLocation', T.KEY_LOCATION, a.keyLocation)}</fieldset>
      <fieldset><legend>Is the renter at the vehicle right now?</legend>${radioGroup('atVehicle', { yes: 'Yes, standing by it', no: 'No, not yet' }, a.atVehicle)}</fieldset>

      <fieldset class="safety">
        <legend>Any safety concerns? <span class="muted small">Check any that apply</span></legend>
        <div class="checks">
          ${T.SAFETY_OPTIONS.map((o) => `
            <label class="check"><input type="checkbox" name="safety" value="${o.value}" ${a.safety.includes(o.value) ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}
        </div>
        <div id="banner911" class="alert danger" ${call911 ? '' : 'hidden'}>
          <strong>Call 911 now if anyone is in danger.</strong> Don’t wait for this form. Finish it after the call and we’ll page on-call support.
        </div>
      </fieldset>

      <div class="grid-2">
        <div class="field">
          <label for="callback">Your callback number</label>
          <input id="callback" name="callback" type="tel" value="${esc(a.callback)}" class="${ui.answerError ? 'invalid' : ''}">
          ${ui.answerError ? `<div class="field-error" role="alert"><span>${esc(ui.answerError)}</span></div>` : ''}
        </div>
        <div class="field">
          <label for="notes">Anything else? <em>optional</em></label>
          <textarea id="notes" name="notes" rows="2" placeholder="e.g. renter says the app shows “vehicle asleep”">${esc(a.notes)}</textarea>
        </div>
      </div>
      <button class="btn primary big" type="submit">Get help now</button>
    </form>`;
  }

  const PATH_BANNER = {
    emergency: { tone: 'danger', title: 'Priority emergency: on-call support paged', icon: '!' },
    offline: { tone: 'warn', title: 'Escalated: vehicle offline, a person is stepping in', icon: '↑' },
    troubleshoot: { tone: 'info', title: 'Let’s try to fix this right now', icon: '→' },
    duplicate: { tone: 'info', title: 'This lockout is already being handled', icon: '↻' },
  };

  function viewOutcome() {
    const o = ui.outcome;
    if (!o) return `<div class="card empty">No case yet. <button class="btn link" data-view="intake">Report a lockout</button></div>`;
    const c = getCase(o.caseId);
    const d = o.decision;
    const path = o.kind === 'duplicate' ? 'duplicate' : c.path;
    const b = PATH_BANNER[path];
    const v = vehicleOf(c);
    const r = rentalOf(c);
    const own = o.kind === 'case'; // a duplicate shows someone else's case; don't describe its state as ours
    const escalatedFromSelfServe = own && c.path === 'troubleshoot' && c.status !== 'Troubleshooting' && c.status !== 'Resolved';
    const steps = escalatedFromSelfServe ? c.nextSteps : d.nextSteps;
    const title = escalatedFromSelfServe
      ? 'Remote unlock didn’t work, so this has gone to Tier 2'
      : own && c.status === 'Resolved' ? 'Resolved: this case is closed' : b.title;

    return `
    <div class="layout-outcome">
      <section class="banner ${b.tone}">
        <div class="banner-icon" aria-hidden="true">${b.icon}</div>
        <div>
          <div class="banner-title">${esc(title)}</div>
          <div class="banner-meta">
            <span class="case-id">${esc(c.id)}</span>
            <button class="btn tiny ghost" data-action="copy" data-text="${esc(c.id)}">Copy</button>
            ${priorityPill(c.priority)} ${pill(c.status, statusTone(c.status))}
            <span class="muted small">${esc(c.queue)}</span>
          </div>
        </div>
      </section>

      <div class="grid-outcome">
        <section class="card">
          <h2>What to do now</h2>
          ${stepsList(steps)}
          ${o.kind === 'duplicate' ? duplicatePanel(c, o) : path === 'emergency' ? emergencyPanel(c) : path === 'troubleshoot' ? troubleshootPanel(c, o) : ''}
          ${c.status === 'Resolved' && c.followUp ? `<div class="alert warn"><strong>Fleet follow-up created:</strong> ${esc(c.followUp)}</div>` : ''}
        </section>

        <aside class="stack">
          <section class="card">
            <h2>Why it was routed this way</h2>
            <ul class="reasons">${d.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            ${d.flags.length ? `<div class="flags">${flagPills(d.flags)}</div>` : ''}
            <dl class="facts compact">
              <div><dt>Vehicle</dt><dd>${esc(v.vehicleId)} · ${esc(v.name)}</dd></div>
              <div><dt>Rental</dt><dd>${esc(r.rentalId)} · ${esc(r.renter.name)}</dd></div>
              <div><dt>First response target</dt><dd>${c.slaMinutes} min</dd></div>
            </dl>
          </section>
          <section class="card">
            <h2>Message to send your renter</h2>
            <textarea id="renterMsg" rows="5">${esc(o.kind === 'duplicate' ? d.renterMessage : c.renterMessage)}</textarea>
            <div class="row"><button class="btn small" data-action="copy-msg">Copy message</button><span class="muted small">Edit it first if you like.</span></div>
          </section>
        </aside>
      </div>

      <div class="row end">
        <button class="btn ghost" data-action="new-report">Report another lockout</button>
        <button class="btn primary" data-action="track" data-id="${esc(c.id)}">Track this case →</button>
      </div>
    </div>`;
  }

  function unlockStatus(c) {
    switch (c.remoteUnlock) {
      case 'sending': return `<div class="unlock sending"><span class="spinner"></span> Sending unlock… waiting for the vehicle to confirm</div>`;
      case 'success': return `<div class="unlock ok">✓ Vehicle confirmed doors unlocked</div>`;
      case 'failed': return `<div class="unlock bad">✕ No confirmation from the vehicle</div>`;
      default: return '';
    }
  }

  function troubleshootPanel(c, o) {
    if (c.status === 'Resolved') return `<div class="alert ok">Case closed at ${fmtTime(c.events[c.events.length - 1].at)}. Nothing else to do.</div>`;
    if (c.status !== 'Troubleshooting') {
      return `${unlockStatus(c)}<p class="muted small">We’ll call ${esc(c.callback)} within ${c.slaMinutes} min. Follow progress in the case tracker.</p>`;
    }
    const ready = o.atVehicleChecked;
    return `
    <div class="panel">
      <h3>Remote unlock</h3>
      <label class="check"><input type="checkbox" data-action="at-vehicle" ${ready ? 'checked' : ''}><span>Renter is standing at the vehicle</span></label>
      ${unlockStatus(c)}
      ${c.remoteUnlock === 'success' ? `
        <p><strong>Did the renter get in?</strong></p>
        <div class="row">
          <button class="btn primary" data-action="confirm-in" data-id="${esc(c.id)}">Yes, they’re in</button>
          <button class="btn" data-action="still-locked" data-id="${esc(c.id)}">Still locked out</button>
        </div>` : `
        <button class="btn primary" data-action="unlock" data-id="${esc(c.id)}" ${ready && c.remoteUnlock !== 'sending' ? '' : 'disabled'}>Send remote unlock</button>
        ${ready ? '' : '<p class="muted small">Tick the box once the renter is at the car.</p>'}`}
    </div>`;
  }

  function emergencyPanel(c) {
    const v = vehicleOf(c);
    return `
    <div class="panel">
      <h3>In parallel</h3>
      ${v.telematics.online ? unlockStatus(c) || '<div class="unlock sending"><span class="spinner"></span> Starting remote unlock…</div>' : '<div class="unlock bad">Vehicle offline, so remote unlock isn’t possible</div>'}
      <p class="muted small">On-call support has been paged. First response target is ${c.slaMinutes} minutes.</p>
      ${c.status !== 'Resolved' ? `<button class="btn" data-action="resolve-quick" data-id="${esc(c.id)}">Everyone is safe and the renter is in: close case</button>` : ''}
    </div>`;
  }

  function duplicatePanel(c, o) {
    return `
    <div class="panel">
      <h3>Add an update to ${esc(c.id)}</h3>
      <textarea id="dupNote" rows="3" placeholder="e.g. renter moved to the lobby at 3401 N Miami Ave">${esc(o.answers.notes)}</textarea>
      <div class="row">
        <button class="btn primary" data-action="dup-update" data-id="${esc(c.id)}">Add update</button>
        <button class="btn" data-action="force-new">It’s a separate issue: open a new case</button>
      </div>
      <h3>Latest on this case</h3>
      ${timeline(c.events.slice(-3))}
    </div>`;
  }

  function timeline(events) {
    return `<ol class="timeline">${events.slice().reverse().map((e) => `
      <li class="actor-${e.actor.toLowerCase()}">
        <div class="tl-meta"><span class="tl-actor">${esc(e.actor)}</span> <time>${when(e.at)}</time></div>
        <div>${esc(e.text)}</div>
      </li>`).join('')}</ol>`;
  }

  function viewTracker() {
    const now = Date.now();
    const list = store.cases
      .filter((c) => (ui.filter === 'open' ? T.isOpen(c) : ui.filter === 'resolved' ? !T.isOpen(c) : true))
      .sort((a, b) => (T.isOpen(b) - T.isOpen(a)) || a.priority.localeCompare(b.priority) || b.createdAt.localeCompare(a.createdAt));
    // Keep showing the selected case even if it just left the current filter (e.g. resolved while viewing "Open").
    if (!ui.selectedId || !getCase(ui.selectedId)) ui.selectedId = list[0] ? list[0].id : null;
    const sel = ui.selectedId && getCase(ui.selectedId);
    const counts = {
      open: store.cases.filter(T.isOpen).length,
      resolved: store.cases.filter((c) => !T.isOpen(c)).length,
      all: store.cases.length,
    };

    return `
    <div class="layout-tracker">
      <section class="card list-card">
        <div class="list-head">
          <h1>Cases</h1>
          <div class="seg" role="tablist">
            ${['open', 'resolved', 'all'].map((f) => `<button class="${ui.filter === f ? 'on' : ''}" data-action="filter" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)} <span>${counts[f]}</span></button>`).join('')}
          </div>
        </div>
        ${list.length ? `<ul class="case-list">${list.map((c) => {
          const v = vehicleOf(c);
          const s = slaInfo(c, now);
          return `<li><button class="case-row ${c.id === ui.selectedId ? 'on' : ''}" data-action="select" data-id="${esc(c.id)}">
            <span class="dot prio-${c.priority.toLowerCase()}"></span>
            <span class="cr-main"><strong>${esc(c.id)}</strong> <span class="muted">${esc(v.name)}</span><br><span class="small">${esc(c.summary)}</span></span>
            <span class="cr-side">${pill(c.status, statusTone(c.status))}<span class="small t-${s.tone}" data-sla="${esc(c.id)}">${esc(s.text)}</span></span>
          </button></li>`;
        }).join('')}</ul>` : `<p class="muted empty">No ${ui.filter === 'all' ? '' : ui.filter} cases.</p>`}
      </section>
      <section class="card detail-card">${sel ? caseDetail(sel, now) : '<p class="muted empty">Select a case.</p>'}</section>
    </div>`;
  }

  const RESOLUTIONS = [
    'Renter back in the vehicle',
    'Spare key used',
    'Locksmith opened the vehicle',
    'Renter resolved it themselves',
    'Reported in error / duplicate',
  ];

  function caseDetail(c, now) {
    const v = vehicleOf(c);
    const r = rentalOf(c);
    const open = T.isOpen(c);
    const s = slaInfo(c, now);
    const blocked = open && c.needsLocation && !c.locationConfirmed && c.status !== 'Troubleshooting';
    return `
      <div class="detail-head">
        <div>
          <h2 class="case-id">${esc(c.id)}</h2>
          <div class="muted small">Opened ${when(c.createdAt)} · ${esc(c.queue)}</div>
        </div>
        <div class="row">${priorityPill(c.priority)} ${pill(c.status, statusTone(c.status))}</div>
      </div>

      ${progress(c)}

      <div class="sla-line t-${s.tone}" data-sla="${esc(c.id)}">${esc(s.text)}</div>

      <dl class="facts compact">
        <div><dt>Issue</dt><dd>${esc(c.summary)}</dd></div>
        <div><dt>Vehicle</dt><dd>${esc(v.vehicleId)} · ${esc(v.name)} · ${esc(v.plate)}</dd></div>
        <div><dt>Rental</dt><dd>${esc(r.rentalId)} · ${esc(r.renter.name)} · ${esc(r.renter.phone)}</dd></div>
        <div><dt>Location</dt><dd>${c.locationConfirmed ? esc(c.locationConfirmed) + ' <span class="muted">(confirmed by operator)</span>' : v.location ? esc(v.location.address) : '<span class="t-warn">Unknown</span>'}</dd></div>
        <div><dt>Callback</dt><dd>${esc(c.callback)}</dd></div>
        ${c.linkedCase ? `<div><dt>Linked case</dt><dd><button class="btn link" data-action="select" data-id="${esc(c.linkedCase)}">${esc(c.linkedCase)}</button></dd></div>` : ''}
        ${c.resolution ? `<div><dt>Resolution</dt><dd>${esc(c.resolution)}</dd></div>` : ''}
      </dl>
      ${c.flags.length ? `<div class="flags">${flagPills(c.flags)}</div>` : ''}
      ${c.followUp && c.status === 'Resolved' ? `<div class="alert warn"><strong>Fleet follow-up:</strong> ${esc(c.followUp)}</div>` : ''}

      ${blocked ? `
        <div class="alert warn">
          <strong>Dispatch is on hold until we have the vehicle’s location.</strong>
          <div class="row"><input id="locInput" placeholder="Street address or cross streets"><button class="btn small" data-action="confirm-loc" data-id="${esc(c.id)}">Confirm location</button></div>
        </div>` : ''}

      ${open && c.status === 'Troubleshooting' ? `<div class="alert info">Self-serve steps are in progress. <button class="btn link" data-action="open-outcome" data-id="${esc(c.id)}">Open the unlock screen</button></div>` : ''}

      <h3>Activity</h3>
      ${timeline(c.events)}

      <div class="actions">
        <div class="field">
          <label for="noteInput">Add a note</label>
          <div class="row"><input id="noteInput" placeholder="e.g. Renter moved to the lobby"><button class="btn small" data-action="note" data-id="${esc(c.id)}">Add</button></div>
        </div>
        ${open ? `
          <div class="row wrap">
            <button class="btn" data-action="simulate" data-id="${esc(c.id)}" title="Stand-in for the support team working the case">▶ Simulate support update</button>
            <select id="resolutionSel" aria-label="Resolution">${RESOLUTIONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
            <button class="btn primary" data-action="resolve" data-id="${esc(c.id)}">Mark resolved</button>
          </div>` : `<button class="btn" data-action="reopen" data-id="${esc(c.id)}">Reopen case</button>`}
      </div>`;
  }

  function progress(c) {
    const stages = c.path === 'troubleshoot' && !c.events.some((e) => /Escalated/.test(e.text))
      ? ['Reported', 'Troubleshooting', 'Resolved']
      : ['Reported', 'Escalated', 'Support responding', 'Dispatched', 'Resolved'];
    let idx;
    if (c.status === 'Resolved') idx = stages.length; // every stage done
    else if (c.status === 'Troubleshooting') idx = 1;
    else if (c.status === 'Dispatched') idx = 3;
    else idx = c.acknowledged ? 2 : 1;
    return `<ol class="progress">${stages.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'current' : ''}">${esc(s)}</li>`).join('')}</ol>`;
  }

  /* ---------- render + events ---------- */

  function render() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === ui.view);
      b.setAttribute('aria-selected', b.dataset.view === ui.view);
      if (b.dataset.view === 'outcome') b.disabled = !ui.outcome;
    });
    const open = store.cases.filter(T.isOpen).length;
    document.getElementById('openCount').textContent = open ? open : '';
    $app.innerHTML = ui.view === 'intake' ? viewIntake() : ui.view === 'outcome' ? viewOutcome() : viewTracker();
  }

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $app.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'lookupForm') doLookup();
    if (e.target.id === 'situationForm') submitCase(false);
  });

  $app.addEventListener('input', (e) => {
    const el = e.target;
    if (el.name === 'rentalId' || el.name === 'vehicleId') {
      ui.form[el.name] = el.value;
      if (ui.lookup) { // stale lookup: hide results without re-rendering the input being typed in
        ui.lookup = null;
        document.getElementById('lookupResult').innerHTML = '';
        document.querySelectorAll('#lookupForm .field-error').forEach((n) => n.remove());
        document.querySelectorAll('#lookupForm .invalid').forEach((n) => n.classList.remove('invalid'));
      }
    } else if (el.name === 'callback' || el.name === 'notes') {
      ui.answers[el.name] = el.value;
    }
  });

  $app.addEventListener('change', (e) => {
    const el = e.target;
    if (['lockedOut', 'keyLocation', 'atVehicle'].includes(el.name)) ui.answers[el.name] = el.value;
    if (el.name === 'safety') {
      ui.answers.safety = [...document.querySelectorAll('input[name=safety]:checked')].map((x) => x.value);
      const call911 = T.SAFETY_OPTIONS.some((o) => o.call911 && ui.answers.safety.includes(o.value));
      document.getElementById('banner911').hidden = !call911;
    }
    if (el.dataset.action === 'at-vehicle') {
      ui.outcome.atVehicleChecked = el.checked;
      if (el.checked) addEvent(getCase(ui.outcome.caseId), 'Operator', 'Confirmed renter is at the vehicle.');
      save();
      render();
    }
  });

  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-view]');
    if (!el) return;
    if (el.dataset.view && !el.dataset.action) return setView(el.dataset.view);
    const id = el.dataset.id;
    const c = id && getCase(id);

    switch (el.dataset.action) {
      case 'scenario': return loadScenario(SCENARIOS[+el.dataset.index]);
      case 'suggest': Object.assign(ui.form, JSON.parse(el.dataset.set)); return doLookup();
      case 'reset':
        if (!confirm('Reset all demo cases and data?')) return;
        store = freshStore();
        save();
        Object.assign(ui, { form: { rentalId: '', vehicleId: '' }, lookup: null, answers: blankAnswers(), outcome: null, selectedId: null, answerError: null });
        render();
        return toast('Demo data reset');
      case 'copy': return copy(el.dataset.text);
      case 'copy-msg': return copy(document.getElementById('renterMsg').value);
      case 'unlock': return runUnlock(id);
      case 'confirm-in':
        resolve(c, 'Operator', 'Remote unlock: renter confirmed access');
        save();
        return render();
      case 'still-locked':
        escalate(c, 'Vehicle reported unlocked but renter still can’t get in');
        save();
        return render();
      case 'resolve-quick':
        resolve(c, 'Operator', 'Everyone safe, renter back in the vehicle');
        save();
        return render();
      case 'dup-update': {
        const text = document.getElementById('dupNote').value.trim();
        if (!text) return toast('Write the update first');
        addEvent(c, 'Operator', `Update: ${text}`);
        save();
        render();
        return toast(`Update added to ${c.id}`);
      }
      case 'force-new': return submitCase(true);
      case 'new-report':
        Object.assign(ui, { form: { rentalId: '', vehicleId: '' }, lookup: null, answers: blankAnswers(), answerError: null });
        return setView('intake');
      case 'track':
      case 'select':
        ui.selectedId = id;
        if (ui.filter !== 'all' && (ui.filter === 'open') !== T.isOpen(c)) ui.filter = 'all'; // make sure it's visible
        return setView('tracker');
      case 'open-outcome':
        ui.outcome = { kind: 'case', caseId: id, decision: { reasons: c.reasons, flags: c.flags, nextSteps: c.nextSteps, renterMessage: c.renterMessage }, atVehicleChecked: c.answers.atVehicle === 'yes' };
        return setView('outcome');
      case 'filter':
        ui.filter = el.dataset.filter;
        ui.selectedId = null;
        return render();
      case 'note': {
        const text = document.getElementById('noteInput').value.trim();
        if (!text) return toast('Write a note first');
        addEvent(c, 'Operator', text);
        save();
        return render();
      }
      case 'confirm-loc': {
        const text = document.getElementById('locInput').value.trim();
        if (text.length < 5) return toast('Enter an address or cross streets');
        c.locationConfirmed = text;
        addEvent(c, 'Operator', `Confirmed vehicle location: ${text}.`);
        save();
        return render();
      }
      case 'simulate': return simulateSupport(c);
      case 'resolve':
        resolve(c, 'Operator', document.getElementById('resolutionSel').value);
        save();
        return render();
      case 'reopen':
        c.status = 'Escalated';
        c.resolution = null;
        c.acknowledged = false;
        c.slaStart = new Date().toISOString();
        addEvent(c, 'Operator', 'Case reopened.');
        save();
        return render();
    }
  });

  // Keep SLA countdowns live without re-rendering (which would wipe half-typed notes).
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-sla]').forEach((el) => {
      const c = getCase(el.dataset.sla);
      if (!c) return;
      const s = slaInfo(c, now);
      el.textContent = s.text;
      el.className = el.className.replace(/t-\w+/, 't-' + s.tone);
    });
  }, 15000);

  render();
})();
