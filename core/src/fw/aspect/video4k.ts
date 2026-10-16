// SPDX-License-Identifier: GPL-2.0-only
/**
 * 4K UHD Video Recording mod for Ricoh GR IV (firmware 1.11).
 *
 * Implements in-place slot hijack on the camera's 1080p 24p movie slot:
 *  - Hijacks RTOS Movie jump table entry for Case 3 (1080p 24p) at 0x536497F4.
 *  - Redirects jump target from CreateRecipeSequenceMovFhd24 (0x536498B0) to
 *    CreateRecipeSequenceMov4kExt (0x536498C4).
 *  - Activates IMX571 full 16:9 4K (3840x2160) sensor readout, Milbeaut ISP 4K pipeline,
 *    and H.264 High@L5.1 hardware encoder at 100 Mbps (Slot 7 profile @ 0x543602BC).
 *  - Zero camera UI corruption: the menu layout and strings remain 100% official.
 *    Selecting the 3rd movie option in the camera menu records native 4K UHD video.
 */
import { BASE, OFFICIAL_RTOS_LENGTH, Patch, expectWord } from './build';

/** Jump table entry in 05_RTOS.bin for Case 3 (1080p 24p) */
export const JUMP_TABLE_CASE3 = 0x536497f4;
/** Official handler: CreateRecipeSequenceMovFhd24 */
export const OFFICIAL_CASE3_TARGET = 0x536498b0;
/** 4K handler: CreateRecipeSequenceMov4kExt (native 4K readout & downscale) */
export const CASE_TARGET_4K_EXT = 0x536498c4;

/** Slot 7 in RTOS Movie Record Table (4K 30p 100M profile) */
export const SLOT7_RECORD_VA = 0x543602bc;
export const DEFAULT_4K_BITRATE = 100_000_000; // 100 Mbps

export interface Video4kOptions {
  /** Target bitrate in bps (default: 100,000,000 = 100 Mbps). Must be 20M..150M. */
  bitrate?: number;
}

export interface Video4kSummary {
  enabled: boolean;
  targetAddress: number;
  bitrate: number;
}

/**
 * Install the 4K video recording modification into a Patch.
 */
export function installVideo4k(patch: Patch, options?: Video4kOptions): void {
  expectWord(patch, JUMP_TABLE_CASE3, OFFICIAL_CASE3_TARGET);
  patch.setWord(JUMP_TABLE_CASE3, CASE_TARGET_4K_EXT, '4K video: redirect 1080p24 to CreateRecipeSequenceMov4kExt');

  if (options?.bitrate) {
    const br = options.bitrate;
    if (br < 20_000_000 || br > 150_000_000) {
      throw new Error(`Bitrate ${br} bps out of supported range (20Mbps - 150Mbps)`);
    }
    patch.setWord(SLOT7_RECORD_VA + 0x0c, br, '4K video: target bitrate');
    patch.setWord(SLOT7_RECORD_VA + 0x28, br, '4K video: peak bitrate');
  }
}

/**
 * Check whether a decoded firmware image has 4K video enabled.
 */
export function readVideo4kStatus(decoded: Uint8Array): Video4kSummary {
  const isFullPayload = decoded.length > OFFICIAL_RTOS_LENGTH;
  const rtosOffset = isFullPayload ? 0x17d10 : 0;
  const offset = rtosOffset + (JUMP_TABLE_CASE3 - BASE);
  if (offset < 0 || offset + 4 > decoded.byteLength) {
    return { enabled: false, targetAddress: 0, bitrate: 0 };
  }
  const dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const target = dv.getUint32(offset, true);
  const enabled = target === CASE_TARGET_4K_EXT;

  let bitrate = DEFAULT_4K_BITRATE;
  const slot7Offset = rtosOffset + (SLOT7_RECORD_VA - BASE);
  if (slot7Offset >= 0 && slot7Offset + 0x30 <= decoded.byteLength) {
    bitrate = dv.getUint32(slot7Offset + 0x0c, true);
  }

  return {
    enabled,
    targetAddress: target,
    bitrate,
  };
}
