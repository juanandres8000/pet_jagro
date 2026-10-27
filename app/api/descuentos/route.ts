import { NextResponse } from 'next/server';
import { readMesesOk, readMesesPygCompletos, readResumenLabs } from '@/lib/hgi/descuentos/store';
import { ordenarLabs, resumirLab, totalizar } from '@/lib/hgi/descuentos/resumen';
import { mesesHasta, MES_INICIAL } from '@/lib/hgi/descuentos/refresh';
import { hoyColombia } from '@/lib/hgi/ventas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Sólo lee de Supabase: no habla con HGINet. El cron `descuentos` es el que ingesta.
export const maxDuration = 30;

/**
 * Descuentos diferenciados (docs/DESCUENTOS.md).
 *
 *   GET /api/descuentos?desde=YYYY-MM&hasta=YYYY-MM
 *     → por laboratorio: venta neta, margen con y sin precio cero, precio cero
 *       entregado, lo recibido del laboratorio por canal, cobertura y brecha.
 *   Sin parámetros: el año en curso hasta el mes actual.
 *
 * Descuento al pagar (cuenta 14352290): sale de pyg_movimiento y SÓLO se suma en
 * meses con P&G completo (ventana mensual ok). `alPagar.mesesSinDato` lista los
 * del rango que no lo tienen: ahí ese canal vale 0 porque no se sabe, no porque
 * no exista. La vista lo avisa.
 *
 * Integridad: como /api/pyg, sólo entrega cifras de meses con una ingesta OK en
 * dd_ventana_control. Si en el rango falta alguno, `completo: false` y la lista
 * `mesesSinDatos`; las cifras cubren SÓLO los meses con datos (y se dice).
 *
 * La autenticación la pone middleware.ts (sesión de Supabase en todo /api/*).
 */

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Tope del rango: dos años de meses, para acotar la consulta. */
const MAX_MESES = 24;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hoy = hoyColombia();
  const mesActual = hoy.slice(0, 7);
  const desde = url.searchParams.get('desde') ?? `${hoy.slice(0, 4)}-01`;
  const hasta = url.searchParams.get('hasta') ?? mesActual;

  if (!MES.test(desde) || !MES.test(hasta) || desde > hasta) {
    return NextResponse.json({ ok: false, mensaje: 'desde/hasta deben ser YYYY-MM y desde ≤ hasta' }, { status: 400 });
  }
  const pedidos = mesesHasta(`${hasta}-01`, desde);
  if (pedidos.length > MAX_MESES) {
    return NextResponse.json({ ok: false, mensaje: `Rango máximo: ${MAX_MESES} meses` }, { status: 400 });
  }

  try {
    const conDatos = new Set(await readMesesOk());
    const meses = pedidos.filter((m) => conDatos.has(m));
    const mesesSinDatos = pedidos.filter((m) => !conDatos.has(m) && m >= MES_INICIAL && m <= mesActual);
    const disponibles = [...conDatos].sort();

    if (!meses.length) {
      return NextResponse.json({
        ok: true,
        completo: false,
        desde,
        hasta,
        meses: [],
        mesesSinDatos,
        mesesDisponibles: disponibles,
        totales: null,
        alPagar: { meses: [], mesesSinDato: [] },
        labs: [],
      });
    }

    // Se consulta el rango continuo [primer, último] mes con datos: los huecos no
    // tienen filas, así que no aportan cifras.
    const pygCompletos = new Set(await readMesesPygCompletos(meses[0], meses[meses.length - 1]));
    const mesesAlPagar = meses.filter((m) => pygCompletos.has(m));
    const filas = await readResumenLabs(meses[0], meses[meses.length - 1], mesesAlPagar);
    const labs = ordenarLabs(filas.map(resumirLab));
    return NextResponse.json({
      ok: true,
      completo: mesesSinDatos.length === 0,
      desde,
      hasta,
      meses,
      mesesSinDatos,
      mesesDisponibles: disponibles,
      // El mes en curso está abierto: sus cifras cambian hasta el cierre.
      incluyeMesAbierto: meses.includes(mesActual),
      totales: totalizar(labs),
      alPagar: { meses: mesesAlPagar, mesesSinDato: meses.filter((m) => !pygCompletos.has(m)) },
      labs,
    });
  } catch (err) {
    console.error('[api/descuentos]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo leer el módulo de descuentos' }, { status: 500 });
  }
}
