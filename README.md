# Finance V2

PWA de finanzas personales optimizada para Android.

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

La hoja `Usuarios` tiene:

| user_id | email | nombre | pin_hash | access_token | activo |
|---|---|---|---|---|---|
| U001 | correo1 | Usuario 1 | hash | token | TRUE |
| U002 | correo2 | Usuario 2 | hash | token | TRUE |
| U003 | correo3 | Usuario 3 | hash | token | TRUE |

La aplicación nunca envía el PIN a Google Sheets como texto plano: Apps Script compara su hash SHA-256.

### Movimientos

La hoja `Movimientos` tiene:

| id | user_id | type | amount | category | note | occurred_at | created_at |
|---|---|---|---:|---|---|---|---|

Esto permite que los tres usuarios compartan el mismo archivo sin mezclar sus movimientos.

## Importante sobre seguridad

El Google Sheet debe permanecer privado. El Web App de Apps Script es el que accede a la hoja. La API valida el usuario y un token de sesión antes de leer o escribir movimientos.

El correo por sí solo no se usa como autenticación, porque cualquiera que conozca un correo podría hacerse pasar por ese usuario. Por eso la versión actual utiliza correo + PIN de 6 dígitos.

## Despliegue de la PWA

El repositorio está preparado para un hosting HTTPS como Vercel. Una vez desplegado, abre la URL desde Chrome en Android y selecciona **Instalar aplicación** / **Añadir a pantalla de inicio**.
