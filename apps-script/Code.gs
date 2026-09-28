/**
 * Finance V2 — Google Sheets backend (security hardened)
 *
 * Estructura Usuarios:
 * user_id | email | nombre | pin_hash | access_token | activo |
 * pin_salt | pin_hash_v2 | session_token_hash | session_expires_at |
 * failed_attempts | locked_until | session_created_at
 *
 * Estructura Movimientos:
 * id | user_id | type | amount | category | note | occurred_at | created_at
 *
 * IMPORTANTE:
 * - El Web App debe ejecutarse como propietario.
 * - La hoja debe permanecer privada.
 * - No ejecutes una función que borre la hoja para "migrar": setupDatabase()
 *   ahora es idempotente y conserva los datos existentes.
 */

const SPREADSHEET_ID = "1p28vCB9VL_C_fsmgYyptJlKagq0davxVmcgWYJWg3nk";
const USERS_SHEET = "Usuarios";
const TX_SHEET = "Movimientos";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_AMOUNT = 100000000;
const MAX_CATEGORY = 60;
const MAX_NOTE = 500;

const USER_HEADERS = [
  "user_id", "email", "nombre", "pin_hash", "access_token", "activo",
  "pin_salt", "pin_hash_v2", "session_token_hash", "session_expires_at",
  "failed_attempts", "locked_until", "session_created_at"
];

const TX_HEADERS = [
  "id", "user_id", "type", "amount", "category", "note", "occurred_at", "created_at"
];

function doGet() {
  return json_({
    ok: true,
    service: "Finance API",
    version: "2.0-secure",
    backend: "Google Sheets"
  });
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || "";
    if (!raw || raw.length > 200000) {
      return json_({ ok: false, error: "Solicitud inválida." });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      return json_({ ok: false, error: "Solicitud JSON inválida." });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json_({ ok: false, error: "Solicitud inválida." });
    }

    const action = String(body.action || "");

    if (action === "login") return login_(body);
    if (action === "logout") return logout_(body);
    if (action === "list") return list_(body);
    if (action === "upsert") return upsert_(body);
    if (action === "delete") return delete_(body);
    if (action === "ping") return json_({ ok: true });

    return json_({ ok: false, error: "Acción no válida." });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: "Error interno del servidor." });
  }
}

/**
 * Migración segura/idempotente.
 * Nunca borra los movimientos existentes ni reinicia los usuarios.
 */
function setupDatabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  let users = ss.getSheetByName(USERS_SHEET);
  if (!users) users = ss.insertSheet(USERS_SHEET);
  ensureHeaders_(users, USER_HEADERS);

  let tx = ss.getSheetByName(TX_SHEET);
  if (!tx) tx = ss.insertSheet(TX_SHEET);
  ensureHeaders_(tx, TX_HEADERS);

  // Solo crea usuarios iniciales si la hoja está vacía después del encabezado.
  if (users.getLastRow() <= 1) {
    const seed = [
      ["U001", "", "Usuario 1", hashLegacy_("CAMBIAR-0001"), "", true, "", "", "", "", 0, "", ""],
      ["U002", "", "Usuario 2", hashLegacy_("CAMBIAR-0002"), "", true, "", "", "", "", 0, "", ""],
      ["U003", "", "Usuario 3", hashLegacy_("CAMBIAR-0003"), "", true, "", "", "", "", 0, "", ""]
    ];
    users.getRange(2, 1, seed.length, USER_HEADERS.length).setValues(seed);
  }

  users.autoResizeColumns(1, USER_HEADERS.length);
  tx.autoResizeColumns(1, TX_HEADERS.length);
  ensureServerSecret_();

  return "Base de datos preparada sin borrar datos existentes.";
}

function login_(body) {
  const email = normalizeEmail_(body.email);
  const pin = String(body.pin || "");

  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(pin)) {
    return json_({
      ok: false,
      code: "LOGIN_FAILED",
      error: "Correo o PIN incorrecto."
    });
  }

  const rate = loginRateState_(email);
  if (rate.lockedUntil > Date.now()) {
    return json_({
      ok: false,
      code: "RATE_LIMITED",
      error: "Demasiados intentos. Intenta nuevamente en unos minutos."
    });
  }

  const sheet = sheet_(USERS_SHEET);
  const schema = headerMap_(sheet);
  const rows = values_(sheet);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowEmail = normalizeEmail_(row[schema.email]);

    if (rowEmail !== email) continue;
    if (String(row[schema.activo]).toLowerCase() === "false") break;

    const storedV2 = String(row[schema.pin_hash_v2] || "");
    const salt = String(row[schema.pin_salt] || "");
    let valid = false;

    if (storedV2 && salt) {
      valid = secureEqual_(storedV2, pinHashV2_(pin, salt));
    } else {
      // Migración transparente del hash antiguo al primer login correcto.
      valid = secureEqual_(String(row[schema.pin_hash] || ""), hashLegacy_(pin));
    }

    if (!valid) {
      registerFailedLogin_(email);
      return json_({
        ok: false,
        code: "LOGIN_FAILED",
        error: "Correo o PIN incorrecto."
      });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const fresh = sheet.getRange(i + 1, 1, 1, USER_HEADERS.length).getValues()[0];

      // Releer por si otro login ocurrió al mismo tiempo.
      const freshSalt = String(fresh[schema.pin_salt] || "");
      const pinSalt = freshSalt || randomToken_();
      const pinHashV2 = freshSalt
        ? String(fresh[schema.pin_hash_v2] || "")
        : pinHashV2_(pin, pinSalt);

      if (!pinHashV2 || !secureEqual_(pinHashV2, pinHashV2_(pin, pinSalt))) {
        sheet.getRange(i + 1, schema.pin_salt + 1).setValue(pinSalt);
        sheet.getRange(i + 1, schema.pin_hash_v2 + 1).setValue(pinHashV2_(pin, pinSalt));
      } else if (String(fresh[schema.pin_hash] || "")) {
        // Borra el hash legacy una vez que ya existe el formato endurecido.
        sheet.getRange(i + 1, schema.pin_hash + 1).clearContent();
      }

      const accessToken = randomToken_();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

      sheet.getRange(i + 1, schema.access_token + 1).clearContent();
      sheet.getRange(i + 1, schema.session_token_hash + 1).setValue(tokenHash_(accessToken));
      sheet.getRange(i + 1, schema.session_expires_at + 1).setValue(expiresAt);
      sheet.getRange(i + 1, schema.session_created_at + 1).setValue(new Date().toISOString());
      sheet.getRange(i + 1, schema.failed_attempts + 1).setValue(0);
      sheet.getRange(i + 1, schema.locked_until + 1).clearContent();

      clearLoginRateState_(email);

      return json_({
        ok: true,
        user: {
          id: String(fresh[schema.user_id]),
          email: email,
          name: String(fresh[schema.nombre] || "")
        },
        token: accessToken,
        expires_at: expiresAt
      });
    } finally {
      lock.releaseLock();
    }
  }

  // No revela si el correo está registrado.
  registerFailedLogin_(email);
  return json_({
    ok: false,
    code: "LOGIN_FAILED",
    error: "Correo o PIN incorrecto."
  });
}

function logout_(body) {
  const auth = auth_(body, true);
  if (!auth.ok) return json_(auth);

  const sheet = sheet_(USERS_SHEET);
  const schema = headerMap_(sheet);
  const rows = values_(sheet);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][schema.user_id]) === auth.userId) {
      const stored = String(rows[i][schema.session_token_hash] || "");
      if (stored && secureEqual_(stored, tokenHash_(String(body.token || "")))) {
        sheet.getRange(i + 1, schema.session_token_hash + 1).clearContent();
        sheet.getRange(i + 1, schema.session_expires_at + 1).clearContent();
        sheet.getRange(i + 1, schema.session_created_at + 1).clearContent();
      }
      break;
    }
  }

  return json_({ ok: true });
}

function list_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const sheet = sheet_(TX_SHEET);
  const schema = headerMap_(sheet);
  const rows = values_(sheet);
  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[schema.user_id]) !== auth.userId) continue;

    data.push({
      id: String(r[schema.id]),
      user_id: String(r[schema.user_id]),
      type: String(r[schema.type]),
      amount: Number(r[schema.amount]) || 0,
      category: String(r[schema.category] || "Otros"),
      note: r[schema.note] == null ? null : String(r[schema.note]),
      occurred_at: String(r[schema.occurred_at] || ""),
      created_at: String(r[schema.created_at] || "")
    });
  }

  return json_({ ok: true, items: data });
}

function upsert_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const row = body.row || {};
  const id = String(row.id || "").trim();
  if (!id || id.length > 100) {
    return json_({ ok: false, code: "INVALID_INPUT", error: "Movimiento sin id válido." });
  }

  const type = String(row.type || "expense");
  if (["expense", "income", "saving"].indexOf(type) === -1) {
    return json_({ ok: false, code: "INVALID_INPUT", error: "Tipo de movimiento inválido." });
  }

  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return json_({ ok: false, code: "INVALID_INPUT", error: "Monto inválido." });
  }

  const category = cleanText_(row.category || "Otros", MAX_CATEGORY) || "Otros";
  const note = row.note == null ? "" : cleanText_(row.note, MAX_NOTE);
  const occurredAt = validIso_(row.occurred_at) || new Date().toISOString();
  const createdAt = validIso_(row.created_at) || new Date().toISOString();

  const sheet = sheet_(TX_SHEET);
  const schema = headerMap_(sheet);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const rows = values_(sheet);
    let found = -1;

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][schema.id]) === id) {
        if (String(rows[i][schema.user_id]) !== auth.userId) {
          return json_({
            ok: false,
            code: "FORBIDDEN",
            error: "No tienes permiso para modificar este movimiento."
          });
        }
        found = i + 1;
        break;
      }
    }

    const values = [[
      safeCellText_(id),
      safeCellText_(auth.userId),
      safeCellText_(type),
      amount,
      safeCellText_(category),
      safeCellText_(note),
      safeCellText_(occurredAt),
      safeCellText_(createdAt)
    ]];

    if (found > 0) {
      sheet.getRange(found, 1, 1, TX_HEADERS.length).setValues(values);
    } else {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, TX_HEADERS.length).setValues(values);
    }
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

function delete_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const id = String(body.id || "").trim();
  if (!id || id.length > 100) {
    return json_({ ok: false, code: "INVALID_INPUT", error: "Id inválido." });
  }

  const sheet = sheet_(TX_SHEET);
  const schema = headerMap_(sheet);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const rows = values_(sheet);
    for (let i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][schema.id]) === id) {
        if (String(rows[i][schema.user_id]) !== auth.userId) {
          return json_({
            ok: false,
            code: "FORBIDDEN",
            error: "No tienes permiso para eliminar este movimiento."
          });
        }
        sheet.deleteRow(i + 1);
        return json_({ ok: true });
      }
    }
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

function auth_(body, allowExpiredForLogout) {
  const userId = String(body.user_id || "").trim();
  const token = String(body.token || "").trim();

  if (!userId || !token || token.length < 32 || token.length > 200) {
    return { ok: false, code: "AUTH_INVALID", error: "Sesión no válida." };
  }

  const sheet = sheet_(USERS_SHEET);
  const schema = headerMap_(sheet);
  const rows = values_(sheet);
  const presentedHash = tokenHash_(token);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][schema.user_id]) !== userId) continue;
    if (String(rows[i][schema.activo]).toLowerCase() === "false") break;

    const storedHash = String(rows[i][schema.session_token_hash] || "");
    const expiresAt = Date.parse(String(rows[i][schema.session_expires_at] || ""));

    if (!storedHash || !secureEqual_(storedHash, presentedHash)) {
      return { ok: false, code: "AUTH_INVALID", error: "Sesión no válida." };
    }

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      if (!allowExpiredForLogout) {
        return { ok: false, code: "AUTH_EXPIRED", error: "La sesión expiró. Inicia sesión nuevamente." };
      }
    }

    return { ok: true, userId: userId };
  }

  return { ok: false, code: "AUTH_INVALID", error: "Sesión no válida." };
}

function sheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("No existe la hoja " + name + ". Ejecuta setupDatabase().");
  ensureHeaders_(sheet, name === USERS_SHEET ? USER_HEADERS : TX_HEADERS);
  return sheet;
}

function values_(sheet) {
  if (sheet.getLastRow() === 0) return [];
  return sheet.getDataRange().getValues();
}

function ensureHeaders_(sheet, expected) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
    return;
  }

  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), expected.length)).getValues()[0];
  let changed = false;

  expected.forEach(function(name, index) {
    if (String(current[index] || "").trim() !== name) {
      // Solo agrega columnas faltantes al final; no mueve ni borra datos existentes.
      if (index >= sheet.getLastColumn()) {
        sheet.getRange(1, index + 1).setValue(name);
        changed = true;
      }
    }
  });

  if (changed) SpreadsheetApp.flush();
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(x) { return String(x || "").trim(); });

  const map = {};
  headers.forEach(function(h, i) {
    if (h) map[h] = i;
  });

  const required = sheet.getName() === USERS_SHEET ? USER_HEADERS : TX_HEADERS;
  const missing = required.filter(function(h) { return map[h] == null; });
  if (missing.length) {
    ensureHeaders_(sheet, required);
    return headerMap_(sheet);
  }

  return map;
}

function normalizeEmail_(email) {
  return String(email || "").trim().toLowerCase().slice(0, 254);
}

function hashLegacy_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const v = b < 0 ? b + 256 : b;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}

function pinHashV2_(pin, salt) {
  return hmacHex_(String(salt) + "|" + String(pin), serverSecret_());
}

function tokenHash_(token) {
  return hmacHex_(String(token), serverSecret_());
}

function hmacHex_(value, key) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(value),
    String(key),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const v = b < 0 ? b + 256 : b;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}

function serverSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty("FINANCE_SERVER_SECRET");

  if (!secret) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      secret = props.getProperty("FINANCE_SERVER_SECRET");
      if (!secret) {
        secret = randomToken_();
        props.setProperty("FINANCE_SERVER_SECRET", secret);
      }
    } finally {
      lock.releaseLock();
    }
  }

  return secret;
}

function ensureServerSecret_() {
  serverSecret_();
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, "") +
         Utilities.getUuid().replace(/-/g, "");
}

function secureEqual_(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function loginRateState_(email) {
  const cache = CacheService.getScriptCache();
  const key = "finance-login:" + hashLegacy_(email);
  const raw = cache.get(key);
  if (!raw) return { count: 0, lockedUntil: 0 };

  try {
    const state = JSON.parse(raw);
    return {
      count: Number(state.count) || 0,
      lockedUntil: Number(state.lockedUntil) || 0
    };
  } catch (e) {
    return { count: 0, lockedUntil: 0 };
  }
}

function registerFailedLogin_(email) {
  const cache = CacheService.getScriptCache();
  const key = "finance-login:" + hashLegacy_(email);
  const state = loginRateState_(email);
  const count = state.count + 1;

  if (count >= LOGIN_MAX_FAILURES) {
    cache.put(key, JSON.stringify({
      count: count,
      lockedUntil: Date.now() + LOGIN_LOCK_MS
    }), Math.ceil(LOGIN_LOCK_MS / 1000));
    return;
  }

  cache.put(key, JSON.stringify({
    count: count,
    lockedUntil: 0
  }), Math.ceil(LOGIN_LOCK_MS / 1000));
}

function clearLoginRateState_(email) {
  CacheService.getScriptCache().remove("finance-login:" + hashLegacy_(email));
}

function validIso_(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 40) return "";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

function cleanText_(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function safeCellText_(value) {
  const s = String(value == null ? "" : value);
  // Evita que texto controlado por el usuario sea interpretado como fórmula por Sheets.
  if (/^[=+\\-@]/.test(s)) return "'" + s;
  return s;
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
