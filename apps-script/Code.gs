/**
 * Finance V2 — Google Sheets backend
 *
 * Estructura:
 * Usuarios: user_id | email | nombre | pin_hash | access_token | activo
 * Movimientos: id | user_id | type | amount | category | note | occurred_at | created_at
 *
 * 1) Crea una Google Sheet.
 * 2) Abre Extensiones > Apps Script.
 * 3) Pega este archivo.
 * 4) Cambia SPREADSHEET_ID.
 * 5) Ejecuta setupDatabase() una vez y autoriza.
 * 6) Completa los 3 usuarios en la hoja Usuarios.
 * 7) Implementa como Web App ejecutando como tú y acceso "Cualquiera".
 */

const SPREADSHEET_ID = "1p28vCB9VL_C_fsmgYyptJlKagq0davxVmcgWYJWg3nk";
const USERS_SHEET = "Usuarios";
const TX_SHEET = "Movimientos";

function doGet(e) {
  return json_({
    ok: true,
    service: "Finance API",
    version: "1.1",
    backend: "Google Sheets"
  });
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || "";
    if (!raw) return json_({ ok: false, error: "Cuerpo de solicitud vacío." });

    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      return json_({ ok: false, error: "Solicitud JSON inválida." });
    }
    const action = String(body.action || "");

    if (action === "login") return login_(body);
    if (action === "list") return list_(body);
    if (action === "upsert") return upsert_(body);
    if (action === "delete") return delete_(body);
    if (action === "ping") return json_({ ok: true });

    return json_({ ok: false, error: "Acción no válida." });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function setupDatabase() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID.indexOf("PEGA_AQUI") === 0) {
    throw new Error("Configura SPREADSHEET_ID antes de ejecutar setupDatabase().");
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  let users = ss.getSheetByName(USERS_SHEET);
  if (!users) users = ss.insertSheet(USERS_SHEET);
  users.clear();
  users.getRange(1, 1, 1, 6).setValues([[
    "user_id", "email", "nombre", "pin_hash", "access_token", "activo"
  ]]);

  const seed = [
    ["U001", "", "Usuario 1", hash_("CAMBIAR-0001"), token_(), true],
    ["U002", "", "Usuario 2", hash_("CAMBIAR-0002"), token_(), true],
    ["U003", "", "Usuario 3", hash_("CAMBIAR-0003"), token_(), true]
  ];
  users.getRange(2, 1, seed.length, seed[0].length).setValues(seed);

  let tx = ss.getSheetByName(TX_SHEET);
  if (!tx) tx = ss.insertSheet(TX_SHEET);
  tx.clear();
  tx.getRange(1, 1, 1, 8).setValues([[
    "id", "user_id", "type", "amount", "category", "note", "occurred_at", "created_at"
  ]]);

  users.autoResizeColumns(1, 6);
  tx.autoResizeColumns(1, 8);
}

function login_(body) {
  const email = normalizeEmail_(body.email);
  const pin = String(body.pin || "");

  if (!email || !/^\d{6}$/.test(pin)) {
    return json_({ ok: false, error: "Correo o PIN inválido." });
  }

  const sheet = sheet_(USERS_SHEET);
  const rows = values_(sheet);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (normalizeEmail_(row[1]) === email && String(row[5]).toLowerCase() !== "false") {
      if (String(row[3]) !== hash_(pin)) {
        return json_({ ok: false, error: "Correo o PIN incorrecto." });
      }

      let accessToken = String(row[4] || "");
      if (!accessToken) {
        accessToken = token_();
        sheet.getRange(i + 1, 5).setValue(accessToken);
      }

      return json_({
        ok: true,
        user: {
          id: String(row[0]),
          email: email,
          name: String(row[2] || "")
        },
        token: accessToken
      });
    }
  }

  return json_({ ok: false, error: "Este correo no está autorizado." });
}

function list_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const sheet = sheet_(TX_SHEET);
  const rows = values_(sheet);
  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]) !== auth.userId) continue;
    data.push({
      id: String(r[0]),
      user_id: String(r[1]),
      type: String(r[2]),
      amount: Number(r[3]) || 0,
      category: String(r[4] || "Otros"),
      note: r[5] == null ? null : String(r[5]),
      occurred_at: String(r[6] || ""),
      created_at: String(r[7] || "")
    });
  }

  return json_({ ok: true, items: data });
}

function upsert_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const row = body.row || {};
  const id = String(row.id || "");
  if (!id) return json_({ ok: false, error: "Movimiento sin id." });

  const sheet = sheet_(TX_SHEET);
  const rows = values_(sheet);
  let found = -1;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      if (String(rows[i][1]) !== auth.userId) {
        return json_({
          ok: false,
          error: "No tienes permiso para modificar este movimiento."
        });
      }
      found = i + 1;
      break;
    }
  }

  const values = [[
    id,
    auth.userId,
    String(row.type || "expense"),
    Number(row.amount) || 0,
    String(row.category || "Otros"),
    row.note == null ? "" : String(row.note),
    String(row.occurred_at || new Date().toISOString()),
    String(row.created_at || new Date().toISOString())
  ]];

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (found > 0) {
      sheet.getRange(found, 1, 1, 8).setValues(values);
    } else {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 8).setValues(values);
    }
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

function delete_(body) {
  const auth = auth_(body);
  if (!auth.ok) return json_(auth);

  const id = String(body.id || "");
  const sheet = sheet_(TX_SHEET);
  const rows = values_(sheet);

  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) === id && String(rows[i][1]) === auth.userId) {
      sheet.deleteRow(i + 1);
      return json_({ ok: true });
    }
  }

  return json_({ ok: true });
}

function auth_(body) {
  const userId = String(body.user_id || "");
  const token = String(body.token || "");
  if (!userId || !token) return { ok: false, error: "Sesión no válida." };

  const rows = values_(sheet_(USERS_SHEET));
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId &&
        String(rows[i][4]) === token &&
        String(rows[i][5]).toLowerCase() !== "false") {
      return { ok: true, userId: userId };
    }
  }

  return { ok: false, error: "Sesión no válida." };
}

function sheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("No existe la hoja " + name + ". Ejecuta setupDatabase().");
  return sheet;
}

function values_(sheet) {
  if (sheet.getLastRow() === 0) return [];
  return sheet.getDataRange().getValues();
}

function normalizeEmail_(email) {
  return String(email || "").trim().toLowerCase();
}

function hash_(value) {
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

function token_() {
  return Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
