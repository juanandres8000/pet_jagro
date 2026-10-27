# Descuentos diferenciados (precio cero)

Módulo del menú **Finanzas → Descuentos** (`/descuentos`). Separa el **precio cero**
(lo que Jotagro regala en factura) de lo que el **laboratorio le devuelve**, y genera
el reporte "PRECIO CERO <LAB> <periodo>" que antes se armaba a mano factura por factura.

## Por qué existe
Jotagro veía el margen del P&G golpeado por "descuentos", pero buena parte de esos
regalos los paga el laboratorio. En HGINet el regalo se registra a **costo pleno sin
ingreso** (no como descuento) y la compensación del laboratorio entra por otros
caminos (mercancía gratis en la compra, descuento en la factura de compra o descuento
al pagar, que acredita el **inventario** 1435). Nadie los cruzaba.

## Qué es cada cifra
| Cifra | Fuente | Regla |
|---|---|---|
| Precio cero | ventas `ObtenerDetalleReporte` tipo 1 | línea de factura con `ValorTotalDetalle = 0` y cantidad > 0 (las notas crédito no cuentan). Valor a `CostoTotal`; "a lista" = `ValorUnitario × cantidad` |
| Venta neta, costo, margen | mismas ventas | reglas de `lib/hgi/mappers/ventas.ts` (cuadra al peso con `hgi_ventas_mensual`) |
| Margen sin precio cero | — | (margen + costo precio cero) / venta neta |
| Mercancía gratis en compras | compras tipo 0, transacciones **40** y **45** | línea con valor 0, o con descuento ≥ valor; a `CostoTotal` |
| Entradas por bonificados | transacción **33** | `CostoTotal` |
| Descuento en factura de compra | 40/45 (líneas no gratis) | `ValorDescuentoDetalle` |
| Descuento al pagar | `pyg_movimiento`, cuenta **14352290**, crédito − débito por tercero | **sólo meses con P&G completo** (ventana mensual ok); si no, la vista dice "Sin dato" |
| Cobertura observada | — | (mercancía + desc. factura + desc. al pagar) / precio cero a costo |
| Brecha | — | max(0, precio cero − compensación observada) |
| Estado | — | Cubierto ≥ 95 %, Parcial, Sin compensación, Sin precio cero |

Los descuentos en compra pueden mezclar condiciones comerciales normales con la
compensación del precio cero; por eso la cobertura se llama **observada**.
El laboratorio de una línea es `NitProveedor` del producto; el descuento al pagar va
por **tercero** (a quién se le pagó), que casi siempre coincide.

Las transacciones 32 (salida por bonificados) y 05 (nota débito proveedores) se
guardan para auditoría y no suman.

## Validación (27-oct-2026, datos reales ago–sep 2026)
- Precio cero: 2.765 líneas, 6.374 und, $184.646.795 a costo.
- "PRECIO CERO CARVAL AGOSTO 16 AL 31" (Excel manual): 52/52 facturas y todas sus
  líneas idénticas al reporte generado. Pharmavet septiembre: 8/8 facturas.
- Venta, descuento y costo por mes = `hgi_ventas_mensual` al peso.
- Reingesta idempotente (mismo md5, 0 filas sustituidas).

## Arquitectura
```
cron horario  GET /api/hgi/refresh?dataset=descuentos   (CRON_SECRET)
  lib/hgi/descuentos/refresh.ts   cola de ventanas mensuales + presupuesto (80 % de 300 s)
  lib/hgi/descuentos/ingest.ts    HGINet → mappers → store (una transacción por ventana)
  lib/hgi/descuentos/mappers.ts   clasificación PURA (tests)
  lib/hgi/descuentos/store.ts     dd_linea, dd_venta_agregado, dd_ventana_control + lecturas
GET /api/descuentos?desde=YYYY-MM&hasta=YYYY-MM          (sesión)
GET /api/descuentos/reporte?nit=&desde=YYYY-MM-DD&hasta=  (sesión) → .xlsx
  lib/hgi/descuentos/resumen.ts   cálculos PUROS (tests)
  lib/xlsx.ts                     .xlsx sin dependencias, nunca escribe fórmulas
components/DescuentosView.tsx    vista
```

### Ingesta
- Ventana = **mes calendario completo** (también el mes en curso: la PK no cambia día a día).
- Ventas: 5 días por llamada (como `ventas.ts`). Compras: `tipo_documento=0` con
  `codigo_transaccion` **explícito** — con `*` HGINet no devuelve compras.
- Se guardan **todas** las líneas de las facturas que tienen algún precio cero (el
  reporte muestra la pagada junto a la regalada) y todas las de compras; del resto de
  ventas sólo el agregado por mes y laboratorio.
- Líneas con fecha fuera de la ventana se descartan (las trae la ventana de su mes).
- Una línea sin Id/fecha/documento hace fallar la ventana (no se guarda un mes incompleto).
- Sustitución por `(ventana, lote <> actual)`, nunca por fecha (mismo patrón que el P&G).
- ~40 s por mes.

### Qué ventana toca (`elegirVentanas`)
1. Meses vivos (el en curso, y el anterior hasta el día 15) si su último OK tiene > 6 h.
2. Ventanas en error con < 3 intentos.
3. Meses sin ingestar desde `MES_INICIAL` (2026-01), del más nuevo al más viejo.
Un mes cerrado con OK no se vuelve a pedir; para forzarlo: `?dataset=descuentos&mes=YYYY-MM`.
`ok_en` guarda la última ingesta exitosa: un refresco fallido no borra ni oculta los datos anteriores.

## Seguridad
- Tablas con RLS sin policies (como todo `public`). El store **no crea tablas**: si
  falta la migración, falla con mensaje claro (una tabla creada por código nacería sin RLS).
- Endpoints de lectura detrás de la sesión (middleware); el cron detrás de `CRON_SECRET`.
- Parámetros validados con regex estrictas (mes 01–12, fecha que existe, NIT numérico,
  rangos acotados). Consultas siempre parametrizadas.
- `.xlsx`: texto como `inlineStr` escapado; nunca `<f>` → sin inyección de fórmulas.
  Nombre de archivo saneado (sólo letras, números, espacio, punto y guión).
- HGINet: sólo GET. En local, nunca `/Api/Autenticar` (ver script).

## Operación
- **Migración**: `migrations/012_descuentos.sql` por el puerto 5432 (session mode), una vez:
  ```
  node -e "const p=require('postgres');const s=p(process.env.DATABASE_URL.replace(':6543/',':5432/'));s.unsafe(require('fs').readFileSync('migrations/012_descuentos.sql','utf8')).then(()=>s.end())"
  ```
- **Backfill desde local** (opcional; el cron lo hace solo, ~2 meses por corrida):
  `node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/descuentos-ingest.ts --desde=2026-01 --hasta=2026-10`
- **Tests**: `npm test` (lógica pura, sin red ni BD).
- **Ver el estado**: `SELECT * FROM dd_ventana_control ORDER BY ventana_desde;`
- **Retirar el módulo** sin perder nada del resto: quitar la entrada del menú y el cron;
  las tablas `dd_*` son independientes (`DROP TABLE dd_linea, dd_venta_agregado, dd_ventana_control`).

## Pendientes / preguntas para Jotagro
- Confirmar qué laboratorios reconocen el precio cero y por qué canal (hoy se infiere).
- Confirmar si reconocen a costo, a lista o un %. La vista muestra ambos valores.
- El P&G del dash no tiene agosto–octubre 2026 completos (sin ventana mensual): mientras
  tanto el descuento al pagar de esos meses sale "Sin dato". Se corrige reactivando el
  `pyg_backfill` del P&G para esos meses (módulo aparte).
- Valoración de la unidad gratis en el kárdex: HGINet trae `CostoTotal` pleno en la
  línea gratis de la compra; confirmar con el contador si el costo promedio la diluye.
