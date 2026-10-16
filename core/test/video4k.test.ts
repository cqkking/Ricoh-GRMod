// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import {
  CASE_TARGET_4K_EXT,
  DEFAULT_4K_BITRATE,
  JUMP_TABLE_CASE3,
  OFFICIAL_CASE3_TARGET,
  SLOT7_RECORD_VA,
  readVideo4kStatus,
} from '../src/fw/aspect/video4k';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');

describe('4K UHD Video Recording Constants & Offsets', () => {
  it('has expected jump table and handler addresses in RTOS space', () => {
    expect(JUMP_TABLE_CASE3).toBe(0x536497f4);
    expect(OFFICIAL_CASE3_TARGET).toBe(0x536498b0);
    expect(CASE_TARGET_4K_EXT).toBe(0x536498c4);
    expect(SLOT7_RECORD_VA).toBe(0x543602bc);
    expect(DEFAULT_4K_BITRATE).toBe(100_000_000);
  });
});

describe.skipIf(!have)('4K UHD Video Firmware Build & Verification', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;

  it('opens official firmware and verifies official video status', async () => {
    eng = await Engine.open(raw);
    const decoded = eng.decoded;
    const status = readVideo4kStatus(decoded);
    expect(status.enabled).toBe(false);
    expect(status.targetAddress).toBe(OFFICIAL_CASE3_TARGET);
    expect(status.bitrate).toBe(DEFAULT_4K_BITRATE);
  });

  it('builds 4K video standalone and passes all self-checks', async () => {
    const b = await eng.buildFirmware([], [], [], { video4k: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);

    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.video4k).toBe(true);
    expect(s.adjSoftFocus).toBe(false);
    expect(s.dateStamp).toBe(false);
    expect(s.monoUnlock).toBe(false);

    // Check hijacked word in decoded RTOS
    const decoded = new fw.Firmware(b.file).decoded;
    const status = readVideo4kStatus(decoded);
    expect(status.enabled).toBe(true);
    expect(status.targetAddress).toBe(CASE_TARGET_4K_EXT);
    expect(status.bitrate).toBe(DEFAULT_4K_BITRATE);

    // Check payload sum is zero
    expect(fw.sum32(decoded)).toBe(0);

    // Verify ICONBIN is unchanged (zero UI overhead)
    const list = fw.sectionsOf(decoded);
    const rtos = list.find((sec) => sec.name === 'RTOS')!;
    const icon = list.find((sec) => sec.name === 'ICONBIN')!;
    expect(rtos.size).toBeGreaterThan(fw.RTOS_LENGTH);
    expect(icon.size).toBe(fw.ICONBIN_LENGTH);
  });

  it('builds 4K video with custom bitrate (60 Mbps)', async () => {
    const customBitrate = 60_000_000;
    const b = await eng.buildFirmware([], [], [], { video4k: { bitrate: customBitrate } });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);

    const decoded = new fw.Firmware(b.file).decoded;
    const status = readVideo4kStatus(decoded);
    expect(status.enabled).toBe(true);
    expect(status.bitrate).toBe(customBitrate);

    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.video4k).toBe(true);
  });

  it('builds 4K video combined with custom ratios, soft focus, date stamp, and mono unlock', async () => {
    const b = await eng.buildFirmware(
      [],
      [{ name: '65:24', ratio: '65:24' }],
      [],
      { adjSoftFocus: true, dateStamp: true, monoUnlock: true, video4k: true }
    );
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);

    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.video4k).toBe(true);
    expect(s.adjSoftFocus).toBe(true);
    expect(s.dateStamp).toBe(true);
    expect(s.monoUnlock).toBe(true);
    expect(s.ratios.length).toBe(1);
    expect(s.ratios[0].name).toBe('65:24');

    const decoded = new fw.Firmware(b.file).decoded;
    const status = readVideo4kStatus(decoded);
    expect(status.enabled).toBe(true);
  });
});
