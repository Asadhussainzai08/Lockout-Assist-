/*
 * Mock data standing in for the operator's reservations, fleet and telematics feeds.
 * Timestamps are generated relative to "now" on first load so the demo always looks live.
 * Each rental is set up to exercise one scenario in the triage rules.
 */
(function (root) {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  function buildSeed(now) {
    const t = (offset) => new Date(now + offset).toISOString();

    const operator = { name: 'Dana Ortiz', business: 'Sunshine Coast Rentals', phone: '(305) 555-0199' };

    const vehicles = [
      {
        vehicleId: 'V-101', name: '2023 Tesla Model 3', plate: 'LKD 2231', color: 'Pearl White',
        access: 'Phone key (app-based keyless)', fallback: null,
        telematics: { provider: 'OEM connected-car API', online: true, lastPing: t(-1 * MIN) },
        location: { address: '1450 Brickell Ave, Miami, FL 33131', source: 'GPS', updated: t(-1 * MIN) },
        remoteUnlockWorks: true, lockouts: [],
      },
      {
        vehicleId: 'V-102', name: '2022 Toyota Camry SE', plate: 'MQR 8840', color: 'Midnight Black',
        access: 'Keyless via aftermarket telematics unit',
        fallback: 'Spare key in the lockbox at your lot on NW 7th St (2.4 mi away)',
        telematics: { provider: 'Aftermarket GPS / immobilizer', online: false, lastPing: t(-3 * HOUR - 12 * MIN) },
        location: {
          address: 'Dolphin Mall parking garage, Level P3, Miami, FL 33172',
          source: 'Last known GPS', updated: t(-3 * HOUR - 12 * MIN),
        },
        remoteUnlockWorks: false, lockouts: [],
      },
      {
        vehicleId: 'V-103', name: '2024 Hyundai Elantra', plate: 'TJW 5102', color: 'Intense Blue',
        access: 'Keyless via aftermarket telematics unit', fallback: null,
        telematics: { provider: 'Aftermarket GPS / immobilizer', online: true, lastPing: t(-2 * MIN) },
        location: null, // device online but no GPS fix (underground / antenna fault)
        remoteUnlockWorks: false, lockouts: [],
      },
      {
        vehicleId: 'V-104', name: '2021 Honda Civic EX', plate: 'BNX 4417', color: 'Sonic Gray',
        access: 'Keyless via aftermarket telematics unit',
        fallback: 'Spare key with your co-host in Coral Gables',
        telematics: { provider: 'Aftermarket GPS / immobilizer', online: true, lastPing: t(-30 * 1000) },
        location: { address: 'MIA Rental Car Center, Lot 4, Miami, FL 33142', source: 'GPS', updated: t(-30 * 1000) },
        remoteUnlockWorks: true, lockouts: [t(-6 * DAY), t(-19 * DAY)],
      },
      {
        vehicleId: 'V-105', name: '2022 BMW X3 xDrive30i', plate: 'PWE 9036', color: 'Phytonic Blue',
        access: 'Keyless via aftermarket telematics unit', fallback: null,
        telematics: { provider: 'Aftermarket GPS / immobilizer', online: true, lastPing: t(-4 * MIN) },
        location: { address: '3401 N Miami Ave, Miami, FL 33127', source: 'GPS', updated: t(-4 * MIN) },
        remoteUnlockWorks: false, lockouts: [],
      },
      {
        vehicleId: 'V-106', name: '2020 Jeep Wrangler Sport', plate: 'JKY 7720', color: 'Firecracker Red',
        access: 'Lockbox + physical key', fallback: 'Second key in the office safe',
        telematics: { provider: 'Aftermarket GPS / immobilizer', online: true, lastPing: t(-6 * MIN) },
        location: { address: '800 Ocean Dr, Miami Beach, FL 33139', source: 'GPS', updated: t(-6 * MIN) },
        remoteUnlockWorks: true, lockouts: [],
      },
    ];

    const rentals = [
      { rentalId: 'R-1001', vehicleId: 'V-101', status: 'active', channel: 'Direct booking site',
        renter: { name: 'Jordan Miles', phone: '(305) 555-0142' }, start: t(-1 * DAY), end: t(2 * DAY) },
      { rentalId: 'R-1002', vehicleId: 'V-102', status: 'active', channel: 'Turo',
        renter: { name: 'Sam Rivera', phone: '(786) 555-0117' }, start: t(-5 * HOUR), end: t(3 * DAY) },
      { rentalId: 'R-1003', vehicleId: 'V-103', status: 'active', channel: 'Direct booking site',
        renter: { name: 'Alex Chen', phone: '(305) 555-0188' }, start: t(-2 * DAY), end: t(1 * DAY) },
      { rentalId: 'R-1004', vehicleId: 'V-104', status: 'active', channel: 'Direct booking site',
        renter: { name: 'Taylor Brooks', phone: '(954) 555-0163' }, start: t(-3 * HOUR), end: t(4 * DAY) },
      { rentalId: 'R-1005', vehicleId: 'V-105', status: 'active', channel: 'Repeat guest (direct)',
        renter: { name: 'Morgan Lee', phone: '(305) 555-0124' }, start: t(-1 * DAY), end: t(1 * DAY) },
      { rentalId: 'R-1006', vehicleId: 'V-106', status: 'completed', channel: 'Turo',
        renter: { name: 'Casey Nguyen', phone: '(786) 555-0171' }, start: t(-4 * DAY), end: t(-20 * HOUR) },
    ];

    const cases = [
      {
        id: 'CS-24817', rentalId: 'R-1005', vehicleId: 'V-105', createdAt: t(-22 * MIN),
        status: 'Escalated', priority: 'P2', queue: 'Tier 2 · Telematics & dispatch', path: 'troubleshoot',
        summary: 'Renter locked out · Phone key / app won’t unlock',
        flags: [], reasons: ['Remote unlock was sent but the vehicle never confirmed. Escalated for a person to step in.'],
        nextSteps: [
          { strong: 'Locksmith being arranged.', text: 'No spare key on file for this vehicle.' },
          { strong: 'Expect a call within 15 minutes', text: 'at (305) 555-0199 with an ETA.' },
        ],
        renterMessage: '', answers: {}, callback: '(305) 555-0199',
        slaMinutes: 15, slaStart: t(-19 * MIN), acknowledged: true,
        needsLocation: false, locationConfirmed: null, followUp: null, linkedCase: null,
        remoteUnlock: 'failed', resolution: null,
        events: [
          { at: t(-22 * MIN), actor: 'Operator', text: 'Lockout reported: Renter locked out · Phone key / app won’t unlock.' },
          { at: t(-22 * MIN), actor: 'System', text: 'Triaged as P3 · Standard → Tier 1 · Guided self-serve.' },
          { at: t(-20 * MIN), actor: 'System', text: 'Remote unlock command sent to vehicle.' },
          { at: t(-19 * MIN), actor: 'System', text: 'No unlock confirmation from vehicle after 30s. Escalated to P2 · High → Tier 2 · Telematics & dispatch.' },
          { at: t(-14 * MIN), actor: 'Support', text: 'Priya picked up the case and is checking the telematics unit’s health.' },
        ],
      },
      {
        id: 'CS-24790', rentalId: 'R-1006', vehicleId: 'V-106', createdAt: t(-12 * DAY),
        status: 'Resolved', priority: 'P3', queue: 'Tier 1 · Guided self-serve', path: 'troubleshoot',
        summary: 'Renter locked out · Physical key locked inside',
        flags: [], reasons: [], nextSteps: [], renterMessage: '', answers: {}, callback: '(305) 555-0199',
        slaMinutes: 60, slaStart: t(-12 * DAY), acknowledged: true,
        needsLocation: false, locationConfirmed: null, followUp: null, linkedCase: null,
        remoteUnlock: 'success', resolution: 'Remote unlock: renter confirmed access',
        events: [
          { at: t(-12 * DAY), actor: 'Operator', text: 'Lockout reported: Renter locked out · Physical key locked inside.' },
          { at: t(-12 * DAY + 2 * MIN), actor: 'System', text: 'Vehicle confirmed doors unlocked.' },
          { at: t(-12 * DAY + 4 * MIN), actor: 'Operator', text: 'Resolved: Remote unlock: renter confirmed access.' },
        ],
      },
    ];

    return { operator, vehicles, rentals, cases, nextSeq: 24818 };
  }

  const api = { buildSeed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LockoutData = api;
})(typeof window !== 'undefined' ? window : globalThis);
