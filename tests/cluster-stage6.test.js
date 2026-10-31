import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
const gate = require('../src/cluster/mode-gate');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage6-'));
  paths.setDataDir(dir);
  return dir;
}

describe('cluster Stage 6 — SMTP email adapter (fail-closed by default)', () => {
  let smtp;
  beforeEach(() => {
    freshDataDir();
    gate._reset();
    delete process.env.FLEET_SMTP;
    smtp = require('../src/scrapers/email_sender_smtp');
  });

  it('exposes the sendFleetEmail-compatible contract', () => {
    expect(typeof smtp.sendFleetEmailSmtp).toBe('function');
    expect(typeof smtp.verifyTransport).toBe('function');
  });

  it('FAILS CLOSED by default: no smtpEnabled flag => never sends', async () => {
    const r = await smtp.sendFleetEmailSmtp({ to: 'x@amazon.com', subject: 's', htmlBody: '<p>h</p>' }, () => {});
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe('smtp-disabled');
  });

  it('_smtpAllowed: disabled unless explicitly enabled', () => {
    expect(smtp._smtpAllowed({}).ok).toBe(false);
    expect(smtp._smtpAllowed({ smtpEnabled: true }).ok).toBe(true);
    process.env.FLEET_SMTP = '1';
    expect(smtp._smtpAllowed({}).ok).toBe(true);
    delete process.env.FLEET_SMTP;
  });

  it('_smtpAllowed respects the cluster side-effect gate when enabled', () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    // Enable cluster, STANDBY mode (which blocks email-send) + smtp capability.
    cluster.init({ enabled: true, mode: 'STANDBY', force: true, capabilities: { smtp: true, browser: false } });
    // smtpEnabled true, but STANDBY mode blocks the side-effect → not allowed.
    const d = smtp._smtpAllowed({ smtpEnabled: true });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/^gate:/);
    cluster._reset();
  });
});

describe('cluster Stage 6 — mode gate email-send capability logic', () => {
  beforeEach(() => { gate._reset(); });

  it('ACTIVE + browser: email-send permitted (OWA path)', () => {
    gate.setEnabled(true); gate.setMode('ACTIVE'); gate.setCapabilities({ browser: true, smtp: false });
    expect(gate.canSideEffect('email-send').ok).toBe(true);
  });

  it('ACTIVE + headless + SMTP capability: email-send permitted (SMTP path)', () => {
    gate.setEnabled(true); gate.setMode('ACTIVE'); gate.setCapabilities({ browser: false, smtp: true });
    expect(gate.canSideEffect('email-send').ok).toBe(true);
    // But a browser-only task still fails closed on the headless host.
    expect(gate.canSideEffect('sp-push').ok).toBe(false);
    expect(gate.canSideEffect('fleet-mutate').ok).toBe(false);
  });

  it('ACTIVE + headless + NO smtp: email-send fails CLOSED', () => {
    gate.setEnabled(true); gate.setMode('ACTIVE'); gate.setCapabilities({ browser: false, smtp: false });
    expect(gate.canSideEffect('email-send').ok).toBe(false);
  });

  it('STANDBY mode blocks email-send regardless of capability', () => {
    gate.setEnabled(true); gate.setMode('STANDBY'); gate.setCapabilities({ browser: true, smtp: true });
    expect(gate.canSideEffect('email-send').ok).toBe(false);
  });
});
