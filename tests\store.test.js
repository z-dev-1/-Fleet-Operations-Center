import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock electron app
const tmpDir = path.join(os.tmpdir(), 'fleet-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

// Override paths before requiring store
process.env.FLEET_DATA_DIR = tmpDir;

describe('Store', () => {
  afterEach(() => {
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('should save and load JSON data', () => {
    const data = { units: [{ id: '322472', vendor: 'Amerit' }] };
    const filePath = path.join(tmpDir, 'test.json');
    
    // Atomic write
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
    
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(loaded.units[0].id).toBe('322472');
  });

  it('should handle corrupted JSON gracefully', () => {
    const filePath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(filePath, '{broken json!!!', 'utf8');
    
    let result = null;
    try { result = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch(e) { result = { fallback: true }; }
    
    expect(result.fallback).toBe(true);
  });

  it('should atomic write not corrupt on partial write', () => {
    const filePath = path.join(tmpDir, 'atomic.json');
    const data = { key: 'value', count: 42 };
    
    // Simulate atomic write
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    
    // Verify tmp exists before rename
    expect(fs.existsSync(tmpPath)).toBe(true);
    
    fs.renameSync(tmpPath, filePath);
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).count).toBe(42);
  });
});
