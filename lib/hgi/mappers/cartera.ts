/**
 * Mapper/agregador de Cartera (HGINet Api/Cartera/Obtener) → aging.
 *
 * El endpoint devuelve UN registro por documento/cuota de cartera. Aquí NO se
 * guardan los ~32k documentos crudos en el snapshot: se agregan a nivel de tercero
 * (data[] liviano para lookups) y se precalcula el resumen de aging (buckets, top
 * deudores) que consume la vista, evitando reenviar la data cruda en cada request.
 *
 * CAMPOS QUE EL ENDPOINT YA TRAÍA Y SE PERDÍAN AL AGREGAR
 * `CodigoVendedor` y `FechaVencimiento` vienen POR DOCUMENTO en
 * Cartera/Obtener y la agregación los descartaba. Se recuperan sin tocar la
 * fuente, el filtro SaldoFinal > 0 ni ninguna cifra existente:
 *
 *  - `porVendedor` agrega el saldo abierto POR DOCUMENTO, no asignando un
 *    vendedor a cada tercero. Es deliberado: un tercero puede tener documentos
 *    de varios vendedores y repartir su saldo entero al vendedor "dominante"
 *    inventaría atribución. Así la suma de porVendedor da exactamente
 *    totalAbierto.
 *  - `CarteraCliente.codigoVendedor` sí guarda el vendedor DOMINANTE del tercero
 *    (el de mayor saldo) para lookups, con `vendedoresMultiples` marcando cuándo
 *    esa simplificación aplica. No se usa para sumar nada.
 *  - `proximos` lleva el detalle por documento de lo que está por vencer, con
 *    horizonte acotado (HORIZONTE_PROXIMOS_DIAS): son los documentos aún no
 *    vencidos, subconjunto del bucket `alDia`, así que está naturalmente
 *    limitado y no reintroduce los 32k crudos.
 */

/** Días hacia adelante que se conservan con detalle por documento. */
export const HORIZONTE_PROXIMOS_DIAS = 45;

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
  /** Vendedor DOMINANTE (mayor saldo). Para lookups, nunca para sumar. */
  codigoVendedor: string;
  /** true si el tercero tiene documentos de más de un vendedor. */
  vendedoresMultiples: boolean;
}

/** Saldo abierto por vendedor, agregado a nivel de DOCUMENTO. */
export interface VendedorCartera {
  codigoVendedor: string;
  saldoAbierto: number;
  saldoVencido: number;
  docs: number;
  terceros: number;
}

/** Documento por vencer, con el detalle que la agregación perdía. */
export interface DocProximo {
  documento: string;
  transaccion: string;
  codigoTercero: string;
  codigoVendedor: string;
  fechaVencimiento: string; // YYYY-MM-DD
  diasParaVencer: number;
  saldo: number;
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
  /** Saldo abierto por vendedor. Suma exactamente totalAbierto. */
  porVendedor: VendedorCartera[];
  /** Documentos por vencer dentro de HORIZONTE_PROXIMOS_DIAS, detalle por doc. */
  proximos: DocProximo[];
  /** Horizonte usado, para que la vista no lo asuma. */
  horizonteProximosDias: number;
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
  hoy = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10),
): { clientes: CarteraCliente[]; resumen: CarteraResumen } {
  const docs = Array.isArray(raw) ? (raw as HgiCarteraDoc[]) : [];
  const hoyMs = Date.parse(`${hoy}T00:00:00Z`);

  const buckets: Record<BucketKey, AgingBucket> = {
    alDia: { docs: 0, saldo: 0 },
    '0-30': { docs: 0, saldo: 0 },
    '31-60': { docs: 0, saldo: 0 },
    '61-90': { docs: 0, saldo: 0 },
    '90+': { docs: 0, saldo: 0 },
  };
  const byTercero = new Map<string, CarteraCliente>();
  const anios = new Set<number>();
  // Acumuladores nuevos. Ninguno participa en las cifras existentes.
  const byVendedor = new Map<string, { saldoAbierto: number; saldoVencido: number; docs: number; terceros: Set<string> }>();
  const saldoPorVendedorDeTercero = new Map<string, Map<string, number>>();
  const proximos: DocProximo[] = [];
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
      c = {
        codigoTercero: id,
        saldoTotal: 0,
        saldoVencido: 0,
        diasMaxMora: 0,
        docsAbiertos: 0,
        codigoVendedor: '',
        vendedoresMultiples: false,
      };
      byTercero.set(id, c);
    }
    c.saldoTotal += saldo;
    if (edad > 0) c.saldoVencido += saldo;
    if (edad > c.diasMaxMora) c.diasMaxMora = edad;
    c.docsAbiertos += 1;

    // ---- Añadidos: por vendedor y por vencer. No tocan nada de arriba. ----
    const vend = str(d.CodigoVendedor) || '(sin vendedor)';
    let v = byVendedor.get(vend);
    if (!v) {
      v = { saldoAbierto: 0, saldoVencido: 0, docs: 0, terceros: new Set<string>() };
      byVendedor.set(vend, v);
    }
    v.saldoAbierto += saldo;
    if (edad > 0) v.saldoVencido += saldo;
    v.docs += 1;
    v.terceros.add(id);

    // Saldo por vendedor DENTRO del tercero, para resolver el dominante.
    let porVend = saldoPorVendedorDeTercero.get(id);
    if (!porVend) {
      porVend = new Map<string, number>();
      saldoPorVendedorDeTercero.set(id, porVend);
    }
    porVend.set(vend, (porVend.get(vend) ?? 0) + saldo);

    // Por vencer: aún no vencido (edad <= 0) y con vencimiento dentro del
    // horizonte. Subconjunto del bucket alDia, así que está acotado.
    const fv = str(d.FechaVencimiento).slice(0, 10);
    if (edad <= 0 && fv) {
      const dias = Math.round((Date.parse(`${fv}T00:00:00Z`) - hoyMs) / 86_400_000);
      if (Number.isFinite(dias) && dias >= 0 && dias <= HORIZONTE_PROXIMOS_DIAS) {
        proximos.push({
          documento: str(d.Documento),
          transaccion: str(d.Transaccion),
          codigoTercero: id,
          codigoVendedor: vend,
          fechaVencimiento: fv,
          diasParaVencer: dias,
          saldo,
        });
      }
    }
  }

  // Vendedor dominante por tercero (mayor saldo). Sólo para lookups.
  for (const [id, porVend] of saldoPorVendedorDeTercero) {
    const c = byTercero.get(id);
    if (!c) continue;
    let mejor = '';
    let mejorSaldo = -Infinity;
    for (const [vend, sal] of porVend) {
      if (sal > mejorSaldo) {
        mejorSaldo = sal;
        mejor = vend;
      }
    }
    c.codigoVendedor = mejor;
    c.vendedoresMultiples = porVend.size > 1;
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
      porVendedor: [...byVendedor]
        .map(([codigoVendedor, v]) => ({
          codigoVendedor,
          saldoAbierto: v.saldoAbierto,
          saldoVencido: v.saldoVencido,
          docs: v.docs,
          terceros: v.terceros.size,
        }))
        .sort((a, b) => b.saldoAbierto - a.saldoAbierto),
      proximos: proximos.sort((a, b) => a.diasParaVencer - b.diasParaVencer || b.saldo - a.saldo),
      horizonteProximosDias: HORIZONTE_PROXIMOS_DIAS,
    },
  };
}
