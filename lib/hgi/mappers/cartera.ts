/**
 * Mapper/agregador de Cartera (HGINet Api/Cartera/Obtener) → aging.
 *
 * El endpoint devuelve UN registro por documento/cuota de cartera. Aquí NO se
 * guardan los ~32k documentos crudos en el snapshot: se agregan a nivel de tercero
 * (data[] liviano para lookups) y se precalcula el resumen de aging (buckets, top
 * deudores) que consume la vista, evitando reenviar la data cruda en cada request.
 */

export interface HgiCarteraDoc {
  CodigoEmpresa?: number;
  Anyo?: number | string;
  Periodo?: number | string;
  Transaccion?: string;
  Documento?: number | string;
  CodigoTercero?: string;
  CodigoVendedor?: string;
  Cuota?: string;
  TipoCartera?: string;
  Fecha?: string;
  FechaVencimiento?: string;
  Edad?: number | string; // días de mora
  ValorDocumento?: number | string;
  SaldoFinal?: number | string; // saldo pendiente
  Intereses?: number | string;
  [key: string]: unknown;
}

/** Agregado por tercero (esto ES el snapshot data[]; sirve para lookups de saldo). */
export interface CarteraCliente {
  codigoTercero: string;
  saldoTotal: number; // suma SaldoFinal>0
  saldoVencido: number; // suma SaldoFinal de docs con Edad>0
  diasMaxMora: number; // máx Edad entre sus docs con saldo
  docsAbiertos: number;
}

export interface AgingBucket {
  docs: number;
  saldo: number;
}

export type BucketKey = 'alDia' | '0-30' | '31-60' | '61-90' | '90+';

export interface TopDeudor {
  codigoTercero: string;
  nombre: string;
  saldoTotal: number;
  saldoVencido: number;
  diasMaxMora: number;
}

/** Resumen de aging (se guarda en sourceCounts y lo sirve el endpoint tal cual). */
export interface CarteraResumen {
  totalAbierto: number; // suma SaldoFinal>0
  totalVencido: number; // suma SaldoFinal de docs con Edad>0
  pct90: number; // saldo del bucket 90+ / totalAbierto (0..1)
  docsAbiertos: number;
  terceros: number;
  anios: number[]; // años presentes en la cartera abierta
  buckets: Record<BucketKey, AgingBucket>;
  topDeudores: TopDeudor[];
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

function bucketDe(edad: number): BucketKey {
  if (edad <= 0) return 'alDia';
  if (edad <= 30) return '0-30';
  if (edad <= 60) return '31-60';
  if (edad <= 90) return '61-90';
  return '90+';
}

/**
 * Agrega los documentos de cartera con SaldoFinal>0 en: agregado por tercero +
 * resumen de aging. `nombres` (id→nombre, del snapshot de clients) resuelve el
 * nombre de los top deudores; si no matchea, cae al código de tercero.
 */
export function aggregateCartera(
  raw: unknown,
  nombres?: Map<string, string>,
): { clientes: CarteraCliente[]; resumen: CarteraResumen } {
  const docs = Array.isArray(raw) ? (raw as HgiCarteraDoc[]) : [];

  const buckets: Record<BucketKey, AgingBucket> = {
    alDia: { docs: 0, saldo: 0 },
    '0-30': { docs: 0, saldo: 0 },
    '31-60': { docs: 0, saldo: 0 },
    '61-90': { docs: 0, saldo: 0 },
    '90+': { docs: 0, saldo: 0 },
  };
  const byTercero = new Map<string, CarteraCliente>();
  const anios = new Set<number>();
  let totalAbierto = 0;
  let totalVencido = 0;
  let docsAbiertos = 0;

  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const saldo = num(d.SaldoFinal);
    if (saldo <= 0) continue; // solo cartera abierta

    const edad = num(d.Edad);
    const id = str(d.CodigoTercero) || '(sin tercero)';
    const anyo = num(d.Anyo);

    docsAbiertos += 1;
    totalAbierto += saldo;
    if (edad > 0) totalVencido += saldo;
    if (anyo > 0) anios.add(anyo);

    const b = bucketDe(edad);
    buckets[b].docs += 1;
    buckets[b].saldo += saldo;

    let c = byTercero.get(id);
    if (!c) {
      c = { codigoTercero: id, saldoTotal: 0, saldoVencido: 0, diasMaxMora: 0, docsAbiertos: 0 };
      byTercero.set(id, c);
    }
    c.saldoTotal += saldo;
    if (edad > 0) c.saldoVencido += saldo;
    if (edad > c.diasMaxMora) c.diasMaxMora = edad;
    c.docsAbiertos += 1;
  }

  const clientes = [...byTercero.values()].sort((a, b) => b.saldoTotal - a.saldoTotal);
  const topDeudores: TopDeudor[] = clientes.slice(0, 10).map((c) => ({
    codigoTercero: c.codigoTercero,
    nombre: nombres?.get(c.codigoTercero) ?? c.codigoTercero,
    saldoTotal: c.saldoTotal,
    saldoVencido: c.saldoVencido,
    diasMaxMora: c.diasMaxMora,
  }));

  return {
    clientes,
    resumen: {
      totalAbierto,
      totalVencido,
      pct90: totalAbierto > 0 ? buckets['90+'].saldo / totalAbierto : 0,
      docsAbiertos,
      terceros: clientes.length,
      anios: [...anios].sort((a, b) => a - b),
      buckets,
      topDeudores,
    },
  };
}
