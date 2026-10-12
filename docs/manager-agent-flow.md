# Manager Agent — End-to-End Flow Analysis

> File ini akan di-update setelah kamu tambah referensi/sumber lain.

---

## 1. Ringkasan Arsitektur Manager

Manager adalah **hybrid deterministic + LLM**. Sebagian besar keputusan exit di-handle oleh kode JS murni, LLM cuma dipanggil untuk eksekusi dan kasus khusus.

**Alur tiap siklus (`runManagementCycle` di `index.js`):**

```
fetchPositions() → JS: updatePnlAndCheckExits → JS: getDeterministicCloseRule
         ↓                                            ↓
    exitMap (4 kondisi)                       closeRule (5 rules)
         ↓                                            ↓
    ┌────┴────────────────────────────────────────────┴────┐
    │                actionMap (Map<position, action>)     │
    │  Priority: exit > instruction > closeRule > claim > STAY │
    └────────────────────────┬────────────────────────────┘
                             ↓
            Ada action != STAY? ──Tidak──→ "all STAY, skip LLM"
                             ↓ Ya
                     agentLoop(MANAGER)
                     dengan goal pre-assigned
                     → LLM tinggal execute
```

---

## 2. Layer 1: `updatePnlAndCheckExits` — 4 Kondisi Exit

**File:** `state.js:381-471`

Ini fungsi JS murni yang dipanggil di setiap management cycle + 30s PnL poller.

### Kondisi 1: STOP_LOSS (line 421-427)
```
Trigger: pnl_pct <= stopLossPct
Aksi:   Langsung CLOSE, tanpa konfirmasi
Guard:  Skip jika pnl_pct_suspicious === true
Config: stopLossPct = -15% (kamu)
```
Tidak ada recheck/konfirmasi. Kalau PnL sudah ≤ -15%, posisi langsung ditutup.

### Kondisi 2: TRAILING_TP (line 429-442)
```
Trigger: trailing_active && (peak_pnl_pct - current_pnl_pct) >= trailingDropPct
Aksi:   return needs_confirmation: true → masuk 2-phase confirmation
Config: trailingActivate = true, trailingTriggerPct = 3%, trailingDropPct = 1.5%
```
Tidak langsung close. Butuh 15 detik recheck dulu untuk memastikan bukan flash wick.

**2-Phase Confirmation:**
```
Phase 1 (PnL poller 30s):
  queueTrailingDropConfirmation() → simpan pending_trailing_* fields
  → tunggu 15 detik

Phase 2 (setTimeout 15s):
  resolvePendingTrailingDrop() → fetch ulang posisi
  → Kalau drop masih hold (dalam toleransi 1%):
      → confirmed_trailing_exit_reason = "..."
      → confirmed_trailing_exit_until = now + 30s
  → Kalau udah balik lagi:
      → clear pending_*, gak jadi close

Phase 3 (management cycle berikutnya):
  updatePnlAndCheckExits() lihat confirmed_trailing_exit_reason
  → return { action: "TRAILING_TP", confirmed_recheck: true }
  → actionMap → CLOSE
```

### Kondisi 3: OUT_OF_RANGE (line 444-453)
```
Trigger: in_range === false && minutesOOR >= outOfRangeWaitMinutes
Aksi:   Langsung CLOSE
Config: outOfRangeWaitMinutes = 30 menit (kamu)
```
OOR dihitung sejak `out_of_range_since` diset pertama kali. Kalau balik in-range, timer direset.

### Kondisi 4: LOW_YIELD (line 455-468)
```
Trigger: fee_per_tvl_24h < minFeePerTvl24h && age_minutes >= minAgeBeforeYieldCheck
Aksi:   Langsung CLOSE
Config: minFeePerTvl24h = 3%, minAgeBeforeYieldCheck = 120 menit (kamu)
```
Hanya aktif setelah posisi berumur 120 menit (biar fair, gak langsung diclose pas baru deploy).

---

## 3. Layer 2: `getDeterministicCloseRule` — 5 Hard Rules

**File:** `index.js:1276-1330`

Ini fungsi JS murni yang dipanggil hanya untuk posisi yang TIDAK punya exit alert dari Layer 1.

### Rule 1: STOP LOSS (line 1295-1300)
```
Trigger: pnl_pct <= stopLossPct
Guard:   Skip jika pnlSuspect === true
```
Sama dengan kondisi STOP_LOSS di Layer 1, tapi ini untuk safety net kalau Layer 1 terlewat.

### Rule 2: TAKE PROFIT (line 1302-1307)
```
Trigger: pnl_pct >= takeProfitPct
Guard:   Skip jika pnlSuspect === true
Config:  takeProfitPct = 5% (kamu)
```
Kalau PnL >= 5%, posisi dianggap sudah cukup untung dan diclose.

### Rule 3: PUMPED FAR ABOVE RANGE (line 1309-1314)
```
Trigger: active_bin > upper_bin + outOfRangeBinsToClose
Config:  outOfRangeBinsToClose = 10 (default)
```
Harga sudah pump jauh di atas range LP. Token mungkin lagi FOMO, better take profit.

### Rule 4: OOR TOO LONG (line 1316-1323)
```
Trigger: active_bin > upper_bin && minutesOOR >= outOfRangeWaitMinutes
Config:  outOfRangeWaitMinutes = 30 menit (kamu)
```
Safety net kedua untuk OOR (sama dengan Layer 1 Condition 3).

### Rule 5: LOW YIELD (line 1325-1330)
```
Trigger: fee_per_tvl_24h < minFeePerTvl24h && age_minutes >= 60
Config:  minFeePerTvl24h = 3%, age hardcoded 60 menit
```
Mirip Layer 1 Condition 4, tapi age_minutes hardcoded 60 (tidak pakai minAgeBeforeYieldCheck dari config).

### PnL Suspect Guard (line 1278-1289)

Fungsi inline yang ngecek apakah data PnL bisa dipercaya:
```
if (pnl_pct <= -90% && total_value_usd > 0.01) {
    → PnL dianggap suspect (data glitch), skip Rules 1 dan 2
}
```
Rules 3-5 tetap jalan karena tidak bergantung pada pnl_pct.

---

## 4. ActionMap Priority — Bagaimana action Ditentukan

**File:** `index.js:351-379`

```
Untuk setiap posisi:
  1. Cek exitMap (dari updatePnlAndCheckExits)
     → Ada alert? → action = CLOSE, skip semua step lain

  2. Cek instruction (dari set_position_note)
     → Ada instruction? → action = INSTRUCTION (LLM yg decide)

  3. Cek getDeterministicCloseRule
     → Rule 1-5 terpenuhi? → action = CLOSE

  4. Cek unclaimed_fees_usd >= minClaimAmount
     → Cukup? → action = CLAIM

  5. Default: action = STAY
```

--- 

## 5. Kapan LLM Dipanggil vs JS Handle Sendiri

**File:** `index.js:433-495`

### JS handle sendiri (no LLM cost):
Semua kondisi ini menghasilkan CLOSE langsung tanpa LLM:
- STOP_LOSS, TRAILING_TP (confirmed), OOR, LOW_YIELD dari Layer 1
- Rules 1-5 dari Layer 2
- CLAIM (claim fees)
- STAY (gak ada action)

### LLM dipanggil hanya ketika:
```
const actionPositions = [...actionMap.entries()]
    .filter(([_, v]) => v.action !== "STAY");

if (actionPositions.length > 0) {
    // Bangun goal dengan pre-assigned action
    const goal = `MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)\n\n` +
        actionPositions.map(([addr, a]) => `POSITION: ${state.positions[addr]?.pair ?? addr.slice(0,8)}...\n  action: ${a.action} — ${a.rule ? `Rule ${a.rule}: ${a.reason}` : a.reason || ""}\n  ...`).join("\n\n") +
        `\n\nRULES:\n- CLOSE: call close_position only\n- CLAIM: call claim_fees\n- INSTRUCTION: evaluate instruction condition\n- ⚡ exit alerts: close immediately, no exceptions`;
    
    const result = await agentLoop(goal, 10, [], "MANAGER", ...);
}
```

### LLM role untuk MANAGER:
LLM hanya **mengeksekusi** action yang sudah ditentukan oleh JS. LLM tidak boleh re-evaluate:
- CLOSE → panggil `close_position`
- CLAIM → panggil `claim_fees`
- INSTRUCTION → cek kondisi, kalau terpenuhi → `close_position`

Setelah close, LLM juga handle `swap_token` untuk konversi base token ke SOL.

---

## 6. MANAGER System Prompt — Apa yang Dilihat LLM

**File:** `prompt.js:18-35`

**Catatan Penting:** Prompt yang diterima MANAGER adalah LEAN (hanya 14 baris).

```
You are an autonomous DLMM LP agent on Meteora, Solana. Role: MANAGER

This is a mechanical rule-application task. All position data is pre-loaded. 
Apply the close/claim rules directly and output the report.

Portfolio: {wallet balances}
Management Config: {semua config.management keys}

BEHAVIORAL CORE:
1. PATIENCE IS PROFIT
2. GAS EFFICIENCY: close_position costs gas. swap_token MANDATORY untuk token >= $0.10
3. DATA-DRIVEN AUTONOMY

LESSONS LEARNED: ...
Timestamp: ...
```

**Yang TIDAK ada di prompt MANAGER (tapi tertulis di dead code `prompt.js:130-145`):**
- ❌ "BIAS TO HOLD" — tidak di-inject ke LLM
- ❌ "INSTRUCTION CHECK (HIGHEST PRIORITY)" — tidak di-inject ke LLM (tapi ada di goal)
- ❌ "Decision Factors for Closing" — tidak di-inject ke LLM
- ❌ "Do NOT call get_top_candidates..." — tidak di-inject ke LLM

Dead code di `prompt.js:130-145` tidak pernah dieksekusi karena fungsi `buildSystemPrompt` sudah return di line 35 untuk MANAGER.

---

## 7. MANAGER Tools (yang bisa dipanggil LLM)

**File:** `agent.js:7-14`

```
close_position
claim_fees
swap_token
get_position_pnl
get_my_positions
get_wallet_balance
```

Tools yang TIDAK bisa dipanggil MANAGER:
- ❌ `deploy_position` (hanya SCREENER)
- ❌ `get_top_candidates` (hanya SCREENER)
- ❌ `get_active_bin` (hanya SCREENER)
- ❌ `self_update` / `update_config`
- ❌ Semua `add_*` / `remove_*` tools

---

## 8. PnL Poller (30s Interval)

**File:** `index.js:1095-1185`

Di antara management cycle (15 menit), ada poller ringan tiap 30 detik yang:
1. Fetch posisi (`force: true, silent: true`)
2. Panggil `recordPositionSnapshot` + update `peak_pnl_pct`
3. Panggil `updatePnlAndCheckExits` → queue trailing drop confirmation
4. Panggil `getDeterministicCloseRule`
5. Kalau ada trigger → panggil `runManagementCycle()` langsung

Guard:
- `_pollTriggeredAt` cooldown = managementIntervalMin (15 menit) — cegah trigger terlalu sering
- `_managementBusy` — jangan overlap dengan management cycle yg sedang jalan
- `shouldUsePnlRecheck()` — skip kalau relay mode aktif

---

## 9. Position State Fields untuk Trailing TP

**File:** `state.js:85-116`

| Field | Default | Fungsi |
|-------|---------|--------|
| `peak_pnl_pct` | 0 | Peak PnL tertinggi yang sudah terkonfirmasi |
| `pending_peak_pnl_pct` | null | Kandidat peak baru (nunggu konfirmasi 15s) |
| `pending_peak_started_at` | null | Waktu kandidat peak di-queue |
| `pending_trailing_current_pnl_pct` | null | PnL saat ini pas drop candidate |
| `pending_trailing_peak_pnl_pct` | null | Peak PnL pas drop candidate |
| `pending_trailing_drop_pct` | null | Besar drop ketika di-queue |
| `pending_trailing_started_at` | null | Waktu drop di-queue |
| `confirmed_trailing_exit_reason` | null | Alasan setelah konfirmasi 15s |
| `confirmed_trailing_exit_until` | null | Expiry (30 detik) untuk confirmed exit |
| `trailing_active` | false | Apakah trailing TP sudah armed |
| `out_of_range_since` | null | ISO timestamp mulai OOR |

---

## 10. Konfigurasi Management Kamu Saat Ini

### Dari user-config.json:
| Key | Value | Default | Selisih |
|-----|-------|---------|---------|
| `stopLossPct` | **-15** | -50 | Lebih ketat (cut loss lebih cepet) |
| `takeProfitPct` | **5** | 5 | Sama |
| `trailingTakeProfit` | **true** | true | Sama |
| `trailingTriggerPct` | **3** | 3 | Sama |
| `trailingDropPct` | **1.5** | 1.5 | Sama |
| `minFeePerTvl24h` | **3** | 7 | Lebih longgar (3% yield masih dianggap ok) |
| `minAgeBeforeYieldCheck` | **120** | 60 | 2 jam baru dicek yield-nya |
| `outOfRangeWaitMinutes` | **30** | 30 | Sama |
| `minClaimAmount` | **5** | 5 | Sama |
| `deployAmountSol` | **0.1** | 0.5 | Lebih kecil |
| `positionSizePct` | **0.8** | 0.35 | 80% saldo SOL kepake |
| `gasReserve` | **0.03** | 0.2 | Lebih kecil |

---

## 11. Ringkasan Flow Keputusan

```
30s PnL Poller
  │
  ├── updatePnlAndCheckExits()
  │     ├── STOP_LOSS (-15%)          → exitMap, langsung CLOSE
  │     ├── TRAILING_TP (drop 1.5%)   → queue 15s recheck
  │     ├── OOR (30 menit)            → exitMap, langsung CLOSE
  │     └── LOW_YIELD (fee < 3%, age > 120m) → exitMap, langsung CLOSE
  │
  └── Kalau ada trigger → panggil management cycle langsung

Management Cycle (tiap 15 menit)
  │
  ├── fetchPositions() → getMyPositions()
  ├── recordPositionSnapshot()
  ├── updatePnlAndCheckExits() → exitMap (prioritas 1)
  ├── getDeterministicCloseRule() → closeRule (prioritas 3)
  ├── Cek instruction + claim threshold
  │
  ├── actionMap: exit > instruction > closeRule > claim > STAY
  │
  └── Ada action != STAY?
        ├── Ya → LLM di-invoke dengan pre-assigned actions
        │        LLM execute: close_position / claim_fees / swap_token
        └── Tidak → "all STAY, skipping LLM"
```

---

## Referensi File Utama

| File | Baris | Fungsi |
|------|-------|--------|
| `index.js` | 276-542 | `runManagementCycle` — orchestration utama |
| `index.js` | 1095-1185 | PnL poller 30s |
| `index.js` | 1276-1330 | `getDeterministicCloseRule` — 5 hard rules |
| `state.js` | 85-116 | Position state fields (defaults) |
| `state.js` | 381-471 | `updatePnlAndCheckExits` — 4 exit conditions |
| `state.js` | 215-323 | 2-phase trailing TP (queue + resolve) |
| `prompt.js` | 18-35 | MANAGER system prompt (EARLY RETURN) |
| `prompt.js` | 130-145 | MANAGER prompt DEAD CODE (tidak pernah dieksekusi) |
| `agent.js` | 7-14 | MANAGER_TOOLS |
| `agent.js` | 157+ | ReAct loop |
| `config.js` | 95-123 | Management section defaults |
| `user-config.json` | - | Override config kamu |
