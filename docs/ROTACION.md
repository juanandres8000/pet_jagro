# Rotación de inventario

Menú **Compras → Rotación de inventario** (`/rotacion`). Pedido de Jotagro (nov-2026):
el informe "ROTACIÓN DE INVENTARIOS" de HGI (inicial, entradas, salidas, final, días
en inventario), por proveedor, para comprar bien.

## Qué muestra
Por producto y por proveedor, para el periodo y la bodega elegidos:

| Dato | Cálculo |
|---|---|
| Inicial / Final | hacia atrás desde la existencia de HGI: `final = existencia − neto(posterior al periodo)`, `inicial = final − neto(periodo)` |
| Entradas | compras (40, 45, 03, 36) + traslados de entrada (12, 57) + devoluciones de clientes (notas crédito) + ajustes, bonificados, préstamos (13, 33, 38, 16) |
| Salidas | ventas (04, 43, 41, 62, 50, 59, 66…) + traslados de salida (11, 56) + ajustes, préstamos, deterioro, bonificados, devolución a proveedor (14, 39, 29, 32, 05) |
| Días en inventario | `(inicial + final) / 2 ÷ salidas × días del periodo` |
| Rotación | `salidas ÷ inventario promedio` (veces en el periodo) |
| Existencia, cobertura, sugerido, estado | de la **empresa** (todas las bodegas, ver abajo). Cobertura = `existencia ÷ venta diaria`; venta diaria = (ventas − devoluciones) ÷ días del periodo; sugerido = `venta diaria × días elegidos − existencia` |
| Estados | agotado (se vende y hoy no hay), por agotarse (< 15 días), sobrestock (> 120 días), sin movimiento (hay existencia y no salió nada) |
| Proveedor | días ponderados por costo: `Σ(promedio·costo) ÷ Σ(salidas·costo) × días` |

Rotación = de la bodega elegida (igual al informe de HGI). **Compras = de la empresa**:
en oct-2026 Jotagro estrenó la bodega 03 (Insumos) y pasó allá los insumos de la 01;
mirando sólo la 01, 20 mil jeringas salían "agotadas" y con sugerido de compra.
Con "Todas las bodegas" los traslados entre bodegas no cuentan (se anulan).

Unidades. Pesos sólo para valor de existencia y sugerido: existencia × costo unitario
promedio ponderado de los lotes con saldo positivo (costo de HGI de hoy).

## Validación (6-nov-2026)
Contra el informe de HGI que mandó Jotagro (bodega 01, 1-may a 30-sep-2026, 2.256
productos), pasando por la ingesta real del módulo:
- **Entradas y salidas: 2.256 / 2.256 idénticas** (totales 600.390 y 578.105).
- Inicial/final: 2.246 / 2.256. Las 10 diferencias son TODAS de la factura de compra
  **40-11883 de JVU (30-oct-2026)**: está en los movimientos de HGI pero no en el saldo
  de inventario (¿sin contabilizar?). Los otros 2 finales distintos son filas donde el
  propio Excel no cumple inicial + entradas − salidas = final.

## Trampas de HGINet (resueltas en `lib/hgi/rotacion/mappers.ts`)
1. **El signo de `CantidadDocumento` no da la dirección.** La 12 (entrada por traslado)
   y las notas crédito 06/51 vienen negativas; deterioro (29) y bonificados (32)
   positivas. La dirección la da el código (`TRANSACCIONES`).
2. **Correcciones dentro del documento**: traslado 3625 trae −12, −3, +6, −9. HGI las
   neta; por eso se suma con signo dentro del grupo de la transacción.
3. Traslados = dos documentos: 11 sale de la bodega origen, 12 entra a la destino
   (remisiones: 56 → 57 a la bodega 0 "TEMPORAL REM").
4. Ventas y notas llegan con `tipo_documento=1, '*'`; el resto con `tipo_documento=0` y
   código explícito (con `*` HGI devuelve pedidos).
5. Comodines fuera: código 0 y 999999983–999999999 (uno tuvo 73 mil "salidas"). HGI sí
   incluye 999999980/981 ("PRODUCTO IVA 19/5"), así que se dejan.
6. Un código nuevo que no esté en `TRANSACCIONES` ni en `SIN_INVENTARIO` (ingest.ts)
   hace FALLAR la ventana a propósito: cuadrar mal en silencio es peor.
7. Token de HGI vencido = `400` con cuerpo vacío (no sólo 401).

## Datos y cron
Migración `014_rotacion.sql` (RLS): `rot_movimiento` (mes × bodega × producto, por
grupo), `rot_saldo` (foto de existencias), `rot_producto` (nombre y proveedor),
`rot_ventana_control`. Cron `?dataset=rotacion` a las :02 y :32: ventanas mensuales
(mismo `elegirVentanas` de descuentos; ~1 mes por corrida, 60–110 s), y tras refrescar
el mes en curso toma la existencia (para que saldo y movimiento sean de la misma hora).
El mes en curso se refresca cada 6 h. Histórico desde `2026-01`.

Un periodo sólo muestra cifras si están TODOS los meses desde su inicio hasta hoy (y
hay foto de existencias); si no, la vista dice qué falta.

## Operación
- Migración: `migrations/014_rotacion.sql` por el puerto 5432 (igual que la 012).
- Forzar un mes: `/api/hgi/refresh?dataset=rotacion&mes=YYYY-MM` (con CRON_SECRET).
- API: `GET /api/rotacion?desde=YYYY-MM&hasta=YYYY-MM&bodega=01|02|03|0|todas&dias=15|30|45|60|90`
  y `/api/rotacion/reporte` (mismos parámetros + `&proveedor=NIT`) → .xlsx.
- Tests: `npm test` (tests/rotacion.test.ts).

## Si Jotagro pide cambios (decisiones tomadas sin preguntarles)
- Fórmula de días: inventario promedio ÷ salidas × días. Alternativa: final ÷ salida diaria.
- Umbrales 15 / 120 días: `UMBRAL_POR_AGOTARSE` / `UMBRAL_SOBRESTOCK` en mappers.ts.
- Sugerido sobre ventas netas (no sobre todas las salidas) y sin stock de seguridad ni
  pedidos en tránsito (órdenes de compra 07 no se leen).
- Días objetivo: 15/30/45/60/90 (`DIAS_OBJETIVO` en consulta.ts).
- Compras a nivel empresa; rotación por bodega (default bodega 01).
