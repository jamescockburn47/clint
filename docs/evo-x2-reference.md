# EVO X2 Reference — Verified Technical Facts

> These have been verified through testing. Do not waste time re-investigating.

## Hardware

- **AMD Ryzen AI MAX+ 395** + **Radeon 8060S** (gfx1151, RDNA 3.5, 40 CUs)
- **128 GB unified LPDDR5X in UMA configuration.** `free -h` reports only ~32 GB (CPU-visible). GPU has 96 GB VRAM heap (`/sys/class/drm/card1/device/mem_info_vram_total` = 103079215104 bytes). **Do not use `free` or `/proc/meminfo` to judge model capacity** — check VRAM via sysfs or `vulkaninfo`. Total usable: ~96 GB minus ~28 GB loaded = ~68 GB free.
- **Direct Ethernet link** Pi (10.0.0.1) ↔ EVO (10.0.0.2): 0.4ms latency vs 124ms WiFi.

## Networking Performance (fixed 2026-04-03)

- **WiFi: MediaTek MT7925** (WiFi 7, EHT). Connected to EE Smart Hub on **6 GHz band**, channel 69, 160 MHz width.
- **Link rate: ~1300 Mbps RX / ~1700 Mbps TX** on 6 GHz.
- **Actual download: 55 MB/s single-stream, ~300 Mbps aggregate** (gigabit FTTP line).
- **Model download time: ~18 GB model in ~5-6 minutes** from HuggingFace.
- **Fixes applied (all persisted):**
  - TCP buffer max: 64 MB (`/etc/sysctl.d/99-network-tuning.conf`)
  - WiFi power save OFF (`/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf`)
  - MT7925 ASPM disabled (`/etc/modprobe.d/mt7925e.conf`)
  - Regulatory DB updated for UK 6 GHz (5925-6425 MHz @ 320 MHz width)
  - NetworkManager profile: SAE auth, band `a`, PMF required (prefers 6 GHz)
- **If 6 GHz drops to 5 GHz after reboot:** `sudo modprobe -r mt7925e && sudo modprobe mt7925e disable_aspm=Y` then reconnect.
- **Direct SSH from Windows:** `ssh -i ~/.ssh/id_ed25519 james@192.168.1.230` (LAN) or `james@100.90.66.54` (Tailscale). Both work.

## GPU & Compute

- **ROCm/HIP segfaults on gfx1151** with ROCm 7.1.1. Crash in `libhsa-runtime64.so`. `HSA_OVERRIDE_GFX_VERSION=11.0.0` does NOT fix it. ROCm 7.2 reportedly works with `-mllvm --amdgpu-unroll-threshold-local=600` and `-DGGML_HIP_ROCWMMA_FATTN=ON`.
- **Vulkan backend works.** Detects UMA (`uma: 1`). GPU fully offloaded (41/41 layers). Performance ceiling ~60-70 tok/s for 3B-active MoE models.
- **GDN Vulkan shader is UNSTABLE under sustained load.** PR #20334 (merged 2026-03-12) adds GATED_DELTA_NET shader. Works for short bursts but crashed EVO after ~33 min sustained 128K context (2026-03-25). GPU hang, total freeze. **Do NOT use GDN models for overnight/sustained sessions.** Use non-GDN models (Qwen3-Coder-30B-A3B) instead. Revisit monthly.
- **GPU clock pinning** via `gpu-clock-pin.service`: sets `profile_peak` = 2900MHz at boot. RDNA 3.5 does NOT support `manual` + `pp_dpm_sclk` writes — use `profile_peak`. GRUB `amdgpu.runpm=0` alone is NOT sufficient.
- **lemonade-sdk** provides prebuilt llama.cpp ROCm binaries for gfx1151: https://github.com/lemonade-sdk/llamacpp-rocm/releases

## Models & Services

| Service | Port | Model | Notes |
|---------|------|-------|-------|
| `llama-server-main` | 8080 | Qwen3.6-27B Q6_K + Qwen3.5-0.8B draft | Default local chat model, speculative decoding, Vulkan |
| `llama-server-planner` | 8085 | Qwen3-4B | Primary classifier/planner signal |
| `llama-server-classifier` | 8081 | Qwen3-0.6B Q8_0 | Legacy/last-resort classifier path; not normally active |
| `llama-server-tts` | 8082 | Orpheus-3B Q8_0 | SNAC audio tokens. Running but Piper TTS used instead |
| `llama-server-embed` | 8083 | nomic-embed-text-v1.5 Q8_0 | Always on, 140MB |
| `llama-server-docling` | 8084 | Granite-Docling-258M F16 | Structured document parsing, 499MB |
| `clawdbot-memory` | 5100 | — | FastAPI memory service |
| SearXNG (Docker) | 8888 | — | Self-hosted web search, no API key |

- **Qwen local is the default chat backend.** MiniMax is cloud fallback; Claude is explicit/premium/last-resort.
- **Core local servers run 24/7** (main chat, planner/classifier, embed, docling, memory). The old 8081 classifier may be inactive when 8085 is healthy.
- **Dream/overnight tasks use the local EVO model path** unless a stage explicitly invokes cloud quality gating.
- **Ollama** is installed but NOT used. Can be stopped with `sudo systemctl stop ollama`.

## Model Notes

- **Qwen3.5-35B-A3B uses GDN** — causes CPU fallback on Vulkan (~59 tok/s ceiling).
- **Qwen3-Coder-Next 80B-A3B** (70.6% SWE-Bench, GDN) available at `/home/james/models/` — **DO NOT USE for sustained sessions** (GDN instability).
- **Thinking mode in Qwen3.5**: Use `--reasoning off` flag. `--chat-template-kwargs '{"enable_thinking":false}'` alone has a known bug. `--reasoning-budget 0` leaves residual `</think>` tags.
- **Optimised llama-server flags**: `--flash-attn on --mlock --no-mmap --cont-batching --batch-size 1024 --ubatch-size 512 --cache-type-k q8_0 --cache-type-v q8_0`. Requires `LimitMEMLOCK=infinity` in systemd unit.

## Networking & Access

- **SSH to EVO from Pi**: `ssh james@10.0.0.2` (host key in Pi's `known_hosts`).
- **`huggingface-cli` not in nohup PATH.** Use `wget` with direct HF URLs, or full path `~/.local/bin/huggingface-cli`. HF GGUF repos use subdirectory structure.
- **Memory service uses llama.cpp** for embeddings (port 8083) and fact extraction (port 8080, daytime only). Client: `llm_client.py`.

## Pi Infrastructure

- **Pi WiFi watchdog** (`wifi-watchdog.timer`): Runs every 5 min. Pings router 192.168.1.254 — bounces WiFi via `nmcli` on failure, reloads `brcmfmac` if needed. WiFi power save disabled (`wifi.powersave = 2`). Added 2026-03-26.
- **Overnight coder timer** (`overnight-coder.timer`): Runs 22:30 on Pi. Health check, 300s per-request timeout, incremental persistence, EVO liveness check per round.
