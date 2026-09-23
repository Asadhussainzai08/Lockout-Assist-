/*
 * Triage engine for vehicle lockouts.
 * Pure functions only (no DOM, no storage) so the rules can be read, tested and changed in one place.
 */
(function (root) {
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;

  const SLA_MINUTES = { P1: 5, P2: 15, P3: 60 };
  const PRIORITY_LABEL = { P1: 'P1 · Critical', P2: 'P2 · High', P3: 'P3 · Standard' };
  const QUEUES = {
    emergency: 'On-call emergency support',
    dispatch: 'Tier 2 · Telematics & dispatch',
    selfServe: 'Tier 1 · Guided self-serve',
  };
  const OPEN_STATUSES = ['New', 'Troubleshooting', 'Escalated', 'Dispatched'];

  const SAFETY_OPTIONS = [
    { value: 'child_pet', label: 'A child or pet is locked inside', call911: true },
    { value: 'medical', label: 'Someone needs medical help', call911: true },
    { value: 'unsafe_location', label: 'Renter is stranded somewhere unsafe' },
    { value: 'weather', label: 'Exposure to extreme heat or cold' },
  ];
  const LOCKED_OUT = { renter: 'Renter', operator: 'Operator', staff: 'Cleaner / delivery driver' };
  const KEY_LOCATION = {
    phone_key: 'Phone key / app won’t unlock',
    inside: 'Physical key locked inside',
    lost: 'Key or key card lost',
    unknown: 'Not sure',
  };

  const isOpen = (c) => OPEN_STATUSES.includes(c.status);

  function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return dp[a.length][b.length];
  }

  // Accepts messy input like "r1001", " 1001 ", "R 1001" and reads it as "R-1001".
  function normalizeId(raw, prefix) {
    const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return { empty: true };
    const m = s.match(new RegExp('^(?:' + prefix + '-?)?(\\d{3,6})$'));
    if (!m) return { valid: false, value: s };
    const value = prefix + '-' + m[1];
    return { valid: true, value, corrected: value !== s };
  }

  function formatAgo(iso, now) {
    const mins = Math.round((now - Date.parse(iso)) / MIN);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return h + 'h' + (m ? ' ' + m + 'm' : '') + ' ago';
    const d = Math.floor(h / 24);
    return d + (d === 1 ? ' day' : ' days') + ' ago';
  }

  function findOpenCase(cases, rentalId, vehicleId) {
    return cases.find((c) => isOpen(c) && (c.rentalId === rentalId || c.vehicleId === vehicleId)) || null;
  }

  function recentLockouts(vehicle, cases, now) {
    const cutoff = now - 30 * DAY;
    const fromHistory = vehicle.lockouts.filter((iso) => Date.parse(iso) >= cutoff).length;
    const fromCases = cases.filter(
      (c) => c.vehicleId === vehicle.vehicleId && Date.parse(c.createdAt) >= cutoff
    ).length;
    return fromHistory + fromCases;
  }

  /* ---------- Step 1: validate rental + vehicle ---------- */

  function validateLookup(db, input, cases, now) {
    const errors = [];
    const warnings = [];
    const notes = [];
    const fail = () => ({ ok: false, errors, warnings, notes });

    const r = normalizeId(input.rentalId, 'R');
    if (r.empty) {
      errors.push({ field: 'rentalId', message: 'Enter the rental (reservation) ID from the booking.' });
      return fail();
    }
    if (!r.valid) {
      errors.push({
        field: 'rentalId',
        message: `“${String(input.rentalId).trim()}” doesn’t look like a rental ID. Rental IDs look like R-1001.`,
      });
      return fail();
    }
    if (r.corrected) notes.push(`Read “${String(input.rentalId).trim()}” as ${r.value}.`);

    const rental = db.rentals.find((x) => x.rentalId === r.value);
    if (!rental) {
      const close = db.rentals.filter((x) => levenshtein(x.rentalId, r.value) <= 1);
      errors.push({
        field: 'rentalId',
        message:
          `No rental found for ${r.value}.` +
          (close.length ? ' Did you mean one of these?' : ' Check the booking confirmation or your reservations list.'),
        suggestions: close.map((x) => ({ label: `Use ${x.rentalId}`, set: { rentalId: x.rentalId, vehicleId: '' } })),
      });
      return fail();
    }

    const assigned = db.vehicles.find((v) => v.vehicleId === rental.vehicleId);
    const rawVehicle = String(input.vehicleId || '').trim();
    if (!rawVehicle) {
      notes.push(`Vehicle filled in from the rental: ${assigned.vehicleId} (${assigned.name}).`);
    } else {
      const v = normalizeId(rawVehicle, 'V');
      const plateKey = rawVehicle.toUpperCase().replace(/[\s-]/g, '');
      const byPlate = db.vehicles.find((x) => x.plate.replace(/[\s-]/g, '') === plateKey);
      const vid = v.valid ? v.value : byPlate ? byPlate.vehicleId : null;
      const useAssigned = {
        label: `Use ${assigned.vehicleId} (on ${rental.rentalId})`,
        set: { vehicleId: assigned.vehicleId },
      };

      if (!vid) {
        errors.push({
          field: 'vehicleId',
          message: `“${rawVehicle}” isn’t a vehicle ID or plate we recognise. Vehicle IDs look like V-101.`,
          suggestions: [useAssigned],
        });
      } else if (vid !== rental.vehicleId) {
        const other = db.vehicles.find((x) => x.vehicleId === vid);
        const otherRental = other && db.rentals.find((x) => x.vehicleId === vid && x.status === 'active');
        const suggestions = [useAssigned];
        if (otherRental) {
          suggestions.push({
            label: `Switch to ${otherRental.rentalId} (${vid})`,
            set: { rentalId: otherRental.rentalId, vehicleId: vid },
          });
        }
        errors.push({
          field: 'vehicleId',
          message: other
            ? `${vid} isn’t on ${rental.rentalId}. That rental is for ${assigned.vehicleId} (${assigned.name})` +
              (otherRental ? `, and ${vid} is on ${otherRental.rentalId}.` : '.')
            : `No vehicle found for ${vid}.`,
          suggestions,
        });
      } else if (!v.valid && byPlate) {
        notes.push(`Matched plate ${byPlate.plate} to ${byPlate.vehicleId}.`);
      }
    }
    if (errors.length) return fail();

    if (rental.status === 'completed') {
      warnings.push(
        `${rental.rentalId} ended ${formatAgo(rental.end, now)}. You can still log this, but it will be flagged as outside an active rental.`
      );
    } else if (rental.status === 'upcoming') {
      warnings.push(`${rental.rentalId} hasn’t started yet. It will be flagged as outside an active rental.`);
    }

    return {
      ok: true,
      errors,
      warnings,
      notes,
      rental,
      vehicle: assigned,
      openCase: findOpenCase(cases, rental.rentalId, assigned.vehicleId),
      priorLockouts: recentLockouts(assigned, cases, now),
    };
  }

  /* ---------- Step 2: decide urgency, route and next steps ---------- */

  function assess(ctx, answers, now) {
    const { rental, vehicle, openCase, priorLockouts } = ctx;
    const safety = answers.safety || [];
    const online = vehicle.telematics.online;
    const hasLocation = !!vehicle.location;
    const repeat = priorLockouts >= 1;
    const reasons = [];
    const flags = [];

    if (safety.length) flags.push({ code: 'SAFETY', tone: 'bad', label: 'Safety concern' });
    if (!online) {
      flags.push({
        code: 'OFFLINE',
        tone: 'bad',
        label: `Vehicle offline · last ping ${formatAgo(vehicle.telematics.lastPing, now)}`,
      });
    }
    if (!hasLocation) flags.push({ code: 'NO_LOCATION', tone: 'warn', label: 'Location unavailable' });
    if (repeat) {
      flags.push({
        code: 'REPEAT',
        tone: 'warn',
        label: `Repeat lockout · #${priorLockouts + 1} in 30 days`,
      });
    }
    if (rental.status !== 'active') {
      flags.push({ code: 'RENTAL_INACTIVE', tone: 'warn', label: `Rental ${rental.status}` });
    }

    let path, priority, queue;
    if (safety.length) {
      path = 'emergency';
      priority = 'P1';
      queue = QUEUES.emergency;
      const labels = SAFETY_OPTIONS.filter((o) => safety.includes(o.value)).map((o) => o.label.toLowerCase());
      reasons.push(`Safety concern reported (${labels.join('; ')}). This overrides every other rule and goes straight to on-call support.`);
      if (openCase) {
        reasons.push(`${openCase.id} is already open for this vehicle. Safety issues still get their own P1 case, linked to it.`);
      }
    } else if (openCase && !answers.forceNew) {
      path = 'duplicate';
      priority = openCase.priority;
      queue = openCase.queue;
      const scope = openCase.rentalId === rental.rentalId ? 'rental' : 'vehicle';
      reasons.push(
        `${openCase.id} is already open for this ${scope} (status: ${openCase.status}). A second case would split the history and could send two locksmiths.`
      );
    } else if (!online) {
      path = 'offline';
      priority = 'P2';
      queue = QUEUES.dispatch;
      reasons.push(
        `The telematics device hasn’t reported since ${formatAgo(vehicle.telematics.lastPing, now)}, so a remote unlock can’t reach the car. A person needs to step in with a spare key or a locksmith.`
      );
    } else {
      path = 'troubleshoot';
      priority = repeat ? 'P2' : 'P3';
      queue = QUEUES.selfServe;
      reasons.push('The vehicle is online, so a remote unlock should fix this in under a minute without waiting for an agent.');
      if (repeat) {
        reasons.push(
          `Raised to P2: this is lockout #${priorLockouts + 1} for ${vehicle.vehicleId} in 30 days. That points to a device or key fault, not user error.`
        );
      }
      if (answers.atVehicle === 'no') {
        reasons.push('The renter isn’t at the vehicle yet, so hold the unlock until they are. Otherwise the car sits unlocked.');
      }
    }

    if (!hasLocation && path !== 'duplicate') {
      reasons.push('No GPS fix, so we need the address from the renter before anyone can be dispatched.');
    }
    if (rental.status !== 'active' && path !== 'duplicate') {
      reasons.push(`The rental is ${rental.status}, so this is logged as outside an active rental for billing and insurance review.`);
    }
    if (openCase && answers.forceNew && path !== 'emergency') {
      reasons.push(`Operator confirmed this is separate from ${openCase.id}, so a new case is linked to it.`);
    }

    return {
      path,
      priority,
      priorityLabel: PRIORITY_LABEL[priority],
      queue,
      slaMinutes: SLA_MINUTES[priority],
      flags,
      reasons,
      nextSteps: buildNextSteps(path, ctx, answers, now),
      renterMessage: buildRenterMessage(path, ctx, answers),
      needsLocation: !hasLocation,
      followUp: repeat
        ? `Inspect the telematics unit and key/key card on ${vehicle.vehicleId} before its next rental (lockout #${priorLockouts + 1} in 30 days).`
        : null,
    };
  }

  function buildNextSteps(path, ctx, answers, now) {
    const { vehicle, openCase } = ctx;
    const online = vehicle.telematics.online;
    const loc = vehicle.location;
    const steps = [];

    if (path === 'emergency') {
      const call911 = SAFETY_OPTIONS.some((o) => o.call911 && answers.safety.includes(o.value));
      if (call911) {
        steps.push({ strong: 'Call 911 now.', text: 'Emergency services can open a vehicle faster than any locksmith. Do this before anything else.' });
      } else {
        steps.push({ strong: 'Get the renter somewhere safe first.', text: 'A nearby open business or a well-lit public spot. The car can wait.' });
      }
      steps.push({ strong: 'Keep your phone free.', text: `On-call support will call ${answers.callback} within 5 minutes.` });
      steps.push(
        online
          ? { strong: 'Remote unlock is being sent now.', text: 'We start it right away and it runs alongside everything else.' }
          : { strong: 'The vehicle is offline.', text: 'Remote unlock isn’t possible, so support is lining up the nearest locksmith as backup.' }
      );
      if (!loc) {
        steps.push({ strong: 'Get the exact location.', text: 'Ask the renter for a street address or a dropped pin, and share it with 911 and with us.' });
      }
      return steps;
    }

    if (path === 'duplicate') {
      steps.push({ strong: 'Don’t open a new case.', text: `${openCase.id} is already ${openCase.status.toLowerCase()} with ${openCase.queue}.` });
      steps.push({ strong: 'Add what’s new.', text: 'Post a changed location, a new callback number or anything the renter just told you as an update on that case.' });
      steps.push({ strong: 'Different problem?', text: 'Choose “It’s a separate issue” and we’ll open a new case linked to this one.' });
      return steps;
    }

    if (path === 'offline') {
      steps.push(
        vehicle.fallback
          ? { strong: 'Fastest fix: spare key.', text: vehicle.fallback + '.' }
          : { strong: 'No spare key on file.', text: 'Support will send a locksmith.' }
      );
      steps.push(
        loc
          ? { strong: 'Confirm the location.', text: `Last known: ${loc.address} (${formatAgo(loc.updated, now)}). Check the car is still there.` }
          : { strong: 'Get the exact address.', text: 'Ask the renter for it. We can’t dispatch without it.' }
      );
      steps.push({ strong: 'Have the renter try once more.', text: 'Garages and dead zones drop the signal, and the device may reconnect if the car is moved into coverage.' });
      steps.push({ strong: 'Expect a call within 15 minutes', text: 'with an ETA. Consider offering the renter a credit for the delay.' });
      return steps;
    }

    // troubleshoot
    steps.push(
      answers.atVehicle === 'no'
        ? { strong: 'Wait until the renter is at the vehicle', text: 'before unlocking, so the car isn’t left open.' }
        : { strong: 'Confirm the renter is at the vehicle.', text: 'They should be standing by the driver’s door.' }
    );
    if (answers.keyLocation === 'phone_key') {
      steps.push({ strong: 'Quick phone-key check:', text: 'close and reopen the app, turn Bluetooth on, hold the phone near the driver’s door handle.' });
    } else if (answers.keyLocation === 'inside') {
      steps.push({ strong: 'Keys are inside.', text: 'A remote unlock will let them in to get the keys.' });
    } else if (answers.keyLocation === 'lost') {
      steps.push({ strong: 'Key lost.', text: 'Unlock now, then handle the replacement fee under your rental agreement.' });
    }
    steps.push({ strong: 'Send a remote unlock below.', text: 'If it doesn’t work we escalate automatically, so you won’t have to start over.' });
    return steps;
  }

  function escalationSteps(vehicle, c) {
    const steps = [];
    steps.push(
      vehicle.fallback
        ? { strong: 'Fastest fix: spare key.', text: vehicle.fallback + '.' }
        : { strong: 'Locksmith being arranged.', text: 'No spare key on file for this vehicle.' }
    );
    if (c.needsLocation && !c.locationConfirmed) {
      steps.push({ strong: 'We need the vehicle’s address', text: 'before we can dispatch. Add it in the case tracker.' });
    }
    steps.push({ strong: 'Expect a call within 15 minutes', text: `at ${c.callback} with an ETA.` });
    return steps;
  }

  function buildRenterMessage(path, ctx, answers) {
    const first = ctx.rental.renter.name.split(' ')[0];
    const v = ctx.vehicle;
    switch (path) {
      case 'emergency':
        return `Hi ${first}, we’ve alerted our emergency team and are working to get you back into the ${v.name}. If anyone is in danger, please call 911 right now. We’ll call you within minutes.`;
      case 'duplicate':
        return `Hi ${first}, we’re already working on this (case ${ctx.openCase.id}) and will text you as soon as we have an update.`;
      case 'offline':
        return `Hi ${first}, sorry about this. The ${v.name} isn’t responding to our remote unlock, so we’re sending ${v.fallback ? 'someone with a spare key' : 'a locksmith'}. Please wait somewhere safe nearby. We’ll text you an ETA shortly, and you won’t lose rental time over this.`;
      default:
        return answers.atVehicle === 'no'
          ? `Hi ${first}, we can unlock the ${v.name} remotely. Text us when you’re standing next to it and we’ll unlock it right away.`
          : `Hi ${first}, we’re unlocking the ${v.name} remotely now. Stay by the driver’s door and it should open within 30 seconds. Reply here if it doesn’t.`;
    }
  }

  /* ---------- Case creation ---------- */

  function createCase(ctx, answers, decision, now, id) {
    const at = new Date(now).toISOString();
    const summary = `${LOCKED_OUT[answers.lockedOut]} locked out · ${KEY_LOCATION[answers.keyLocation]}`;
    const events = [
      { at, actor: 'Operator', text: `Lockout reported: ${summary}.${answers.notes ? ' Notes: ' + answers.notes : ''}` },
      { at, actor: 'System', text: `Triaged as ${decision.priorityLabel} → ${decision.queue}.` },
    ];
    if (ctx.openCase && decision.path !== 'duplicate') {
      events.push({ at, actor: 'System', text: `Linked to related open case ${ctx.openCase.id}.` });
    }
    return {
      id,
      rentalId: ctx.rental.rentalId,
      vehicleId: ctx.vehicle.vehicleId,
      createdAt: at,
      status: decision.path === 'troubleshoot' ? 'Troubleshooting' : 'Escalated',
      priority: decision.priority,
      queue: decision.queue,
      path: decision.path,
      summary,
      flags: decision.flags,
      reasons: decision.reasons,
      nextSteps: decision.nextSteps,
      renterMessage: decision.renterMessage,
      answers: { ...answers },
      callback: answers.callback,
      slaMinutes: decision.slaMinutes,
      slaStart: at,
      acknowledged: false,
      needsLocation: decision.needsLocation,
      locationConfirmed: null,
      followUp: decision.followUp,
      linkedCase: ctx.openCase && decision.path !== 'duplicate' ? ctx.openCase.id : null,
      remoteUnlock: null,
      resolution: null,
      events,
    };
  }

  const remoteUnlockSucceeds = (vehicle) => vehicle.telematics.online && vehicle.remoteUnlockWorks;

  const api = {
    SLA_MINUTES,
    PRIORITY_LABEL,
    QUEUES,
    SAFETY_OPTIONS,
    LOCKED_OUT,
    KEY_LOCATION,
    isOpen,
    normalizeId,
    formatAgo,
    findOpenCase,
    recentLockouts,
    validateLookup,
    assess,
    escalationSteps,
    createCase,
    remoteUnlockSucceeds,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Triage = api;
})(typeof window !== 'undefined' ? window : globalThis);
