import { NextResponse } from 'next/server';
import { getValidToken } from '@/lib/hgi/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL DE EXPLORACIÓN — borrar al terminar el sondeo de Cartera.
 * Reencarnación de la que se retiró en a0e9c83; ver ese commit para lo aprendido
 * del sondeo contable.
 *
 * Existe porque las credenciales de HGINet viven sólo en Vercel y re-autenticar
 * desde local invalidaría el token de producción. Corre en el lambda de prod,
 * reusando el token cacheado.
 *
 * Fetch CRUDO en vez de hgiGet: hace falta el cuerpo del error, no una excepción.
 * Los 404 de ASP.NET Web API distinguen dos cosas y esa diferencia es el oráculo:
 *   "No type was found that matches the controller named 'X'" → controlador NO existe
 *   "No action was found on the controller 'X'"               → controlador SÍ existe;
 *                                                               la acción O LA FIRMA no
 * Ojo con lo segundo: en el sondeo contable se confirmó que la firma afecta al
 * routing (misma acción, params con otra convención → 404). Así que un 404 no
 * descarta la acción: hay que barrer acción × forma de params.
 * Un 409 significa ruta resuelta y HGINet rechazando (típicamente permisos).
 *
 * Se limita al recurso Cartera a propósito: el modo `libre` acepta método y
 * params por query para no redesplegar por cada hipótesis, pero no puede apuntar
 * a otro controlador.
 */

const BASE = (process.env.HGI_BASE_URL ?? '').replace(/\/+$/, '');
const RECURSO = 'Cartera';
const ACCION_INVENTADA = '__probe_no_existe__';

type Clasificacion = 'sin-controlador' | 'sin-accion' | 'sin-permisos' | 'ok' | 'otro';

interface Resultado {
  ruta: string;
  params: Record<string, string>;
  nota?: string;
  http: number;
  ms: number;
  clasificacion: Clasificacion;
  tipo?: string;
  filas?: number | null;
  bytes?: number;
  campos?: Record<string, string>;
  muestra?: unknown;
  cuerpo?: string;
}

function clasificar(http: number, cuerpo: string): Clasificacion {
  if (http === 200) return 'ok';
  if (http === 409) return 'sin-permisos';
  if (http === 404) {
    if (/No type was found that matches the controller/i.test(cuerpo)) return 'sin-controlador';
    if (/No action was found on the controller/i.test(cuerpo)) return 'sin-accion';
  }
  return 'otro';
}

const forma = (o: unknown): Record<string, string> => {
  if (!o || typeof o !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v;
  }
  return out;
};

function recortar(o: unknown, prof = 0): unknown {
  if (Array.isArray(o)) return o.slice(0, prof === 0 ? 2 : 1).map((x) => recortar(x, prof + 1));
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = typeof v === 'string' && v.length > 50 ? `${v.slice(0, 50)}…` : recortar(v, prof + 1);
    }
    return out;
  }
  return o;
}

async function probar(
  metodo: string,
  params: Record<string, string>,
  token: string,
  nota?: string,
  timeoutMs = 60_000,
): Promise<Resultado> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/Api/${RECURSO}/${metodo}/${qs ? `?${qs}` : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const cuerpo = await res.text();
    const ms = Date.now() - t0; // incluye descarga: es la latencia que importa
    const clasificacion = clasificar(res.status, cuerpo);
    const base: Resultado = { ruta: `${RECURSO}/${metodo}`, params, nota, http: res.status, ms, clasificacion };

    if (clasificacion === 'ok') {
      let data: unknown = null;
      try {
        data = JSON.parse(cuerpo);
      } catch {
        return { ...base, clasificacion: 'otro', bytes: cuerpo.length, cuerpo: cuerpo.slice(0, 200) };
      }
      // HGINet responde 200 con { Error: {...} } en fallos lógicos.
      const err = (data as { Error?: { Mensaje?: string } } | null)?.Error;
      if (err?.Mensaje) return { ...base, clasificacion: 'otro', cuerpo: `Error lógico: ${err.Mensaje}` };

      const esArray = Array.isArray(data);
      return {
        ...base,
        tipo: esArray ? 'array' : typeof data,
        filas: esArray ? (data as unknown[]).length : null,
        bytes: cuerpo.length,
        campos: forma(esArray ? (data as unknown[])[0] : data),
        muestra: recortar(data),
      };
    }
    return { ...base, cuerpo: cuerpo.replace(/\s+/g, ' ').slice(0, 160) };
  } catch (err) {
    return {
      ruta: `${RECURSO}/${metodo}`,
      params,
      nota,
      http: 0,
      ms: Date.now() - t0,
      clasificacion: 'otro',
      cuerpo: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Candidatos ----

/** Firma documentada de ObtenerRecaudoPorVendedor, en ORDEN. */
const pRecaudoVend = (desde: string, hasta: string) => ({
  fecha_inicial: desde,
  fecha_final: hasta,
  tipo_pago: '1',
  codigo_vendedor: '*',
});

/** Firma documentada de ResumenPorClases, en ORDEN. */
const pResumen = (anyo: string, periodo: string) => ({
  anyo,
  periodo,
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '0',
  grupo: '*',
});

const ACCIONES_RECAUDO_VEND = [
  'ObtenerRecaudoPorVendedor',
  'ObtenerRecaudoVendedor',
  'ObtenerRecaudoXVendedor',
  'ObtenerRecaudoPorVendedores',
  'ObtenerPorVendedor',
  'ResumenRecaudoPorVendedor',
  'ObtenerResumenRecaudoPorVendedor',
  'ObtenerRecaudoAgrupado',
];

const ACCIONES_RESUMEN = [
  'ResumenPorClases',
  'ObtenerResumenPorClases',
  'ObtenerResumenClases',
  'ResumenClases',
  'ObtenerPorClases',
  'ObtenerClases',
  'ObtenerResumen',
  'ObtenerResumenCartera',
];

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const grupo = sp.get('grupo') ?? 'sweep';
  const token = await getValidToken();
  const resultados: Resultado[] = [];

  if (grupo === 'sweep') {
    // Oráculo: el controlador Cartera debe salir "sin-accion" (existe).
    resultados.push(await probar(ACCION_INVENTADA, {}, token, 'oráculo de controlador', 15_000));

    // Un 404 no descarta la acción: la firma también enruta. Barremos
    // acción × (firma documentada, sin params).
    for (const a of ACCIONES_RECAUDO_VEND) {
      resultados.push(await probar(a, pRecaudoVend('2026-06-01', '2026-06-01'), token, 'firma doc, 1 día', 30_000));
      resultados.push(await probar(a, {}, token, 'sin params', 15_000));
    }
    for (const a of ACCIONES_RESUMEN) {
      resultados.push(await probar(a, pResumen('2026', '06'), token, 'firma doc', 30_000));
      resultados.push(await probar(a, {}, token, 'sin params', 15_000));
    }
  }

  // Latencia real por rango, sólo sobre acciones que ya respondieron 200.
  if (grupo === 'medir-recaudo') {
    const metodo = sp.get('metodo') ?? 'ObtenerRecaudoPorVendedor';
    const rangos: Array<[string, string, string]> = [
      ['2026-06-01', '2026-06-01', '1 día'],
      ['2026-06-01', '2026-06-05', '5 días'],
      ['2026-06-01', '2026-06-15', '15 días'],
      ['2026-06-01', '2026-06-30', 'mes completo'],
    ];
    for (const [d, h, nota] of rangos) {
      resultados.push(await probar(metodo, pRecaudoVend(d, h), token, nota, 240_000));
    }
  }

  if (grupo === 'medir-resumen') {
    const metodo = sp.get('metodo') ?? 'ResumenPorClases';
    // Este endpoint es por periodo (mes), no por rango: se mide mes a mes y con
    // periodo=* para ver si acepta el año completo de una sola llamada.
    for (const per of ['06', '05', '04', '*']) {
      resultados.push(await probar(metodo, pResumen('2026', per), token, `periodo=${per}`, 240_000));
    }
    for (const tc of ['1', '2', '3']) {
      resultados.push(
        await probar(metodo, { ...pResumen('2026', '06'), tipo_cartera: tc }, token, `tipo_cartera=${tc}`, 120_000),
      );
    }
  }

  // Modo libre: método y params por query, siempre sobre Cartera.
  if (grupo === 'libre') {
    const metodo = sp.get('metodo') ?? '';
    let params: Record<string, string> = {};
    try {
      params = JSON.parse(sp.get('params') ?? '{}');
    } catch {
      return NextResponse.json({ ok: false, mensaje: 'params debe ser JSON' }, { status: 400 });
    }
    if (!metodo) return NextResponse.json({ ok: false, mensaje: 'falta metodo' }, { status: 400 });
    resultados.push(await probar(metodo, params, token, 'libre', 240_000));
  }

  const resumen = resultados.reduce<Record<string, number>>((acc, r) => {
    acc[r.clasificacion] = (acc[r.clasificacion] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({ ok: true, grupo, resumen, resultados });
}
