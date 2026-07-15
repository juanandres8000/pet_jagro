/** Formato de dinero (COP). Único punto de verdad para vistas y KPIs. */

const MIL_MILLONES = 1_000_000_000;
const UN_MILLON = 1_000_000;

/** Valor completo: "$ 15.357.123.401". Es lo que usan tablas y celdas. */
export const formatPrice = (value: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

/** A partir de mil millones el valor completo no cabe en una KPI card. */
const esGrande = (value: number) => Math.abs(value) >= MIL_MILLONES;

/** Compacto a millones sin decimales: "$ 15.357 M". Por debajo del umbral, completo. */
export const formatCompactPrice = (value: number) =>
  esGrande(value)
    ? `$ ${new Intl.NumberFormat('es-CO').format(Math.round(value / UN_MILLON))} M`
    : formatPrice(value);

/**
 * Valor + tooltip para una KPI card: compacta sólo si no cabría, y en ese caso
 * deja el valor completo en `title`. Pensado para esparcirse en <KpiCard>:
 *   <KpiCard label="Total abierto" {...kpiMoney(total)} />
 */
export function kpiMoney(value: number): { value: string; title?: string } {
  return esGrande(value)
    ? { value: formatCompactPrice(value), title: formatPrice(value) }
    : { value: formatPrice(value) };
}
