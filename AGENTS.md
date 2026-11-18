# AGENTS.md — `durable-object-service`

## 1. Project Role & Boundary
- **Peran:** *High-concurrency engine* (`SlotCell` Durable Object) untuk menangani *war* tiket, validasi `redeem`, dan penutupan sesi secara atomik.
- **Yang BOLEH di repo ini:** State management di SQLite/RAM Durable Object, validasi kuota & keunikan klaim, endpoint HTTP `SlotCell`, serta *flush* data akhir sesi ke Frappe.
- **Yang TIDAK BOLEH di repo ini:** Menyimpan master data jangka panjang, menangani login/session user, atau merender UI.

## 2. Tech Stack & Project Structure
- **Stack:** Cloudflare Workers & Durable Objects (`wrangler ^4.160.1`), SQLite DO Storage, `zod ^4.6.7`.
- **Struktur Inti (`src/`):**
  - `src/index.js` — Worker entrypoint & routing berdasarkan header `X-Workspace-ID`.
  - `src/cell/SlotCell.js` — Class Durable Object utama (state, `transactionSync`, HTTP handler).
  - `src/cell/schema.js` — Skema SQLite (`slots`, `claims`, `idx_one_active_per_user`).
  - `src/lib/response.js` — Helper response JSON (`ok`, `fail`).

## 3. Coding Conventions & Guardrails
- **Routing Key:** `X-Workspace-ID` wajib berformat tanggal `YYYY-MM-DD` (1 `SlotCell` = 1 hari operasional lintas semua unit food truck).
- **Atomicity & Idempotency:** Seluruh mutasi kuota & status tiket wajib dibungkus `this.storage.transactionSync(...)`. Endpoint `POST /claim` wajib *idempotent* berdasarkan `request_id`.
- **Active Ticket Lookup:** Sediakan `GET /my-claim?user_id=...` agar Frappe dapat menampilkan kembali QR Code tiket aktif mahasiswa saat halaman di-reload.
- **Auth:** Verifikasi shared secret header pada setiap request masuk dari Frappe; tolak dengan `401 Unauthorized` jika tidak valid.
- **Lifecycle Tiket:** Jangan gunakan *auto-expire* alarm di tengah sesi. Tiket `CLAIMED` hanya berubah menjadi `EXPIRED` saat `POST /close-session` dipanggil.

## 4. Local Dev & Verification
- Jalankan local dev server: `npm run dev` (atau `npx wrangler dev`)

## 5. GitHub Issue & Workflow Rules
- **Repo:** `BektiHandoyo/food-truck-durable-object` (Master Issue: `#2`).
- Sebelum mulai ngoding, cek detail & Acceptance Criteria sub-issue terkait dengan `gh issue view <nomor> --repo BektiHandoyo/food-truck-durable-object`.
- **Wajib konfirmasi user** sebelum melakukan mutasi GitHub (`gh issue create/edit/close`, `git push`) atau menjalankan `npm run deploy`.
