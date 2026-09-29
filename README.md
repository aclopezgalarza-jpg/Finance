# Finance V2

PWA de finanzas personales optimizada para Android.

<!-- Trigger APK rebuild after Finance V3 updates -->

## Backend actual

La aplicación ya no usa Supabase.

La arquitectura actual es:

```
Android PWA
    ↓
Google Apps Script Web App
    ↓
Google Sheets
```

Un único Google Sheet puede almacenar los movimientos de los 3 usuarios. Cada movimiento lleva un `user_id`, y el backend filtra los datos por usuario.

## Funciones

- Instalación como PWA.
- Dashboard mensual.
- Registro de ingresos, gastos y ahorros.
- Categorías y movimientos recientes.
- Estadísticas básicas.
- Persistencia local.
- Cola de sincronización cuando no hay conexión.
- Sincronización con un único Google Sheet.
- Tres cuentas de usuario independientes.

## Configuración de Google Sheets

1. Crea un Google Sheet para Finance.
2. Abre **Extensiones → Apps Script**.
3. Copia el contenido de `apps-script/Code.gs`.
4. En `SPREADSHEET_ID`, coloca el ID del Google Sheet.
5. Ejecuta `setupDatabase()` una vez y concede los permisos.
6. En la pestaña `Usuarios`, completa los 3 correos autorizados.
7. Cambia los PIN iniciales por PIN de 6 dígitos.
8. Copia la URL de despliegue que termina en `/exec`.
9. Pega esa URL en `google-config.js`.
10. Despliega Apps Script como **Web app**, ejecutando como propietario y permitiendo acceso a los usuarios necesarios.

### Usuarios

La hoja `Usuarios` conserva compatibilidad con las columnas antiguas y añade campos de seguridad:

| user_id | email | nombre | pin_hash | access_token | activo | pin_salt | pin_hash_v2 | session_token_hash | session_expires_at | failed_attempts | locked_until | session_created_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U001 | correo1 | Usuario 1 | legacy | vacío | TRUE | salt | hash HMAC | hash HMAC | fecha | 0 | vacío | fecha |

El PIN nunca se guarda en texto plano. En el primer login correcto, el hash antiguo se migra a un hash HMAC-SHA-256 con salt y una clave privada almacenada en `Script Properties`. Apps Script ofrece `PropertiesService` para guardar configuración compartida del proyecto. citeturn0search0turn2search0

Los tokens de sesión ya no se guardan en texto plano: se almacena únicamente su HMAC. Cada login genera un token nuevo y la sesión expira después de 30 días.

### Movimientos

La hoja `Movimientos` tiene:

| id | user_id | type | amount | category | note | occurred_at | created_at |
|---|---|---|---:|---|---|---|---|
| | | | | | | | |

Esto permite que los tres usuarios compartan el mismo archivo sin mezclar sus movimientos.

## Seguridad y migración

El Google Sheet debe permanecer privado. El Web App de Apps Script es el que accede a la hoja y se ejecuta bajo la identidad del propietario; Google documenta que esa elección determina qué datos puede acceder el Web App. citeturn0search1turn0search4

La versión endurecida añade:

- Tokens de sesión aleatorios, almacenados solo como HMAC.
- Expiración de sesión a 30 días.
- Rotación del token en cada login.
- Revocación real mediante `logout`.
- Límite de 5 intentos fallidos y bloqueo temporal de 15 minutos.
- Mensaje genérico de login para reducir enumeración de usuarios.
- Migración automática de los hashes antiguos de PIN al primer login correcto.
- Validación de tipo, monto, fechas, categorías y notas.
- Protección frente a fórmulas introducidas como texto en Google Sheets.
- Comprobación de autorización por `user_id` para listar, modificar y eliminar movimientos.
- `LockService` alrededor de escrituras sensibles para evitar carreras entre solicitudes concurrentes.

Apps Script tiene cuotas y límites propios, por lo que el rate-limit de la aplicación es una capa adicional y no debe confundirse con las cuotas generales de Google. citeturn0search2

### Migración

No vuelvas a ejecutar una versión antigua de `setupDatabase()`: la versión actual es idempotente y **no borra los movimientos existentes**.

Después de actualizar `Code.gs`:

1. Abre Apps Script.
2. Reemplaza `Code.gs` por la versión del repositorio.
3. Ejecuta `setupDatabase()` una vez.
4. Autoriza el proyecto si Google lo solicita.
5. Vuelve a implementar el Web App como nueva versión del despliegue.
6. Abre la APK/PWA e inicia sesión nuevamente.
7. El primer login correcto migra automáticamente el PIN al formato endurecido.

El secreto del servidor se genera y guarda en `Script Properties`; no debe copiarse al frontend ni al repositorio. citeturn0search0

## Despliegue de la PWA

El repositorio está preparado para un hosting HTTPS como Vercel. Una vez desplegado, abre la URL desde Chrome en Android y selecciona **Instalar aplicación** / **Añadir a pantalla de inicio**.
