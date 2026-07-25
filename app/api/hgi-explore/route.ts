import { NextResponse } from 'next/server';
import { getValidToken } from '@/lib/hgi/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL DE EXPLORACIÓN — borrar cuando termine el sondeo de P&G.
 *
 * Existe porque las credenciales de HGINet viven sólo en Vercel y re-autenticar
 * desde local invalidaría el token de producción (HGINet permite uno vigente por
 * usuario). Este sondeo corre en el lambda de prod, que reusa el token cacheado.
 *
 * Hace fetch CRUDO en vez de usar hgiGet porque necesita el cuerpo del error, no
 * una excepción: los 404 de ASP.NET Web API distinguen dos cosas distintas y esa
 * diferencia es justo lo que hay que medir.
 *   - "No type was found that matches the controller named 'X'"  → controlador NO existe
 *   - "No action was found on the controller 'X'"                → controlador SÍ existe,
 *                                                                  la acción o la firma no
 * Con eso, llamar a una acción inventada sirve de oráculo de existencia de
 * controlador. Un 409 significa que la ruta resolvió y HGINet rechazó por otra
 * razón (típicamente permisos del usuario).
 *
 * No devuelve payloads completos: forma, conteos, latencia y muestra recortada.
 * Protegida con HGI_EXPLORE_SECRET (variable nueva y temporal).
 */

const BASE = (process.env.HGI_BASE_URL ?? '').replace(/\/+$/, '');
const EMPRESA = process.env.HGI_COD_EMPRESA ?? '';
const ACCION_INVENTADA = '__probe_no_existe__';

type Clasificacion = 'sin-controlador' | 'sin-accion' | 'sin-permisos' | 'ok' | 'otro';

interface Resultado {
  ruta: string;
  nota?: string;
  http: number;
  ms: number;
  clasificacion: Clasificacion;
  filas?: number | null;
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
  if (Array.isArray(o)) return o.slice(0, prof === 0 ? 1 : 2).map((x) => recortar(x, prof + 1));
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
  recurso: string,
  metodo: string,
  params: Record<string, string>,
  token: string,
  nota?: string,
  timeoutMs = 120_000,
): Promise<Resultado> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/Api/${recurso}/${metodo}/${qs ? `?${qs}` : ''}`;
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
    const ms = Date.now() - t0;
    const clasificacion = clasificar(res.status, cuerpo);
    const base: Resultado = { ruta: `${recurso}/${metodo}`, nota, http: res.status, ms, clasificacion };

    if (clasificacion === 'ok') {
      let data: unknown = null;
      try {
        data = JSON.parse(cuerpo);
      } catch {
        return { ...base, clasificacion: 'otro', cuerpo: cuerpo.slice(0, 200) };
      }
      const esArray = Array.isArray(data);
      return {
        ...base,
        filas: esArray ? (data as unknown[]).length : null,
        campos: forma(esArray ? (data as unknown[])[0] : data),
        muestra: recortar(esArray ? (data as unknown[])[0] : data),
      };
    }
    // Para los fallos basta el mensaje corto; el detalle largo ya está clasificado.
    return { ...base, cuerpo: cuerpo.replace(/\s+/g, ' ').slice(0, 160) };
  } catch (err) {
    return {
      ruta: `${recurso}/${metodo}`,
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

/** Controladores candidatos para contabilidad / estado de resultados. */
const CONTROLADORES = [
  'DocumentosContables',
  'PlanContable',
  'PlanCuentas',
  'Cuentas',
  'CuentasContables',
  'Contabilidad',
  'Balance',
  'Balances',
  'BalancePrueba',
  'EstadoResultados',
  'EstadosFinancieros',
  'Movimientos',
  'MovimientosContables',
  'Comprobantes',
  'ComprobantesContables',
  'Puc',
  'Terceros',
];

/** Acciones candidatas sobre PlanContable. */
const ACCIONES_PLAN = [
  'ObtenerPlanContableNIIF',
  'ObtenerPlanContablePCGA',
  'ObtenerPlanContable',
  'ObtenerPlan',
  'ObtenerCuentas',
  'ObtenerCuentasNIIF',
  'ObtenerCuentasPCGA',
  'ObtenerNIIF',
  'ObtenerPCGA',
  'Obtener',
  'ObtenerLista',
  'ObtenerTodo',
];

/** Variantes de firma para PlanContable/Obtener. */
const PARAMS_PLAN: Array<{ p: Record<string, string>; nota: string }> = [
  { p: {}, nota: 'sin params' },
  { p: { codigo: '*' }, nota: 'codigo=*' },
  { p: { cuenta: '*' }, nota: 'cuenta=*' },
  { p: { codigo_cuenta: '*' }, nota: 'codigo_cuenta=*' },
  { p: { empresa: EMPRESA }, nota: 'empresa' },
  { p: { codigo_empresa: EMPRESA }, nota: 'codigo_empresa' },
  { p: { codigo_empresa: EMPRESA, codigo: '*' }, nota: 'codigo_empresa+codigo' },
];

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  const grupo = new URL(req.url).searchParams.get('grupo') ?? 'controladores';
  const token = await getValidToken();
  const resultados: Resultado[] = [];

  // Oráculo de existencia: acción inventada sobre cada controlador candidato.
  if (grupo === 'controladores') {
    for (const c of CONTROLADORES) {
      resultados.push(await probar(c, ACCION_INVENTADA, {}, token, undefined, 15_000));
    }
  }

  // Barrido de acciones sobre PlanContable (el controlador sí existe).
  if (grupo === 'plan') {
    for (const a of ACCIONES_PLAN) {
      resultados.push(await probar('PlanContable', a, { codigo: '*' }, token, 'codigo=*', 30_000));
    }
    for (const { p, nota } of PARAMS_PLAN) {
      resultados.push(await probar('PlanContable', 'Obtener', p, token, nota, 30_000));
    }
  }

  // DocumentosContables/Obtener: confirmar el 409 y probar firmas alternativas.
  if (grupo === 'docs') {
    const variantes: Array<{ p: Record<string, string>; nota: string }> = [
      {
        p: { empresa: EMPRESA, comprobante: '*', documento: '*', fecha_inicial: '2026-06-01', fecha_final: '2026-06-01' },
        nota: 'firma documentada, 1 día',
      },
      {
        p: { codigo_empresa: EMPRESA, codigo_comprobante: '*', documento: '*', fecha_inicial: '2026-06-01', fecha_final: '2026-06-01' },
        nota: 'convención codigo_*',
      },
      {
        p: { empresa: EMPRESA, comprobante: '01', documento: '*', fecha_inicial: '2026-06-01', fecha_final: '2026-06-01' },
        nota: 'comprobante concreto',
      },
      { p: {}, nota: 'sin params' },
    ];
    for (const { p, nota } of variantes) {
      resultados.push(await probar('DocumentosContables', 'Obtener', p, token, nota, 60_000));
    }
    // Acciones alternativas sobre el controlador, que sí existe.
    for (const a of ['ObtenerDetalle', 'ObtenerMovimiento', 'ObtenerContable', 'ObtenerPorFecha', 'ObtenerLista']) {
      resultados.push(await probar('DocumentosContables', a, { empresa: EMPRESA }, token, undefined, 30_000));
    }
  }

  const resumen = resultados.reduce<Record<string, number>>((acc, r) => {
    acc[r.clasificacion] = (acc[r.clasificacion] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({ ok: true, grupo, empresa: EMPRESA, resumen, resultados });
}
