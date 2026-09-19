const ALLOWED_ORIGINS = new Set([
  "https://myintmoehein0115024.github.io",
  "http://localhost",
  "http://127.0.0.1",
]);

const MAX_MESSAGES = 80;
const MESSAGE_TTL_MS = 48 * 60 * 60 * 1000;
const PHOTO_TTL_SEC = 48 * 60 * 60;
const PRESENCE_STALE_MS = 75 * 1000;
const PRESENCE_CLEAN_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_KEY_RE = /^[a-f0-9]{40}$/;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://myintmoehein0115024.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Room-Key,X-Media-Key,X-User",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...corsHeaders(request),
    },
  });
}

function okText(text, request) {
  return new Response(text, {
    status: 200,
    headers: { "Cache-Control": "no-store", ...corsHeaders(request) },
  });
}

function getRoomKey(request) { return (request.headers.get("X-Room-Key") || "").trim().toLowerCase(); }
function validRoomKey(value) { return ROOM_KEY_RE.test(value); }
function getMediaKey(request) { return (request.headers.get("X-Media-Key") || "").trim().toLowerCase(); }
function getUser(request) { return (request.headers.get("X-User") || "").trim(); }
function validUser(value) { return value === "Ko Ko" || value === "Chit Chit"; }
function otherUser(value) { return value === "Ko Ko" ? "Chit Chit" : "Ko Ko"; }
function validMediaKey(value, roomKey) {
  return new RegExp(`^${roomKey}/[0-9a-f-]{36}\\.bin$`).test(value);
}

async function cleanupExpired(db, photos) {
  const now = Date.now();
  try {
    while (true) {
      const rows = await db.prepare(
        "SELECT id, media_key FROM messages WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 100"
      ).bind(now).all();
      const results = rows.results || [];
      if (!results.length) break;
      const ids = results.map(r => String(r.id));
      if (photos) {
        for (const key of results.map(r => r.media_key).filter(Boolean)) {
          try { await photos.delete(key); } catch {}
        }
      }
      const marks = ids.map(() => "?").join(",");
      await db.batch([
        db.prepare(`DELETE FROM message_reads WHERE message_id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM message_edits WHERE message_id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...ids),
      ]);
      if (results.length < 100) break;
    }
    await db.prepare("DELETE FROM presence WHERE last_seen < ?").bind(now - PRESENCE_CLEAN_MS).run().catch(() => {});
  } catch {}
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "always-yours-chat-api", photos: Boolean(env.PHOTOS) }, 200, request);
    }
    if (!env.DB) return json({ ok: false, error: "D1 binding DB is missing." }, 500, request);
    if (!env.PHOTOS) return json({ ok: false, error: "KV binding PHOTOS is missing." }, 500, request);

    const roomKey = getRoomKey(request);
    if (!validRoomKey(roomKey)) return json({ ok: false, error: "Invalid room key." }, 401, request);
    const user = getUser(request);
    if (user && !validUser(user)) return json({ ok: false, error: "Invalid user." }, 400, request);
    ctx.waitUntil(cleanupExpired(env.DB, env.PHOTOS));

    if (url.pathname === "/api/media" && request.method === "POST") {
      const mediaKey = getMediaKey(request);
      if (!validMediaKey(mediaKey, roomKey)) return json({ ok: false, error: "Invalid media key." }, 400, request);
      const len = Number(request.headers.get("Content-Length") || 0);
      if (len && len > 5_000_000) return json({ ok: false, error: "Photo is too large after compression." }, 413, request);
      try {
        const body = await request.arrayBuffer();
        if (body.byteLength > 5_000_000) return json({ ok: false, error: "Photo is too large after compression." }, 413, request);
        await env.PHOTOS.put(mediaKey, body, { expirationTtl: PHOTO_TTL_SEC });
        return json({ ok: true, media_key: mediaKey, expires_at: Date.now() + MESSAGE_TTL_MS }, 201, request);
      } catch {
        return json({ ok: false, error: "Could not store photo." }, 500, request);
      }
    }

    if (url.pathname === "/api/media" && request.method === "GET") {
      const mediaKey = (url.searchParams.get("key") || "").trim().toLowerCase();
      if (!validMediaKey(mediaKey, roomKey)) return json({ ok: false, error: "Invalid media key." }, 400, request);
      try {
        const object = await env.PHOTOS.get(mediaKey, { type: "arrayBuffer" });
        if (object === null) return json({ ok: false, error: "Photo expired or not found." }, 404, request);
        return new Response(object, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "private, no-store",
            ...corsHeaders(request),
          },
        });
      } catch {
        return json({ ok: false, error: "Could not read photo." }, 500, request);
      }
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      const now = Date.now();
      try {
        const result = await env.DB.prepare(`
          SELECT
            m.id, m.room_id, m.sender,
            COALESCE(e.ciphertext, m.ciphertext) AS ciphertext,
            COALESCE(e.iv, m.iv) AS iv,
            m.created_at, m.expires_at, m.media_key,
            e.edited_at,
            (
              SELECT MAX(r.read_at)
              FROM message_reads r
              WHERE r.room_id = m.room_id
                AND r.message_id = m.id
                AND r.reader = CASE WHEN m.sender = 'Ko Ko' THEN 'Chit Chit' ELSE 'Ko Ko' END
            ) AS seen_at
          FROM messages m
          LEFT JOIN message_edits e
            ON e.room_id = m.room_id AND e.message_id = m.id
          WHERE m.room_id = ? AND m.expires_at > ?
          ORDER BY m.created_at ASC
          LIMIT ?
        `).bind(roomKey, now, MAX_MESSAGES).all();
        return json({ ok: true, messages: result.results || [] }, 200, request);
      } catch {
        return json({ ok: false, error: "Could not read messages. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    if (url.pathname === "/api/messages" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON." }, 400, request); }
      const id = String(body?.id || "").trim();
      const sender = String(body?.sender || "").trim();
      const ciphertext = String(body?.ciphertext || "").trim();
      const iv = String(body?.iv || "").trim();
      const mediaKey = String(body?.media_key || "").trim().toLowerCase();
      if (!id || id.length > 80) return json({ ok: false, error: "Invalid message id." }, 400, request);
      if (!(sender === "Ko Ko" || sender === "Chit Chit")) return json({ ok: false, error: "Invalid sender." }, 400, request);
      if (!ciphertext || ciphertext.length > 12000) return json({ ok: false, error: "Message payload is too large." }, 413, request);
      if (!iv || iv.length > 128) return json({ ok: false, error: "Invalid encryption IV." }, 400, request);
      if (mediaKey && !validMediaKey(mediaKey, roomKey)) return json({ ok: false, error: "Invalid media key." }, 400, request);
      const now = Date.now();
      const expiresAt = now + MESSAGE_TTL_MS;
      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO messages
            (id, room_id, sender, ciphertext, iv, created_at, expires_at, media_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, roomKey, sender, ciphertext, iv, now, expiresAt, mediaKey || null).run();
        return json({ ok: true, id, created_at: now, expires_at: expiresAt }, 201, request);
      } catch {
        return json({ ok: false, error: "Could not save message. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    if (url.pathname.startsWith("/api/messages/") && request.method === "PATCH") {
      const messageId = decodeURIComponent(url.pathname.slice("/api/messages/".length)).trim();
      if (!user || !validUser(user)) return json({ ok: false, error: "Your user name is required." }, 401, request);
      if (!messageId || messageId.length > 80) return json({ ok: false, error: "Invalid message id." }, 400, request);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON." }, 400, request); }
      const ciphertext = String(body?.ciphertext || "").trim();
      const iv = String(body?.iv || "").trim();
      if (!ciphertext || ciphertext.length > 12000) return json({ ok: false, error: "Edited message is too large." }, 413, request);
      if (!iv || iv.length > 128) return json({ ok: false, error: "Invalid encryption IV." }, 400, request);
      try {
        const existing = await env.DB.prepare(
          "SELECT sender, expires_at FROM messages WHERE room_id = ? AND id = ? LIMIT 1"
        ).bind(roomKey, messageId).first();
        if (!existing) return json({ ok: false, error: "Message not found or expired." }, 404, request);
        if (existing.sender !== user) return json({ ok: false, error: "You can only edit your own messages." }, 403, request);
        if (Number(existing.expires_at || 0) <= Date.now()) return json({ ok: false, error: "Message has expired." }, 410, request);
        const editedAt = Date.now();
        await env.DB.prepare(`
          INSERT INTO message_edits (room_id, message_id, ciphertext, iv, edited_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(room_id, message_id) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            iv = excluded.iv,
            edited_at = excluded.edited_at
        `).bind(roomKey, messageId, ciphertext, iv, editedAt).run();
        return json({ ok: true, id: messageId, edited_at: editedAt }, 200, request);
      } catch {
        return json({ ok: false, error: "Could not edit message. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    if (url.pathname === "/api/read" && request.method === "POST") {
      if (!user || !validUser(user)) return json({ ok: false, error: "Your user name is required." }, 401, request);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON." }, 400, request); }
      const ids = Array.isArray(body?.ids) ? body.ids.map(v => String(v).trim()).filter(v => v && v.length <= 80).slice(0, MAX_MESSAGES) : [];
      if (!ids.length) return json({ ok: true, marked: 0 }, 200, request);
      const now = Date.now();
      try {
        const statements = ids.map(id => env.DB.prepare(`
          INSERT INTO message_reads (room_id, message_id, reader, read_at)
          SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM messages
            WHERE room_id = ? AND id = ? AND expires_at > ? AND sender <> ?
          )
          ON CONFLICT(room_id, message_id, reader) DO UPDATE SET read_at = excluded.read_at
        `).bind(roomKey, id, user, now, roomKey, id, now, user));
        if (statements.length) await env.DB.batch(statements);
        return json({ ok: true, marked: ids.length, read_at: now }, 200, request);
      } catch {
        return json({ ok: false, error: "Could not mark messages as seen. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    if (url.pathname === "/api/presence" && request.method === "POST") {
      if (!user || !validUser(user)) return json({ ok: false, error: "Your user name is required." }, 401, request);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON." }, 400, request); }
      const online = body?.online !== false;
      const now = Date.now();
      try {
        await env.DB.prepare(`
          INSERT INTO presence (room_id, user_name, last_seen, is_online)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(room_id, user_name) DO UPDATE SET
            last_seen = excluded.last_seen,
            is_online = excluded.is_online
        `).bind(roomKey, user, now, online ? 1 : 0).run();
        return json({ ok: true, user, last_seen: now, online }, 200, request);
      } catch {
        return json({ ok: false, error: "Could not update presence. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    if (url.pathname === "/api/presence" && request.method === "GET") {
      try {
        const result = await env.DB.prepare(
          "SELECT user_name, last_seen, is_online FROM presence WHERE room_id = ?"
        ).bind(roomKey).all();
        const out = {};
        const now = Date.now();
        for (const row of (result.results || [])) {
          out[row.user_name] = {
            last_seen: Number(row.last_seen || 0),
            online: Number(row.is_online || 0) === 1 && now - Number(row.last_seen || 0) <= PRESENCE_STALE_MS,
          };
        }
        return json({ ok: true, presence: out }, 200, request);
      } catch {
        return json({ ok: false, error: "Could not read presence. Run MIGRATE-READ-EDIT-PRESENCE.sql first." }, 500, request);
      }
    }

    return okText("Not found", request);
  },

  async scheduled(_controller, env) {
    if (!env.DB) return;
    await cleanupExpired(env.DB, env.PHOTOS);
  },
};
