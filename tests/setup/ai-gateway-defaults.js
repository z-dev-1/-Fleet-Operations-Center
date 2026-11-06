// Test isolation for the Phase 3 AI gateway flags: force every flag OFF via env
// (env wins over settings.json), so existing suites always run the legacy path
// even if a developer's settings or shell enable the gateway. Gateway tests use
// relay.__test__.setGatewayFlags or pass an explicit env to the resolver.
process.env.FLEET_AI_GW_PRIORITIES = '0';
process.env.FLEET_AI_GW_ABORT = '0';
process.env.FLEET_AI_GW_DEDUPE = '0';
process.env.FLEET_AI_GW_ROUTER = '0';
delete process.env.FLEET_AI_GW_RESERVE;
// Phase 4b: same isolation for the Slack speed-up env overrides (absent = settings
// decide, and test data dirs have no speed-up settings, so every flag is off).
for (const k of ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED',
  'FLEET_SLACK_PM_SHARED_HISTORY', 'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING']) delete process.env[k];
// Phase 9: auth coordination flags forced OFF so legacy suites always run the parity path,
// even if the developer's shell sets FLEET_AUTH_* for the rollout (env wins over settings.json).
for (const k of ['FLEET_AUTH_SINGLE_FLIGHT', 'FLEET_AUTH_SINGLE_OWNER_AEA', 'FLEET_AUTH_SINGLE_OWNER_RECONNECT']) process.env[k] = '0';
// Just Me context reader forced OFF so legacy suites run the flag-off parity path.
// Flag-on tests set '1' inside the test and restore '0' in afterEach.
process.env.FLEET_JUSTME_READ_CONTEXT = '0';
// On-demand DBR lookup forced OFF so legacy suites run the flag-off parity path.
process.env.FLEET_AI_DBR_LOOKUP = '0';
// Auth propagation forced OFF so legacy suites run the flag-off parity path.
// Flag-on tests use auth-report._setEnabledForTest / supervisor _setDeps({ propagation }).
process.env.FLEET_AUTH_PROPAGATION = '0';
// Email Triage Intelligence (master + per-phase sub-flags + durable job) forced OFF so legacy
// suites run the flag-off parity path. Flag-ON tests use src/email-intel/flags._setForTests.
for (const k of ['FLEET_EMAIL_INTEL', 'FLEET_EMAIL_INTEL_CAPTURE', 'FLEET_EMAIL_INTEL_MULTI', 'FLEET_EMAIL_INTEL_TIMELINE',
  'FLEET_EMAIL_INTEL_ACTIONS', 'FLEET_EMAIL_INTEL_REPLIES', 'FLEET_EMAIL_INTEL_ATTACH', 'FLEET_JOBS_EMAIL_TRIAGE']) process.env[k] = '0';
