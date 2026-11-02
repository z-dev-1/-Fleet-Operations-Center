// Test isolation for the Phase 3 AI gateway flags: force every flag OFF via env
// (env wins over settings.json), so existing suites always run the legacy path
// even if a developer's settings or shell enable the gateway. Gateway tests use
// relay.__test__.setGatewayFlags or pass an explicit env to the resolver.
process.env.FLEET_AI_GW_PRIORITIES = '0';
process.env.FLEET_AI_GW_ABORT = '0';
process.env.FLEET_AI_GW_DEDUPE = '0';
process.env.FLEET_AI_GW_ROUTER = '0';
delete process.env.FLEET_AI_GW_RESERVE;
