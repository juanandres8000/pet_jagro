import { NextResponse } from 'next/server';
import {
  diasDelMes,
  readAsientoCosto,
  readDiasCubiertos,
  readDiasCubiertosVarios,
  readGastosPorGrupo,
  readMesesMensualOk,
  readPygMes,
  readPygMeses,
  tieneVentanaMensualOk,
  type GrupoGasto,
  type PygMes,
} from '@/lib/hgi/pygStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Sólo lee de Supabase: no habla con HGINet. Los crons son los que reconstruyen.
export const maxDuration = 30;

/**
 * P&G mensual, servido desde pyg_movimiento / pyg_cuenta vía las vistas
 * pyg_saldo_cuenta y pyg_mensual.
 *
 *   GET /api/pyg              → TODOS los meses con ventana mensual ok
 *   GET /api/pyg?mes=YYYY-MM  → un mes con el detalle de gastos por subcuenta y
 *                               `comparativo`: el mismo mes del año anterior,
 *                               o null si ese mes no está completo
 *
 * ============ POR QUÉ EL BLOQUE `integridad` NO ES DECORATIVO ============
 *
 * `pyg_mensual` agrupa lo que HAYA en pyg_movimiento, y no sabe si un mes está
 * completo. Una consulta de junio devuelve 958 líneas fechadas 2026-07-01, así
 * que julio aparece en la vista con esas líneas sueltas y —vía el fallback de
 * costo del Gerencial— un resultado de −1.689 millones que parece real y no lo
 * es. Lo mismo pasó con mayo a partir del arrastre de abril.
 *
 * Por eso un mes sin VENTANA MENSUAL ok no se lista, y pedido por `?mes=`
 * responde `completo: false` SIN CIFRAS. La regla es que este endpoint nunca
 * entrega números de un mes que no se ingestó entero.
 *
 * Las consultas van EN SERIE: el cliente de Postgres es `max: 1` y un
 * Promise.all sobre él cuelga la ruta (CLAUDE.md § Trampas del pooler #2).
 */

/**
 * Por debajo de este descuadre (en pesos) la partida doble no se alerta: es
 * redondeo del ERP (mayo-2026 descuadra en −6). `cuadraPartidaDoble` sigue
 * siendo la igualdad exacta; el umbral sólo decide si la vista avisa.
 */
const UMBRAL_ALERTA_PARTIDA_DOBLE = 1_000;

interface Integridad {
  diasEsperados: number;
  diasIngestados: number;
  completo: boolean;
  /** Débitos = créditos exacto. */
  cuadraPartidaDoble: boolean;
  debitos: number;
  creditos: number;
  /** Débitos − créditos. */
  diferencia: number;
  /** |diferencia| ≥ UMBRAL_ALERTA_PARTIDA_DOBLE: sólo entonces la vista avisa. */
  alertaPartidaDoble: boolean;
}

const integridadDe = (m: PygMes, diasCubiertos: number): Integridad => {
  const diferencia = m.debitosMes - m.creditosMes;
  return {
    diasEsperados: diasDelMes(m.mes),
    diasIngestados: diasCubiertos,
    completo: diasCubiertos >= diasDelMes(m.mes),
    cuadraPartidaDoble: m.cuadraPartidaDoble,
    debitos: m.debitosMes,
    creditos: m.creditosMes,
    diferencia,
    alertaPartidaDoble: Math.abs(diferencia) >= UMBRAL_ALERTA_PARTIDA_DOBLE,
  };
};

const bloqueIngresos = (m: PygMes) => ({
  brutas: m.ventasBrutas,
  devolucionesDescuentos: m.devolucionesDescuentos,
  operacionalNeto: m.ingOperacionalNeto,
  noOperacional: m.ingNoOperacional,
  total: m.ingresosTotales,
});

/** Aviso del fallback, citando el asiento real cuando existe. */
function avisoCosto(mes: string, asiento: Awaited<ReturnType<typeof readAsientoCosto>>): string {
  if (!asiento) {
    return `No hay asiento de costo de ventas (6135) en ${mes}; se usa el costo del Gerencial.`;
  }
  const glosa = asiento.detalle ? `${asiento.detalle} ` : '';
  return (
    `El asiento ${glosa}(comprobante ${asiento.comprobante}, documento ${asiento.documento}, ` +
    `${asiento.fecha}) existe pero está en cero; se usa el costo del Gerencial.`
  );
}

/**
 * Utilidad operacional = ingreso operacional neto − costo − gastos operacionales
 * (51 administración + 52 ventas). El resultado del ejercicio suma después el
 * no operacional (42 − 53) y cualquier otro grupo de la clase 5.
 */
const utilidadOperacional = (m: PygMes) => m.ingOperacionalNeto - m.costo - m.gastoAdmon - m.gastoVentas;

const bloqueGastos = (m: PygMes, porGrupo: GrupoGasto[]) => ({
  total: m.gastoTotal,
  admon: m.gastoAdmon,
  ventas: m.gastoVentas,
  noOperacional: m.gastoNoOperacional,
  porGrupo,
});

export async function GET(req: Request) {
  const mes = new URL(req.url).searchParams.get('mes');

  try {
    if (mes) {
      if (!/^\d{4}-\d{2}$/.test(mes)) {
        return NextResponse.json({ ok: false, mensaje: 'Parámetro "mes" debe ser YYYY-MM' }, { status: 400 });
      }
      return await unMes(mes);
    }
    return await listado();
  } catch (err) {
    const mensaje = (err as Error).message;
    console.error(`[pyg] /api/pyg falló: ${mensaje}`);
    // Degradación explícita, no 500 mudo: la vista muestra el aviso.
    return NextResponse.json({
      ok: true,
      meses: [],
      count: 0,
      aviso: `P&G no disponible (${mensaje}).`,
    });
  }
}

/**
 * Cifras completas de un mes, o null si no tiene ventana mensual ok o no tiene
 * movimiento. Es la misma lectura para el mes pedido y para su comparativo, así
 * que las dos columnas salen de exactamente las mismas reglas.
 */
async function cifrasMes(mes: string) {
  if (!(await tieneVentanaMensualOk(mes))) return null;
  const m = await readPygMes(mes);
  if (!m) return null;
  const diasCubiertos = await readDiasCubiertos(mes);
  const porGrupo = await readGastosPorGrupo(mes);
  const asiento = m.costoEsFallback ? await readAsientoCosto(mes) : null;
  return {
    mes: m.mes,
    ingresos: bloqueIngresos(m),
    costo: {
      valor: m.costo,
      esFallback: m.costoEsFallback,
      fuente: m.costoEsFallback ? 'gerencial' : 'contable',
      contable: m.costoContable,
      ...(m.costoEsFallback ? { aviso: avisoCosto(mes, asiento) } : {}),
    },
    gastos: bloqueGastos(m, porGrupo),
    utilidadBruta: m.utilidadBruta,
    utilidadOperacional: utilidadOperacional(m),
    resultado: m.resultado,
    integridad: integridadDe(m, diasCubiertos),
  };
}

/** El mismo mes del año anterior: '2026-05' → '2025-05'. */
const mismoMesAnioAnterior = (mes: string) => `${Number(mes.slice(0, 4)) - 1}${mes.slice(4)}`;

/** Un mes con detalle. Sin ventana mensual ok no devuelve cifras. */
async function unMes(mes: string): Promise<NextResponse> {
  const mensualOk = await tieneVentanaMensualOk(mes);
  if (!mensualOk) {
    return NextResponse.json({
      ok: true,
      mes,
      completo: false,
      aviso:
        `El mes ${mes} todavía no se ingestó completo (falta su ventana mensual en pyg_ventana_control), ` +
        'así que no se devuelven cifras. El backfill lo cubrirá en una próxima corrida.',
    });
  }

  const m = await readPygMes(mes);
  if (!m) {
    return NextResponse.json({
      ok: true,
      mes,
      completo: false,
      aviso: `El mes ${mes} no tiene movimiento contable cargado.`,
    });
  }

  // En serie, no Promise.all (cliente max: 1, ver cabecera).
  const actual = await cifrasMes(mes);
  const mesAnt = mismoMesAnioAnterior(mes);
  const comparativo = await cifrasMes(mesAnt);

  return NextResponse.json({
    ok: true,
    completo: true,
    ...actual,
    // null = el mismo mes del año anterior no está completo: la vista muestra "—".
    comparativo,
    mesComparativo: mesAnt,
  });
}

/**
 * Tope del listado: en la práctica "todos". Con 2025 cargado hay 19 meses; el
 * tope sólo existe porque readMesesMensualOk exige uno.
 */
const MAX_MESES_LISTADO = 240;

/** Listado: TODOS los meses con ventana mensual ok, del más reciente al más viejo. */
async function listado(): Promise<NextResponse> {
  const meses = await readMesesMensualOk(MAX_MESES_LISTADO);
  if (meses.length === 0) {
    return NextResponse.json({
      ok: true,
      meses: [],
      count: 0,
      aviso: 'Todavía no hay ningún mes ingestado completo. El backfill los va cubriendo de a uno.',
    });
  }

  const filas = await readPygMeses(meses);
  const cubiertos = await readDiasCubiertosVarios(meses);

  return NextResponse.json({
    ok: true,
    count: filas.length,
    meses: filas.map((m) => ({
      mes: m.mes,
      ingresos: bloqueIngresos(m),
      costo: {
        valor: m.costo,
        esFallback: m.costoEsFallback,
        fuente: m.costoEsFallback ? 'gerencial' : 'contable',
        contable: m.costoContable,
      },
      gastos: { total: m.gastoTotal, admon: m.gastoAdmon, ventas: m.gastoVentas, noOperacional: m.gastoNoOperacional },
      utilidadBruta: m.utilidadBruta,
      utilidadOperacional: utilidadOperacional(m),
      resultado: m.resultado,
      integridad: integridadDe(m, cubiertos.get(m.mes) ?? 0),
    })),
  });
}
