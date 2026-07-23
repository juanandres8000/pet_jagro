# Pet Jagro - Sistema de Picking

## Resumen
Sistema de gestión de picking y distribución para productos veterinarios. Demo funcional para presentación comercial.

## Stack
- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- Vercel AI SDK v5 + OpenAI GPT-4o
- Supabase PostgreSQL (feedback, token de HGINet, snapshots) vía `postgres.js`
- Deploy: Vercel

## Archivos Clave
- `app/api/chat/route.ts` → API del chat AI con OpenAI
- `app/api/feedback/route.ts` → API de feedback (GET/POST)
- `components/ChatWidget.tsx` → Widget de chat con useChat hook
- `lib/mockData.ts` → Datos simulados (orders, products, deliveries)
- `lib/pg.ts` → Cliente Postgres compartido (postgres.js). **Único punto de conexión**
- `lib/db.ts` → Conexión lazy; delega en `lib/pg.ts`
- `app/globals.css` → Tema azul pastel

## Módulos
Nav agrupado en 3 secciones (`MENU_GROUPS` en `app/page.tsx`):
- **OPERACIÓN**: Picking, Inventario, Catálogo
- **COMERCIAL**: Clientes
- **FINANZAS**: Cartera

El **Chat AI** existe pero está **oculto** — ver "Chat AI" más abajo.

Inventario y Catálogo son dos lecturas de la misma fuente (`/api/productos`) vía
el hook compartido `lib/hooks/useProductos.ts`. Sustituyeron a la antigua
Trazabilidad, que mezclaba ambas.

**Comodines del ERP**: `mapProductos` (`lib/hgi/mappers/productos.ts`) descarta
los códigos de `CODIGOS_COMODIN` — hoy sólo el `0` ("GENERAL"), un cajón de
sastre de HGINet que no es un producto real. Es el punto único que alimenta el
snapshot de catálogo, así que filtrar ahí cubre Inventario y Catálogo a la vez.
Ojo: el filtro corre al **construir** el snapshot, no al leerlo — el catálogo
cacheado en Supabase sigue trayendo GENERAL hasta el siguiente rebuild (TTL de
`HGI_CATALOG_TTL_MIN`, 15 min por defecto, o el cron de prewarm).

### Módulos retirados
Facturación, Liquidaciones y Trazabilidad se retiraron del producto. No tienen
entrada de nav ni rama de render, así que son inalcanzables. La app es una SPA
con estado de tab en `app/page.tsx` — no hay rutas de archivo que proteger.
Integraciones también salió del nav.

Como Facturación ya no existe, **`completed` es el estado terminal del picking**:
no hay transición a `ready_for_billing`. El Picking lista
`in_progress → pending → completed → ready_for_billing` (`PICKING_STATUSES` en
`PickingView`) para que ningún pedido desaparezca de la vista sin destino;
`ready_for_billing` se conserva sólo como lectura de estados heredados.

## Chat AI — OCULTO INTENCIONALMENTE

**No se renderiza.** `app/page.tsx` ya no monta `<ChatWidget />`, así que el
botón flotante no existe en el UI.

**Por qué**: el chat responde sobre `lib/mockData.ts` — `app/api/chat/route.ts`
y `lib/ai-functions.ts` importan de ahí. Con los 5 módulos ya sobre data real de
HGINet, era lo único que quedaba contradiciendo la política de **cero mock
visible**: un asistente inventando pedidos y stock junto a tablas con cifras
reales es peor que no tener asistente. Se oculta en vez de borrarse porque la
migración a data real está planeada para el próximo sprint.

**La ruta también está cerrada**: `/api/chat` responde **503** con
`{ ok: false, mensaje: 'Chat deshabilitado temporalmente' }` sin invocar GPT-4o.
Quitar el widget sólo quitaba la UI; el endpoint seguía siendo público y
cualquiera podía gastar tokens para recibir datos inventados. El guard corre
antes de leer el body, así que no se consume nada.

**Nada se borró**: `components/ChatWidget.tsx`, `app/api/chat/route.ts` y
`lib/ai-functions.ts` siguen en el repo y compilan. El handler original está
íntegro debajo del guard.

**Para reactivarlo** (sprint de migración), en este orden:
1. Migrar `lib/ai-functions.ts` y el system prompt a HGINet — si no, el mock
   vuelve a la pantalla.
2. `CHAT_ENABLED=true` en el entorno (Vercel). Sin la variable la ruta está
   apagada: el default es 503, no hace falta tocar nada para mantenerlo off.
3. Volver a montar `<ChatWidget />` en `app/page.tsx`.

Detalle a limpiar en esa migración: el quick chip "¿Pedidos para zona Norte?"
(`ChatWidget.tsx`) asume zonas que HGINet no trae — ver "Zonas de entrega".

### Implementación (para el sprint de migración)
- Hook `useChat` de `@ai-sdk/react`
- Transport: `DefaultChatTransport` con api `/api/chat`
- API en `/api/chat/route.ts`
- Modelo: `gpt-4o`
- Usa `convertToModelMessages` para convertir UIMessage[] a ModelMessage[]
- Respuesta: `toUIMessageStreamResponse()`
- Recibe contexto de mockData (orders, products, deliveries)
- Capacidades: búsqueda por ID parcial, cliente, zona, mensajero, stock bajo, liquidaciones

### Quick Chips (Sugerencias)
- Aparecen cuando el chat está vacío
- 5 sugerencias predefinidas con iconos
- Click envía la pregunta directamente
- Definidas en array `suggestions` en ChatWidget.tsx

### Feedback System
- Botones 👍👎 debajo de cada respuesta del asistente
- Se guarda en Supabase PostgreSQL tabla `chat_feedback`
- API `/api/feedback`:
  - `POST`: guarda feedback (messageId, userMessage, assistantResponse, rating)
  - `GET`: lista últimos 50 feedbacks
  - `GET ?type=stats`: retorna {upvotes, downvotes, total}

### Widget de Stats
- Muestra "✨ X% útil" en el header del chat
- Solo visible si hay al menos 1 feedback
- Se actualiza al dar feedback
- Tooltip muestra total de valoraciones

## Base de Datos (Supabase PostgreSQL)

Proyecto Supabase `pet-jagro` (ref `fxsbraeqgxlcdlpwtgdr`, región `us-east-1`,
PG 17). Migró desde Neon; **Neon quedó abandonado, no se toca**.

### Driver: postgres.js, no @neondatabase/serverless
`lib/pg.ts` es el **único punto de conexión** — `getSql()` memoizado a nivel de
módulo. El resto (`lib/db.ts`, `lib/hgi/tokenStore.ts`, `lib/hgi/snapshotStore.ts`,
`app/api/feedback/route.ts`) lo importa. La interfaz es la misma que la de
`neon()`: tagged template que devuelve un array de filas.

Tres cosas que **no** son cosméticas y no deben tocarse:

- **El memo es obligatorio.** `neon()` hablaba HTTP y era stateless: crear un
  cliente por llamada salía gratis. postgres.js abre TCP — un pool por
  invocación agota el pooler. Un cliente por lambda (`max: 1`).
- **`prepare: false` es obligatorio.** El pooler de Supabase en modo
  *transaction* (6543) no soporta prepared statements. Sin esto los queries
  revientan con `prepared statement ... already exists`.
- **`timestamptz` llega como `Date`**, no como string (Neon devolvía string).
  `new Date(...)` traga ambos, pero los tipos en `tokenStore`/`snapshotStore`
  dicen `string | Date` a propósito.

Ya no hace falta `fetchOptions: { cache: 'no-store' }`: existía porque el driver
de Neon iba por `fetch` y Next.js cachea `fetch` por defecto. Sobre TCP no aplica.

Cualquier ruta que toque la BD debe declarar `export const runtime = 'nodejs'`
— postgres.js abre TCP y no corre en edge.

**Trampa al comentar queries**: un `//` dentro de un `` sql`...` `` viaja como
texto a Postgres y da `syntax error`. `tsc` y `next build` no lo detectan (es
texto dentro de un string). Los comentarios van **arriba** del template.

### Tablas
`hgi_token` (001), `hgi_catalog_snapshot` (002, huérfana desde la 003),
`hgi_snapshot` (003), y `chat_feedback` (init-on-use, sin migración):

```sql
CREATE TABLE chat_feedback (
  id SERIAL PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_message TEXT,
  assistant_response TEXT,
  rating TEXT CHECK (rating IN ('up', 'down')),
  created_at TIMESTAMP DEFAULT NOW()
);
```
- Conexión lazy en `lib/db.ts` para evitar errores en build
- Las migraciones son idempotentes (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`)

## Variables de Entorno
```
OPEN_AI_KEY=sk-proj-...
DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```
**Notas:**
- `OPEN_AI_KEY` usa guión bajo, no `OPENAI_API_KEY`
- `DATABASE_URL` es la connection string de Supabase. **Usa siempre el pooler**,
  no el host directo. Dos detalles que el dashboard hace fácil equivocar:
  - **Host**: `aws-0-us-east-1.pooler.supabase.com`. El host directo
    (`db.<PROJECT_REF>.supabase.co`) es **IPv6-only** y las lambdas de Vercel
    tienen egress IPv4 → no resuelve. Ojo: es `aws-0`, no `aws-1`
    (`aws-1` responde `tenant/user not found`).
  - **Usuario**: `postgres.<PROJECT_REF>`, no `postgres` a secas. El pooler
    (Supavisor) enruta por el tenant que va en el usuario.
  - **Puertos**: `6543` = transaction mode → es el que usan la app y Vercel.
    `5432` sobre el mismo host = session mode → úsalo para migraciones (DDL
    multi-sentencia).
  - Si la contraseña trae `@ : / ?`, URL-encódala.
- `CHAT_ENABLED` apaga/enciende `/api/chat`. **Sin definir = apagado (503)**,
  que es el estado actual a propósito (ver "Chat AI"). Sólo `CHAT_ENABLED=true`
  la reactiva.
- Las credenciales de HGINet (`HGI_BASE_URL`, `HGI_USUARIO`, `HGI_CLAVE`,
  `HGI_COD_COMPANIA`, `HGI_COD_EMPRESA`) viven **sólo en Vercel**. En local
  `.env.local` suele tener nada más `DATABASE_URL`, así que las vistas leen del
  snapshot de Supabase que puebla el cron: los rebuilds contra HGINet no se pueden
  ejercitar localmente.

## Tema Visual
Estilo editorial/corporativo sobrio. **Un solo acento: verde oscuro.** El azul
pastel anterior (`#7CB9E8`) se eliminó por completo.

Tokens en `tailwind.config.ts` (espejados como CSS vars en `app/globals.css`).
**Usa las clases de Tailwind — no metas hex sueltos en componentes.**

| Token | Hex | Uso |
|---|---|---|
| `cream` | `#FAF8F5` | Fondo de la app |
| `surface` | `#FFFFFF` | Cards, tablas, sidebar |
| `surface-hover` | `#F5F2EC` | Hover de fila / de botón |
| `surface-muted` | `#F3F0EA` | Headers de tabla, paneles, tracks de barras |
| `line` | `#E8E4DD` | Bordes y divisores |
| `ink` | `#1A1A18` | Texto principal |
| `ink-muted` | `#6B6860` | Texto secundario |
| `ink-faint` | `#9A968C` | Texto terciario |
| `accent` | `#1E4D3B` | Activo, links, botones primarios, KPIs |
| `warn` | `#8A6A2F` | Alertas medias (ámbar apagado) |
| `danger` | `#8C3A32` | Alertas severas (rojo apagado) |

Escala de superficies, de clara a oscura: `surface` (#FFFFFF) → `cream`
(#FAF8F5) → `surface-hover` (#F5F2EC) → `surface-muted` (#F3F0EA).
`surface-muted` es un paso más oscuro que `cream` a propósito, para que se lea
también sobre el fondo de la app; usa `surface-hover` para hovers, no `muted`.

### Zonas de entrega: retiradas de la UI
No hay badge de zona en ningún módulo. Las 6 `DeliveryZone` son herencia de la
era mock: los 145 pedidos de HGINet traen `zona.nombre = "GENERAL"`, que
`toDeliveryZone` (`lib/hgi/adapters/pedidoToOrder.ts`) no mapea, así que
`customer.zone` es siempre `undefined` con data real.

Lo que queda y por qué: el tipo `DeliveryZone` y los campos `customer.zone` /
`Messenger.assignedZone` siguen existiendo porque `lib/mockData.ts` y
`lib/ai-functions.ts` (chat AI) los leen. Cuando el chat migre a data real,
son candidatos a borrarse con ellos. El adaptador conserva el mapeo por si
HGINet algún día envía zonas de verdad; ahí se reintroduce la UI.

### Tipografía
- **Fraunces** (serif) → títulos de página y headings de sección: `font-serif`
- **Inter** (sans) → body, datos, tablas (default en `<body>`)
- Ambas vía `next/font/google` en `app/layout.tsx` (vars `--font-serif` / `--font-sans`)
- Cifras en KPIs y columnas numéricas: clase `.tabular` (tabular-nums), definida en `globals.css`

### Primitivos
`components/ui/index.tsx`: `PageHeader`, `SectionTitle`, `Card`, `KpiCard`,
`Badge` (prop `tone`: neutral/accent/warn/danger), `FilterButton`, `Button`,
`Th`, `EmptyState`. Úsalos en vez de re-estilar a mano.

### Dinero
`lib/format.ts` es el único punto de verdad. `formatPrice` para tablas y celdas
(valor completo). Para KPI cards usa `kpiMoney(v)` y espárcelo en la card:
`<KpiCard label="Total abierto" {...kpiMoney(total)} />` — a partir de mil
millones el valor no cabe y se compacta a millones (`$ 15.357 M`), dejando el
completo en el `title`. Por debajo del umbral devuelve el valor completo y no
pone tooltip.

Nota: Tailwind purga clases construidas por interpolación — usa mapas de clases
literales (ver `ALIGN` en `components/ui/index.tsx`), nunca `` `text-${align}` ``.

## URLs
- Producción: https://pet-jagro.vercel.app
- Repo: https://github.com/intelguy8000/pet_jagro

## Notas
- **Política: sólo data real de HGINet, cero mock visible.** Picking, Inventario,
  Catálogo, Clientes y Cartera leen de HGINet con caché read-through en Supabase.
- **Cero mock visible: cumplido.** `lib/mockData.ts` ya no alimenta nada que se
  renderice. Sus últimos consumidores son `app/api/chat/route.ts` y
  `lib/ai-functions.ts`, y por eso el Chat AI está oculto (ver "Chat AI").
  Cuando el chat migre a HGINet, `mockData.ts` queda sin consumidores y se puede
  borrar — junto con `DeliveryZone` / `customer.zone` / `Messenger.assignedZone`.
- Feedback sí usa BD real (Supabase PostgreSQL)
- System prompt está en `app/api/chat/route.ts`
- AI SDK v5 requiere `@ai-sdk/react` separado para hooks de React
- La tabla `chat_feedback` se crea automáticamente si no existe

## Pendientes Futuro
- Base de datos real para pedidos/productos (Supabase)
- Autenticación usuarios
- Socket.io tiempo real
- CRUD desde chat
- App móvil mensajeros
