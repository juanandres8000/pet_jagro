-- Vistas del P&G: saldo por cuenta y encabezado mensual.
--
-- NATURALEZA DE LAS CUENTAS (no re-descubrir):
--   clase 4 (INGRESOS)          → saldo = créditos - débitos
--   clases 5 (GASTOS) y 6 (COSTOS) → saldo = débitos - créditos
-- Las clases 7, 8 y 9 NO EXISTEN en este plan: es una comercializadora, sin
-- costos de producción ni cuentas de orden. Verificado sobre las 801 del PCGA.
--
-- `periodo <> 13` excluye el CIERRE ANUAL, que viene idéntico a diciembre y lo
-- duplicaría (medido en 2025: periodo 13 = periodo 12, 2.791 filas iguales).
--
-- Idempotente (CREATE OR REPLACE). DDL por sesión (5432), no por el pooler.

CREATE OR REPLACE VIEW pyg_saldo_cuenta AS
SELECT m.mes,
       m.cuenta,
       COALESCE(c.descripcion, '(fuera del plan)') AS descripcion,
       left(m.cuenta, 1) AS clase,
       left(m.cuenta, 2) AS grupo,
       left(m.cuenta, 4) AS cuenta4,
       left(m.cuenta, 6) AS subcuenta,
       SUM(m.debito)  AS debitos,
       SUM(m.credito) AS creditos,
       CASE WHEN left(m.cuenta, 1) = '4'
            THEN SUM(m.credito) - SUM(m.debito)
            ELSE SUM(m.debito)  - SUM(m.credito)
       END AS saldo,
       COUNT(*)::int AS lineas
  FROM pyg_movimiento m
  LEFT JOIN pyg_cuenta c ON c.cuenta = m.cuenta
 WHERE m.periodo <> 13
   AND m.cuenta <> ''            -- líneas sin cuenta: se conservan en la tabla, no agregan
 GROUP BY m.mes, m.cuenta, c.descripcion;

CREATE OR REPLACE VIEW pyg_mensual AS
WITH base AS (
  SELECT mes,
    -- El SUM sobre todo el grupo 41 YA ES el neto de devoluciones y descuentos:
    -- el 4175 tiene naturaleza débito y entra en negativo. Se abren igual para
    -- que el reporte pueda mostrar bruto y deducciones por separado.
    COALESCE(SUM(saldo) FILTER (WHERE cuenta4 = '4135'), 0) AS ventas_brutas,
    COALESCE(SUM(saldo) FILTER (WHERE cuenta4 = '4175'), 0) AS devoluciones_descuentos,
    COALESCE(SUM(saldo) FILTER (WHERE grupo   = '41'),   0) AS ing_operacional_neto,
    COALESCE(SUM(saldo) FILTER (WHERE grupo   = '42'),   0) AS ing_no_operacional,
    COALESCE(SUM(saldo) FILTER (WHERE cuenta4 = '6135'), 0) AS costo_contable,
    COALESCE(SUM(saldo) FILTER (WHERE grupo   = '51'),   0) AS gasto_admon,
    COALESCE(SUM(saldo) FILTER (WHERE grupo   = '52'),   0) AS gasto_ventas,
    COALESCE(SUM(saldo) FILTER (WHERE grupo   = '53'),   0) AS gasto_no_operacional,
    COALESCE(SUM(saldo) FILTER (WHERE clase   = '5'),    0) AS gasto_total,
    COALESCE(SUM(debitos),  0) AS debitos_mes,
    COALESCE(SUM(creditos), 0) AS creditos_mes
  FROM pyg_saldo_cuenta
  GROUP BY mes
)
SELECT b.mes,
       b.ventas_brutas,
       b.devoluciones_descuentos,
       b.ing_operacional_neto,
       b.ing_no_operacional,
       b.ing_operacional_neto + b.ing_no_operacional AS ingresos_totales,
       b.costo_contable,
       -- FALLBACK DE COSTO: si el asiento de la 6135 del mes está en cero, se usa
       -- el costo del Gerencial (hgi_ventas_mensual). Medido en 2026: sólo abril
       -- está valorizado; mayo, junio y julio traen el asiento COSTO DE VENTA
       -- creado (comprobante 27, docs 77/78/79) con débito 0.
       CASE WHEN b.costo_contable <> 0 THEN b.costo_contable
            ELSE COALESCE(v.costo, 0) END AS costo,
       (b.costo_contable = 0 AND COALESCE(v.costo, 0) <> 0) AS costo_es_fallback,
       b.gasto_admon,
       b.gasto_ventas,
       b.gasto_no_operacional,
       b.gasto_total,
       b.ing_operacional_neto
         - CASE WHEN b.costo_contable <> 0 THEN b.costo_contable ELSE COALESCE(v.costo, 0) END
         AS utilidad_bruta,
       b.ing_operacional_neto + b.ing_no_operacional
         - CASE WHEN b.costo_contable <> 0 THEN b.costo_contable ELSE COALESCE(v.costo, 0) END
         - b.gasto_total AS resultado,
       b.debitos_mes,
       b.creditos_mes,
       (b.debitos_mes = b.creditos_mes) AS cuadra_partida_doble
  FROM base b
  LEFT JOIN hgi_ventas_mensual v ON v.mes = b.mes;
