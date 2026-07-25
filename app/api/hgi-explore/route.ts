import { NextResponse } from 'next/server';
import { hgiGet, getValidToken } from '@/lib/hgi/client';
import { trocear, ventanas, type Rango } from '@/lib/hgi/ventas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL — GATE DE CONTEO del Frente B. Borrar al terminar.
 *
 * Compara el MISMO rango por los dos endpoints de recaudo antes de migrar nada:
 *   A) Cartera/ObtenerRecaudo             (el que usa hoy el builder)
 *   B) Cartera/ObtenerRecaudoPorVendedor  (el candidato)
 *
 * Responde tres preguntas, en este orden de importancia:
 *  1. ¿Calzan los conteos de filas? Si no, NO se migra.
 *  2. ¿Calzan los importes y las claves de operación?
 *  3. ¿Qué campos trae cada uno REALMENTE poblados? La interfaz HgiRecaudoDoc ya
 *     declara CodigoVendedor, CodigoLocal, Cuota, FechaVencimiento, NumeroPago y
 *     CodigoClase para el endpoint A — si eso se confirma, los campos que
 *     "se pierden" no se pierden por el endpoint sino por la proyección del
 *     mapper, y migrar de endpoint sería riesgo sin beneficio.
 *
 * Usa el MISMO troceo por día y concurrencia que el builder de recaudo, para que
 * la comparación sea de manzanas con manzanas y quepa en maxDuration.
 */

const TIMEOUT_MS = 120_000;
const CONCURRENCIA = 12;

type Fila = Record<string, unknown>;

const paramsA = (r: Rango) => ({
  codigo_tercero: '*',
  fecha_inicial: r.desde,
  fecha_final: r.hasta,
});

const paramsB = (r: Rango) => ({
  fecha_inicial: r.desde,
  fecha_final: r.hasta,
  tipo_pago: '1',
  codigo_vendedor: '*',
});

/** Trae un rango troceado por día con concurrencia, igual que el builder. */
async function traer(
  recurso: string,
  metodo: string,
  build: (r: Rango) => Record<string, string>,
  rango: Rango,
): Promise<Fila[]> {
  const trozos = trocear(rango, 1);
  const out: Fila[] = [];
  let i = 0;
  async function worker() {
    while (i < trozos.length) {
      const t = trozos[i++];
      const raw = await hgiGet<Fila[]>(recurso, metodo, build(t), { timeoutMs: TIMEOUT_MS });
      if (Array.isArray(raw)) out.push(...raw);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, trozos.length) }, worker));
  return out;
}

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Clave de operación: el endpoint devuelve una fila por aplicación de pago sobre
 * una cuota, así que la identidad es (pago, documento, cuota).
 */
const clave = (f: Fila) =>
  `${str(f.TransaccionPago)}-${str(f.NumeroPago)}|${str(f.TransaccionDocumento)}-${str(f.NumeroDocumento)}|${str(f.Cuota)}`;

/** Para cada campo: cuántas filas lo traen no-nulo y no-vacío. */
function poblacion(filas: Fila[]): Record<string, string> {
  const claves = new Set<string>();
  for (const f of filas) for (const k of Object.keys(f)) claves.add(k);
  const out: Record<string, string> = {};
  for (const k of [...claves].sort()) {
    let pobl = 0;
    for (const f of filas) {
      const v = f[k];
      if (v !== null && v !== undefined && v !== '') pobl += 1;
    }
    out[k] = `${pobl}/${filas.length}`;
  }
  return out;
}

function resumir(filas: Fila[]) {
  const claves = new Set<string>();
  const docs = new Set<string>();
  let valor = 0;
  let interes = 0;
  const porDia = new Map<string, number>();
  for (const f of filas) {
    claves.add(clave(f));
    docs.add(`${str(f.TransaccionDocumento)}-${str(f.NumeroDocumento)}`);
    valor += num(f.ValorDetallePago);
    interes += num(f.InteresDocumento);
    const d = str(f.FechaPago).slice(0, 10);
    porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }
  return {
    filas: filas.length,
    clavesUnicas: claves.size,
    documentosUnicos: docs.size,
    valor: Math.round(valor),
    interes: Math.round(interes),
    porDia: Object.fromEntries([...porDia].sort()),
  };
}

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const desde = sp.get('desde');
  const hasta = sp.get('hasta');
  const rango: Rango = desde && hasta ? { desde, hasta } : ventanas().actual;

  await getValidToken();

  const t0 = Date.now();
  const a = await traer('Cartera', 'ObtenerRecaudo', paramsA, rango);
  const tA = Date.now() - t0;
  const t1 = Date.now();
  const b = await traer('Cartera', 'ObtenerRecaudoPorVendedor', paramsB, rango);
  const tB = Date.now() - t1;

  const rA = resumir(a);
  const rB = resumir(b);

  // Claves que están en uno y no en el otro: si hay, la migración cambiaría el
  // universo de operaciones, no sólo los campos.
  const setA = new Set(a.map(clave));
  const setB = new Set(b.map(clave));
  const soloA = [...setA].filter((k) => !setB.has(k));
  const soloB = [...setB].filter((k) => !setA.has(k));

  const camposA = new Set(Object.keys(poblacion(a)));
  const camposB = new Set(Object.keys(poblacion(b)));

  const calza =
    rA.filas === rB.filas && rA.clavesUnicas === rB.clavesUnicas && rA.valor === rB.valor && soloA.length === 0 && soloB.length === 0;

  return NextResponse.json({
    ok: true,
    rango,
    ventanas: trocear(rango, 1).length,
    veredicto: calza ? 'CALZA' : 'NO CALZA',
    A: { endpoint: 'Cartera/ObtenerRecaudo', ms: tA, ...rA },
    B: { endpoint: 'Cartera/ObtenerRecaudoPorVendedor', ms: tB, ...rB },
    diferencias: {
      filas: rB.filas - rA.filas,
      clavesUnicas: rB.clavesUnicas - rA.clavesUnicas,
      valor: rB.valor - rA.valor,
      clavesSoloEnA: soloA.length,
      clavesSoloEnB: soloB.length,
      muestraSoloEnA: soloA.slice(0, 5),
      muestraSoloEnB: soloB.slice(0, 5),
      camposSoloEnB: [...camposB].filter((k) => !camposA.has(k)),
      camposSoloEnA: [...camposA].filter((k) => !camposB.has(k)),
    },
    // La pregunta clave: ¿el endpoint ACTUAL ya trae los campos que queremos?
    poblacionA: poblacion(a),
    poblacionB: poblacion(b),
  });
}
