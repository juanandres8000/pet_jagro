# Pet Jagro - Sistema de Picking

## Resumen
Sistema de gestión de picking y distribución para productos veterinarios. Demo funcional para presentación comercial.

## Stack
- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- Vercel AI SDK v5 + OpenAI GPT-4o
- Neon PostgreSQL (feedback)
- Deploy: Vercel

## Archivos Clave
- `app/api/chat/route.ts` → API del chat AI con OpenAI
- `app/api/feedback/route.ts` → API de feedback (GET/POST)
- `components/ChatWidget.tsx` → Widget de chat con useChat hook
- `lib/mockData.ts` → Datos simulados (orders, products, deliveries)
- `lib/db.ts` → Conexión lazy a Neon PostgreSQL
- `app/globals.css` → Tema azul pastel

## Módulos
Nav agrupado en 3 secciones (`MENU_GROUPS` en `app/page.tsx`):
- **OPERACIÓN**: Picking, Inventario, Catálogo
- **COMERCIAL**: Clientes
- **FINANZAS**: Cartera

Más el **Chat AI** (widget flotante, GPT-4o).

Inventario y Catálogo son dos lecturas de la misma fuente (`/api/productos`) vía
el hook compartido `lib/hooks/useProductos.ts`. Sustituyeron a la antigua
Trazabilidad, que mezclaba ambas.

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

## Chat AI
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
- Se guarda en Neon PostgreSQL tabla `chat_feedback`
- API `/api/feedback`:
  - `POST`: guarda feedback (messageId, userMessage, assistantResponse, rating)
  - `GET`: lista últimos 50 feedbacks
  - `GET ?type=stats`: retorna {upvotes, downvotes, total}

### Widget de Stats
- Muestra "✨ X% útil" en el header del chat
- Solo visible si hay al menos 1 feedback
- Se actualiza al dar feedback
- Tooltip muestra total de valoraciones

## Base de Datos (Neon PostgreSQL)
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

## Variables de Entorno
```
OPEN_AI_KEY=sk-proj-...
DATABASE_URL=postgresql://...@...neon.tech/...
```
**Notas:**
- `OPEN_AI_KEY` usa guión bajo, no `OPENAI_API_KEY`
- `DATABASE_URL` es la connection string de Neon PostgreSQL

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

Nota: Tailwind purga clases construidas por interpolación — usa mapas de clases
literales (ver `ALIGN` en `components/ui/index.tsx`), nunca `` `text-${align}` ``.

## URLs
- Producción: https://pet-jagro.vercel.app
- Repo: https://github.com/intelguy8000/pet_jagro

## Notas
- **Política: sólo data real de HGINet, cero mock visible.** Picking, Inventario,
  Catálogo, Clientes y Cartera leen de HGINet con caché read-through en Neon.
- `lib/mockData.ts` sigue existiendo pero ya no alimenta ninguna vista.
  **Pendiente**: `app/api/chat/route.ts` y `lib/ai-functions.ts` todavía importan
  de él, así que el Chat AI responde sobre datos mock.
- Feedback sí usa BD real (Neon PostgreSQL)
- System prompt está en `app/api/chat/route.ts`
- AI SDK v5 requiere `@ai-sdk/react` separado para hooks de React
- La tabla `chat_feedback` se crea automáticamente si no existe

## Pendientes Futuro
- Base de datos real para pedidos/productos (Supabase)
- Autenticación usuarios
- Socket.io tiempo real
- CRUD desde chat
- App móvil mensajeros
