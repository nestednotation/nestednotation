# Nested Notation LAN build: session page compression

Serotonin's session page is 43.4 MB uncompressed. On the live site, Cloudflare compresses it to 1.1 MB (zstd). A LAN build has no Cloudflare, so the app compresses it itself, in **local mode** only.

## Local mode

Set `LOCAL_MODE=1` (or `true` / `yes`) in the LAN server's environment: its PM2 entry, or the shell that starts it.

- **Never on the live or dev site.** Cloudflare passes an origin's gzip through unchanged, so phones would get the 5.6 MB gzip copy instead of Cloudflare's 1.1 MB.
- So never put it in `.env.development` or `.env.production`: both are tracked in git and loaded by the deployed servers.
- Without it, the server behaves as before: nothing is compressed, and Cloudflare does it.

## What it does (done)

1. **The session page is compressed once, after each publish.**
   - A publish is a score going live: at boot, at session creation, and at every "update session".
   - Each revision's page `server_state/<id>.rev-<rev>.html` gets a gzip copy beside it, `<page>.gz` (level 9).
   - Compression runs in the background, one page at a time across the server, so boot and updates never wait for it.
   - A page replaced before its turn is skipped.
   - The copy is removed with its revision and when the session is deleted.
2. **The session route sends the gzip copy** to a browser that accepts gzip, once the copy exists. Otherwise it sends the plain page. It sends `Content-Encoding`, `Content-Type: text/html` and `Vary: Accept-Encoding`.
3. **The session route is off `apicache`** in every mode. The cache keyed one response per URL regardless of what the browser accepts, and held a copy of a page tens of MB large per password. The page is now sent from disk, with 304 for repeat requests.
4. **Sub-score frames (`/session/<id>/sub/<name>`) are gzipped too.**
   - Each sub-score's response and its gzip are made at publish, so the first dive into a sub-score doesn't wait for them.
   - In local mode this route skips `apicache` for the same reason as the page. Outside local mode it is unchanged.
5. **`.m4a` sounds are left as they are.** They're already compressed.

Measured with Serotonin, per phone: **5.6 MB** with gzip, against 43.4 MB uncompressed. Compressing the page takes about 2.3 s on a recent laptop; expect two to three times that on the 2013 MacBook.

## Still to do: HTTPS, then Brotli

Browsers accept Brotli only over HTTPS. Brotli would bring Serotonin's page to **0.45 MB** (measured, quality 11). That's smaller than Cloudflare's 1.1 MB. Compressing takes about 11 s, still in the background.

- Use `lan.nestednotation.com` with a Let's Encrypt certificate via the DNS-01 check through Cloudflare.
  - Renew while online, before each run of shows: certificates last 90 days.
- Point the name at the server. Use a local DNS record on the gateway, plus a public Cloudflare record for the same private IP: phones using Private DNS or iCloud Private Relay skip the gateway's DNS.
- Put an HTTPS proxy (for example Caddy) in front of **both** the page port and the WebSocket port. The WebSocket runs its own server on `WS_PORT`, so the page alone isn't enough.
- Use `wss://`. Set `WS_PATH` in PM2 or the shell: `bin/www` reads the `.env` files only after `database.js` has fixed the address. Better, compute it in the browser from `window.location`.
- In the app: write a `.br` copy beside the `.gz`, and send it first to a browser that accepts `br`.
