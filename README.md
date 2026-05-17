# Token Pulse

Token Pulse es un dashboard web minimalista para ver el uso de tokens y costo de **Codex/OpenAI** y **Claude/Anthropic** desde una sola pantalla.

## Qué incluye

- Interfaz responsive para escritorio y móvil.
- Backend proxy en Node.js nativo para no llamar APIs administrativas directamente desde el navegador.
- Registro de claves desde la UI o por variables de entorno.
- Actualización automática cada 60 segundos.
- Datos demo cuando no hay credenciales reales o cuando una API devuelve error.
- Desglose por proveedor, tokens de entrada/salida/cache, costo y modelos.

## Ejecutar

```bash
npm run dev
```

Abre `http://localhost:8787`. No requiere dependencias externas para arrancar.

## Conectar uso real

Puedes pulsar **Registrar** en la UI o configurar variables de entorno antes de iniciar:

```bash
OPENAI_ADMIN_KEY="sk-..." \
OPENAI_ORG_ID="org_..." \
ANTHROPIC_ADMIN_KEY="sk-ant-admin..." \
npm run dev
```

Notas importantes:

- OpenAI se consulta mediante `GET /v1/organization/usage/completions` y, cuando está disponible, `GET /v1/organization/costs`.
- Anthropic se consulta mediante `GET /v1/organizations/usage_report/messages` y, cuando está disponible, `GET /v1/organizations/cost_report`.
- Anthropic indica que su Admin API no está disponible para cuentas individuales; requiere organización y clave admin.
- En este prototipo las claves registradas en la UI viven solo en memoria del proceso local. Para producción se debe añadir OAuth/SSO, cifrado persistente y un secret manager.

## Próximos pasos recomendados

1. Añadir autenticación multiusuario.
2. Persistir conexiones cifradas por usuario.
3. Empaquetar como app de escritorio con Tauri o Electron apuntando al mismo frontend.
4. Añadir alertas por presupuesto y exportación CSV.
