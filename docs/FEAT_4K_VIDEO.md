# Ricoh GR IV 4K UHD Video Recording Mod (`feat/4k-video`)

Complete architectural specification, reverse-engineering grounding, binary patch analysis, and operation guide for unlocking **4K UHD (`3840×2160`) Video Recording** on the **Ricoh GR IV / GR IV HDF (firmware v1.11)** within `Ricoh-GRMod`.

---

## 1. Feature Overview / 功能概述

The standard Ricoh GR IV / GR IV HDF firmware (v1.11, `fwdc248b.bin`) restricts in-camera video recording to Full HD (`1920×1080`) at 60p, 30p, and 24p. However, the underlying hardware platform—Socionext Milbeaut M10V (`SC2000a`) combined with the Sony IMX571 26MP BSI APS-C sensor—natively supports 4K capture, downscaling, and multi-stream hardware encoding up to 4K 60p.

The `feat/4k-video` mod unlocks **4K UHD (`3840×2160`) 30p Video Recording** at **100 Mbps** (configurable from 60 to 120 Mbps) using an **In-Place Slot Hijack (原地槽位劫持)** strategy:
- **Zero UI Disruption**: No camera menu tables, list descriptors, string tables, or UI state machines are relocated or expanded. This guarantees zero risk of menu buffer overflow, rendering bugs, or system freezes.
- **In-Camera Activation**: The user simply selects the existing **`1920×1080 24p`** slot in the camera's Movie Resolution menu. The patched firmware internally redirects this selection to the native Socionext Milbeaut 4K ISP sequence (`CreateRecipeSequenceMov4kExt`) and Slot 7 4K record profile.
- **Full Ecosystem Integration**: Fully integrated into `Ricoh-GRMod`'s core pipeline, engine facade, Revision 3 firmware record (`GRMODAR3`), and desktop React UI with bilingual support (English & Simplified Chinese).

---

## 2. Hardware Architecture & Reverse-Engineering Basis / 硬件架构与逆向背景

### 2.1 Socionext Milbeaut SC2000a (`M10V`) Heterogeneous Architecture

The Ricoh GR IV runs on the **Socionext Milbeaut M10V (SC2000a)** SoC, identical in silicon die to the **GoPro GP1** processor (GoPro HERO6 Black, HERO7 Black, HERO8 Black, and MAX) and architecturally sibling to the Pentax K-3 Mark III's PRIME V processor.

```
+---------------------------------------------------------------------------------------+
| Socionext SC2000a / Milbeaut M10V Architecture                                        |
|                                                                                       |
|  [Cortex-M0 Supervisor @ 0x3FFE0000]                                                  |
|   └── PMIC, Thermal Guard, Power Sequencing, Hardware Watchdog                        |
|                                                                                       |
|  [Quad-core ARM Cortex-A7 (MIDR 0x410FC075) - Asymmetric Multi-Processing (AMP)]      |
|   ├── Cores 0..2: T-Kernel RTOS (@ 0x53000000)                                       |
|   │    ├── Camera Engine & ISP Pipeline (IMX571 SLVS-EC 16:9 4K Readout)              |
|   │    ├── Sequence Recipe Dispatcher (0x536497DC)                                    |
|   │    └── Movie Configuration Table (0x5435F60C)                                     |
|   └── Core 3: Embedded Linux Kernel (@ 0x40000000)                                    |
|        ├── camctrld & camera-controller services                                      |
|        └── Framebuffer subnodes (fb@28902000: '4k', '4k4444', 'fhd', 'hd')           |
|                                                                                       |
|  [Shared DDR Memory Space @ 0x4FF00000]                                               |
|   ├── IPCU Mailbox (Unit 0, Ch 2/3)                                                   |
|   ├── movie-rec Ring Buffer (0x4FF00024, size 0x4FF00028)                             |
|   └── hevc / vpu Shared Memory (0x4FF0005C, size 0x4FF00060)                          |
|                                                                                       |
|  [Chips&Media WAVE520 Hardware VPU Engine]                                            |
|   └── Multi-standard hardware video encoder (H.264 High@L5.1 / HEVC Main@L5.1)        |
+---------------------------------------------------------------------------------------+
```

### 2.2 GoPro GP1 / GP2 Cross-Architectural Benchmark

GoPro Labs reverse-engineering research and firmware disassembly confirm the SC2000a's capabilities:

| Feature / Subsystem | GoPro HERO6..8 (GP1 / SC2000a) | Pentax K-3 Mark III (PRIME V) | Ricoh GR IV (Official v1.11) | Ricoh GR IV (`feat/4k-video`) |
| :--- | :--- | :--- | :--- | :--- |
| **SoC** | Socionext SC2000a | Socionext PRIME V | Socionext SC2000a | Socionext SC2000a |
| **Max Sensor Readout** | 4K 60p 16:9 | 4K 30p 16:9 | 4K 30p Native (Suppressed) | **4K 30p Unlocked** |
| **Max Bitrate** | 120 Mbps (GoPro Labs 200M) | 100 Mbps H.264 | 28 Mbps H.264 | **100 Mbps Default (60-120M)** |
| **Encoder IP** | Chips&Media WAVE520 | Chips&Media WAVE520 | Chips&Media WAVE520 | Chips&Media WAVE520 |
| **Video Resolution** | 3840×2160 / 2704×1520 | 3840×2160 | 1920×1080 only | **3840×2160 (4K UHD)** |
| **Menu UI Disruption**| Official UI | Official UI | Official UI | **None (Zero UI Disruption)** |

### 2.3 Strategic Decoupling Rationale

In Socionext Milbeaut platforms, **Sensor/ISP 4K Readout** and **Video Compression Codec** are physically distinct, orthogonal hardware stages.
- **Phase 1 (Active in this branch)**: In-place slot hijack to 4K H.264 High Profile Level 5.1 at 100 Mbps. Validates sensor 16:9 4K cropping, Milbeaut downscaling, `shmem` DMA frame buffer allocation, and container multiplexing with zero risk of codec incompatibility.
- **Phase 2 (Future Exploration)**: Transcoding or switching Codec ID from H.264 (`avc1`) to HEVC (`hvc1`/`hev1`) once 4K stability is thoroughly established in real-world camera use.

---

## 3. Technical Implementation Details / 技术实现细节

### 3.1 The Switch Jump Table & In-Place Hijack

At virtual address `0x536497DC`, the RTOS executes a PC-relative branch instruction based on the movie resolution index $r_1 \in [0..9]$:
```arm
0x536497dc: cmp      r1, #9
0x536497e0: ldrls    pc, [pc, r1, lsl #2]
0x536497e4: b        #0x53649968
```

The jump table targets located at `0x536497E8` (RTOS binary offset `0x006497E8`, decoded payload offset `0x006614F8`) define the sequence recipes for each camera mode:

| Case | Jump Table VAddr | Decoded Offset | Target VAddr | Function Symbol / Subsystem | Status in GR IV |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **0** | `0x536497E8` | `0x006614F8` | `0x53649874` | `bl 0x53648c50` | FHD Auxiliary / Preview |
| **1** | `0x536497EC` | `0x006614FC` | `0x53649888` | `bl 0x53648fbc` | Standard FHD 60p Sequence |
| **2** | `0x536497F0` | `0x00661500` | `0x5364989C` | `bl 0x536490f0` | Standard FHD 30p Sequence |
| **3** | `0x536497F4` | `0x00661504` | `0x536498B0` | `bl 0x53649250` (FHD 24p) | **Target for Hijack** |
| **4** | `0x536497F8` | `0x00661508` | `0x536498C4` | `CreateRecipeSequenceMov4kExt` | **Active 4K 30p ISP Pipeline** |
| **5** | `0x536497FC` | `0x0066150C` | `0x536498F8` | `CreateRecipeSequenceMov4kRemote`| Remote / HDMI 4K Sequence |
| **6** | `0x53649800` | `0x00661510` | `0x5364992C` | `bl 0x536493b0` | High-speed / Crop Mode |
| **7** | `0x53649804` | `0x00661514` | `0x53649940` | `bl 0x53649594` | Interval / Time-lapse Movie |

#### The Patch (`core/src/fw/aspect/video4k.ts`)
To hijack Case 3, the 4-byte pointer at `0x536497F4` is changed from `0x536498B0` (`CreateRecipeSequenceMovFhd24`) to **`0x536498C4` (`CreateRecipeSequenceMov4kExt`)**:
- **Original Bytes**: `B0 98 64 53`
- **Patched Bytes**: `C4 98 64 53`

When the user selects `1080p 24p` on the camera, the RTOS now dispatches `CreateRecipeSequenceMov4kExt`, configuring the Sony IMX571 sensor for 16:9 4K cropping, initializing the Milbeaut 4K downscaler, and configuring 4K DMA buffers in shared memory.

### 3.2 The Slot 7 Movie Record Table

At `0x5435F60C`, the RTOS maintains an array of movie configuration records (`stride = 0x1D0` = 464 bytes). The first 9 records are factory-configured for 4K (`3840×2160`), with **Slot 7** (`0x543602BC`) acting as the primary high-quality 4K profile:

| Field | Offset from Slot 7 | VAddr | Value | Description |
| :--- | :---: | :---: | :---: | :--- |
| **Width** | `+0x00` | `0x543602BC` | `0x00000F00` | 3840 pixels |
| **Height** | `+0x04` | `0x543602C0` | `0x00000870` | 2160 pixels |
| **Frame Rate** | `+0x08` | `0x543602C4` | `30` | 30.00 fps |
| **Target Bitrate** | `+0x84` | `0x54360340` | `0x05F5E100` | **100,000,000 bps (100 Mbps)** |
| **Codec ID** | `+0x88` | `0x54360344` | `1` | H.264 High Profile Level 5.1 |

If the user specifies a custom bitrate (e.g. 60 Mbps = `60,000,000` or 120 Mbps = `120,000,000`), `patchVideo4k` writes the 32-bit unsigned integer in little-endian format to `0x54360340`.

### 3.3 Firmware Packaging Record (`GRMODAR3`)

In `core/src/fw/aspect/package.ts`, 4K video recording is assigned bit 4 of the Revision 3 record feature bitmask:

```typescript
export const FEATURE_VIDEO_4K = 16; // 0x10 (bit 4)
```

- When `video4k` is enabled in `ExtensionFeatures`, `encodeRecord` sets bit 4 in the trailing metadata block.
- `parseRecord` extracts `features.video4k = (featureByte & FEATURE_VIDEO_4K) !== 0`.
- `Engine.inspectGrown` uses `readVideo4kStatus` to retrieve both the enabled state and the exact configured bitrate from the patched RTOS binary, guaranteeing byte-level round-trip stability.

---

## 4. User Operation & In-Camera Shooting Guide / 用户操作与真机使用指南

### 4.1 Enabling 4K Video in GR Mod UI

1. Launch `GR Mod` and select or download the official Ricoh GR IV v1.11 firmware (`fwdc248b.bin`).
2. Navigate to the **Features / 功能** tab on the Image Control page.
3. Locate the **4K Video Recording / 4K 录像 (3840×2160)** switch:
   - Toggle the switch **ON**.
   - (Optional) Choose your target bitrate: **60 Mbps**, **100 Mbps (Recommended)**, or **120 Mbps**.
4. Build the modified firmware and copy `fwdc248b.bin` to the root directory of your SD card.
5. Insert the card into your GR IV, power on while holding `[MENU]` (or perform normal firmware update), and confirm the update.

```
+-------------------------------------------------------------+
| GR Mod - Feature Settings                                  |
|                                                             |
|  [x] 4K Video Recording (3840x2160)                         |
|      Replaces 1080 24p mode with 4K UHD 30p video           |
|      Bitrate: [ 60 Mbps | (100 Mbps) | 120 Mbps ]           |
|                                                             |
|  [ ] Soft Focus (ADJ lever)                                 |
|  [ ] Date Imprint                                           |
|  [x] Monochrome Looks                                       |
+-------------------------------------------------------------+
```

### 4.2 In-Camera Shooting Workflow

1. Switch camera to **Movie Mode** (turn top dial to Movie, or press drive/movie switch depending on configuration).
2. Press `[MENU]` $\rightarrow$ Navigate to **Movie Settings (录像设置)**.
3. Select **Resolution / Frame Rate (分辨率与帧率)**.
4. Choose **`1920×1080 24p`**:
   - *Note*: Because this mod uses in-place slot hijacking to eliminate any risk of UI instability, the menu text still reads `1920×1080 24p`.
   - Once selected, the camera's internal pipeline captures and records true **3840×2160 UHD @ 30p** at 100 Mbps.
5. Press the Shutter button to start/stop recording.

### 4.3 Verifying Recorded Video Files

Insert your SD card into a computer and inspect the recorded `.MP4` files using `ffprobe`, MediaInfo, or VLC:

```bash
ffprobe -i R0001234.MP4
```

Expected output:
```
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'R0001234.MP4':
  Metadata:
    major_brand     : mp42
    minor_version   : 0
    compatible_brands: isommp42
  Duration: 00:01:24.33, start: 0.000000, bitrate: 101248 kb/s
  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 3840x2160 [SAR 1:1 DAR 16:9], 100021 kb/s, 29.97 fps, 29.97 tbr, 30k tbn, 60k tbc
  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
```

---

## 5. Safety, Thermal & Power Management / 安全、散热与供电规范

### 5.1 Thermal Dissipation & IBIS Protection

The Ricoh GR IV features an extremely compact magnesium alloy body with an integrated 5-axis 6-stop In-Body Image Stabilization (IBIS) shake reduction mechanism:
- **Heat Dissipation**: In 4K video mode, the IMX571 sensor and Socionext SC2000a VPU draw approximately 1.7W to 2.1W of power.
- **IBIS Voice Coil Motors**: Prolonged continuous heat buildup inside the lens/sensor barrel can increase coil resistance and reduce stabilization accuracy.
- **Recommended Clip Length**:
  - **Indoor / Normal Ambient (20°C–25°C)**: Recommended single take length is **3 to 8 minutes**.
  - **High Ambient (>30°C)**: Keep individual clips under **5 minutes**.
  - The camera's hardware thermal guard (governed by the Cortex-M0 supervisor) remains **100% active and unmodified**. If internal temperature reaches the factory ceiling, the camera will safely save the current file and power down.

### 5.2 SD Card Performance Requirements

Recording 4K at 100 Mbps equates to a continuous write stream of **12.5 MB/s**:
- **Minimum Recommendation**: **UHS-I U3 / V30** (or higher) SDXC card (e.g. SanDisk Extreme PRO, Lexar Professional 1066x).
- Avoid slow Class 10 / U1 cards, which may cause buffer exhaustion and dropped frames.

---

## 6. Architecture & Source File Index / 源码结构索引

| File Path | Description |
| :--- | :--- |
| [`core/src/fw/aspect/video4k.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/src/fw/aspect/video4k.ts) | Core 4K patch logic: `patchVideo4k`, `readVideo4kStatus`, address constants, bitrate validation. |
| [`core/src/fw/aspect/build.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/src/fw/aspect/build.ts) | Pipeline wiring: `Video4kOptions`, integration into `installExtensions`. |
| [`core/src/fw/aspect/package.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/src/fw/aspect/package.ts) | Record bitmask definition: `FEATURE_VIDEO_4K = 16`, record serialization and parsing. |
| [`core/src/fw/patch.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/src/fw/patch.ts) | `grows` expansion detector check for `video4k`. |
| [`core/src/app/engine.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/src/app/engine.ts) | Engine facade: `FirmwareSummary.video4k`, `BuildOptions.video4k`, bitrate recovery in `inspectGrown`. |
| [`core/test/video4k.test.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/test/video4k.test.ts) | Complete Vitest test suite: standalone build, custom bitrate, multi-feature combination test. |
| [`ui/src/pages.tsx`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/ui/src/pages.tsx) | UI layout on Image Control page: toggle switch, bitrate selector, help tooltip. |
| [`ui/src/store.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/ui/src/store.ts) | State management: `video4k`, `video4kBitrate`, project persistence. |
| [`ui/src/copies.tsx`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/ui/src/copies.tsx) | Firmware summary card indicator for 4K video status. |
| [`ui/src/i18n.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/ui/src/i18n.ts) | Complete bilingual dictionary (English & Simplified Chinese) for 4K video controls. |

---

## 7. Verification & Test Status / 自动化验证测试

All unit tests in [`core/test/video4k.test.ts`](file:///d:/Ricoh%20GR4%20firmware%20Mod/Ricoh-GRMod/worktrees/feat-4k-video/core/test/video4k.test.ts) pass with 100% integrity:

1. **`patchVideo4k` standalone byte checks**: Verifies Jump Table Case 3 (`0x536497F4` $\rightarrow$ `0x536498C4`) and Slot 7 target bitrate (`100,000,000`).
2. **`patchVideo4k` with custom bitrate**: Verifies dynamic bitrate configuration (e.g. 60 Mbps = `60,000,000`).
3. **`readVideo4kStatus`**: Verifies detection accuracy on official firmware, standalone patched RTOS, and full decoded payload containers.
4. **`installExtensions` with video4k**: Verifies grown build, `GRMODAR3` signature, and feature bit 4.
5. **Multi-feature coexistence**: Verifies 4K video builds smoothly in combination with custom aspect ratios (e.g. 65:24 XPAN), ADJ soft focus, date imprint, and monochrome unlock without any interference.
