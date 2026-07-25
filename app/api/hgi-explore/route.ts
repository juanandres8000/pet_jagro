import { NextResponse } from 'next/server';
import { hgiGet, getValidToken } from '@/lib/hgi/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL — DIAGNÓSTICO del gap 7.847 M vs 15.404 M. Borrar al terminar.
 * SOLO LECTURA: no escribe en ningún snapshot.
 *
 * Hipótesis a probar: el gap es por el AÑO, no por el periodo. Cartera/Obtener
 * corre con anyo=2026 fijo, así que los documentos abiertos originados en 2025 o
 * antes no aparecen; ResumenPorClases probablemente los arrastra.
 *
 * También aclara qué es el periodo 8 (agosto, que aún no ocurre) y cuál es el
 * último periodo con datos de cierre reales.
 */

const TIMEOUT_MS = 200_000;
const ANYOS = ['2026', '2025', '2024', '2023'];

type Fila = Record<string, unknown>;

const params = (anyo: string) => ({
  anyo,
  periodo: '*',
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '*',
  grupo: '*',
  codigo_clase: '*',
});

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const fecha = (v: unknown) => str(v).slice(0, 10);
const round = (n: number) => Math.round(n);

/** Identidad del documento, SIN el año: para detectar arrastre entre años. */
const docKey = (f: Fila) =>
  `${str(f.Transaccion)}|${str(f.Documento)}|${str(f.CodigoTercero)}|${str(f.Cuota)}`;

/**
 * Saldo abierto deduplicado: por cada documento se toma la fila del ÚLTIMO
 * periodo (el cierre más reciente) y se suma su SaldoFinal si es > 0.
 * Sumar todos los periodos contaría la misma deuda una vez por periodo.
 */
function dedupUltimoPeriodo(filas: Fila[]): { total: number; docs: number; porDoc: Map<string, Fila> } {
  const porDoc = new Map<string, Fila>();
  for (const f of filas) {
    const k = docKey(f);
    const prev = porDoc.get(k);
    if (!prev || num(f.Periodo) > num(prev.Periodo)) porDoc.set(k, f);
  }
  let total = 0;
  let docs = 0;
  for (const f of porDoc.values()) {
    const s = num(f.SaldoFinal);
    if (s > 0) {
      total += s;
      docs += 1;
    }
  }
  return { total, docs, porDoc };
}

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  await getValidToken();

  const porAnyo: Record<string, unknown> = {};
  // docKey → año más reciente en que aparece, y su fila de último periodo.
  const masReciente = new Map<string, { anyo: string; fila: Fila }>();
  const apariciones = new Map<string, Set<string>>();
  let periodo8: unknown = null;

  for (const anyo of ANYOS) {
    const t0 = Date.now();
    let filas: Fila[] = [];
    try {
      const raw = await hgiGet<Fila[]>('Cartera', 'Obtener', params(anyo), { timeoutMs: TIMEOUT_MS });
      filas = Array.isArray(raw) ? raw : [];
    } catch (err) {
      porAnyo[anyo] = { error: (err as Error).message };
      continue;
    }
    const ms = Date.now() - t0;
    const abiertas = filas.filter((f) => num(f.SaldoFinal) > 0);
    const dd = dedupUltimoPeriodo(abiertas);

    // Periodos presentes: conteo, total naive y total del cierre de ese periodo.
    const periodos = new Map<number, { filas: number; saldo: number; minFecha: string; maxFecha: string }>();
    for (const f of abiertas) {
      const p = num(f.Periodo);
      const e = periodos.get(p) ?? { filas: 0, saldo: 0, minFecha: '9999', maxFecha: '0000' };
      e.filas += 1;
      e.saldo += num(f.SaldoFinal);
      const fe = fecha(f.Fecha);
      if (fe && fe < e.minFecha) e.minFecha = fe;
      if (fe && fe > e.maxFecha) e.maxFecha = fe;
      periodos.set(p, e);
    }

    porAnyo[anyo] = {
      ms,
      filasCrudas: filas.length,
      filasAbiertas: abiertas.length,
      documentosDistintos: dd.porDoc.size,
      totalNaiveSumandoPeriodos: round(abiertas.reduce((a, f) => a + num(f.SaldoFinal), 0)),
      totalDedupUltimoPeriodo: round(dd.total),
      docsConSaldoEnUltimoPeriodo: dd.docs,
      periodos: Object.fromEntries(
        [...periodos].sort((a, b) => a[0] - b[0]).map(([p, e]) => [p, { ...e, saldo: round(e.saldo) }]),
      ),
    };

    // Arrastre entre años: se queda el año MÁS RECIENTE de cada documento.
    for (const [k, f] of dd.porDoc) {
      if (!apariciones.has(k)) apariciones.set(k, new Set());
      apariciones.get(k)!.add(anyo);
      const prev = masReciente.get(k);
      if (!prev || anyo > prev.anyo) masReciente.set(k, { anyo, fila: f });
    }

    // ---- Qué es el periodo 8 de 2026 ----
    if (anyo === '2026') {
      const p8 = abiertas.filter((f) => num(f.Periodo) === 8);
      const p7 = abiertas.filter((f) => num(f.Periodo) === 7);
      const resumen = (arr: Fila[]) => {
        const fechas = arr.map((f) => fecha(f.Fecha)).filter(Boolean).sort();
        const vtos = arr.map((f) => fecha(f.FechaVencimiento)).filter(Boolean).sort();
        return {
          filas: arr.length,
          saldo: round(arr.reduce((a, f) => a + num(f.SaldoFinal), 0)),
          fechaDoc: { min: fechas[0] ?? null, max: fechas[fechas.length - 1] ?? null },
          fechaVenc: { min: vtos[0] ?? null, max: vtos[vtos.length - 1] ?? null },
          // ¿Hubo movimiento en el periodo, o sólo arrastre?
          conValorGenerado: arr.filter((f) => num(f.ValorGeneradoPeriodo) !== 0).length,
          conValorPagado: arr.filter((f) => num(f.ValorPagadoPeriodo) !== 0).length,
          conSaldoInicialCero: arr.filter((f) => num(f.SaldoInicial) === 0).length,
        };
      };
      periodo8 = {
        periodo7: resumen(p7),
        periodo8: resumen(p8),
        // ¿Los documentos del 8 son los mismos del 7?
        docsDel8QueYaEstanEn7: (() => {
          const s7 = new Set(p7.map(docKey));
          return p8.filter((f) => s7.has(docKey(f))).length;
        })(),
        muestraPeriodo8: p8.slice(0, 3),
      };
    }
  }

  // ---- Consolidado entre años, contando cada documento UNA vez ----
  let consolidado = 0;
  let docsConsolidado = 0;
  const aporteAnyo: Record<string, { docs: number; saldo: number }> = {};
  for (const [, { anyo, fila }] of masReciente) {
    const s = num(fila.SaldoFinal);
    if (s <= 0) continue;
    consolidado += s;
    docsConsolidado += 1;
    const a = aporteAnyo[anyo] ?? { docs: 0, saldo: 0 };
    a.docs += 1;
    a.saldo += s;
    aporteAnyo[anyo] = a;
  }
  for (const k of Object.keys(aporteAnyo)) aporteAnyo[k].saldo = round(aporteAnyo[k].saldo);

  const enVariosAnyos = [...apariciones.values()].filter((s) => s.size > 1).length;

  const REFERENCIA_RESUMEN_POR_CLASES = 15404367512;

  // ---- Reconciliación: ResumenPorClases por periodo vs Cartera/Obtener ----
  // Si ResumenPorClases con periodo='*' también suma periodos, sus cifras por
  // periodo deberían parecerse a las de Cartera/Obtener del mismo periodo.
  const clasesPorPeriodo: Record<string, unknown> = {};
  for (const per of ['*', '07', '08', '06', '13']) {
    try {
      const raw = await hgiGet<Fila[]>(
        'Cartera',
        'ResumenPorClases',
        { anyo: '2026', periodo: per, codigo_tercero: '*', codigo_local: '*', tipo_cartera: '0', grupo: '*' },
        { timeoutMs: TIMEOUT_MS },
      );
      const arr = Array.isArray(raw) ? raw : [];
      let pos = 0;
      let neg = 0;
      for (const f of arr) {
        const s = num(f.Saldo);
        if (s >= 0) pos += s;
        else neg += s;
      }
      clasesPorPeriodo[per] = {
        filas: arr.length,
        terceros: new Set(arr.map((f) => str(f.Tercero))).size,
        positivo: round(pos),
        negativo: round(neg),
        neto: round(pos + neg),
      };
    } catch (err) {
      clasesPorPeriodo[per] = { error: (err as Error).message };
    }
  }

  return NextResponse.json({
    ok: true,
    porAnyo,
    arrastreEntreAnyos: {
      documentosDistintosTotales: masReciente.size,
      documentosEnMasDeUnAnyo: enVariosAnyos,
      aporteDelAnyoMasRecientePorDocumento: aporteAnyo,
    },
    consolidado: {
      totalContandoCadaDocumentoUnaVez: round(consolidado),
      documentos: docsConsolidado,
      referenciaResumenPorClasesPositivo: REFERENCIA_RESUMEN_POR_CLASES,
      diferencia: round(consolidado - REFERENCIA_RESUMEN_POR_CLASES),
      ratio: Number((consolidado / REFERENCIA_RESUMEN_POR_CLASES).toFixed(4)),
    },
    periodo8,
    resumenPorClasesPorPeriodo: clasesPorPeriodo,
  });
}
