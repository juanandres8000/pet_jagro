import { NextResponse } from 'next/server';
import { readFacturasP0, readPagadoPorFactura, readPagosLab, tablaPagosExiste } from '@/lib/hgi/descuentos/pagosStore';
import { claveFactura, estadoFactura } from '@/lib/hgi/descuentos/pagos';
import { sesionPagos } from '@/lib/hgi/descuentos/sesion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Facturas con precio cero de UN laboratorio y lo pagado de cada una
 * (docs/DESCUENTOS.md § "Pagos confirmados").
 *
 *   GET /api/descuentos/facturas?nit=<NIT>&desde=YYYY-MM&hasta=YYYY-MM
 *
 * `puedeRegistrar` le dice a la vista si mostrar los botones de registrar/anular
 * (la API de pagos vuelve a verificarlo). Sesión obligatoria (middleware.ts).
 */

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const NIT = /^\d{5,15}$/;

const finDeMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const nit = url.searchParams.get('nit') ?? '';
  const desde = url.searchParams.get('desde') ?? '';
  const hasta = url.searchParams.get('hasta') ?? '';
  if (!NIT.test(nit) || !MES.test(desde) || !MES.test(hasta) || desde > hasta) {
    return NextResponse.json({ ok: false, mensaje: 'Parámetros: nit (dígitos), desde y hasta (YYYY-MM, desde ≤ hasta)' }, { status: 400 });
  }

  try {
    const { puedeRegistrar } = await sesionPagos();
    // Lecturas EN SERIE (cliente max:1).
    const tablaPagos = await tablaPagosExiste();
    const facturas = await readFacturasP0(`${desde}-01`, finDeMes(hasta), nit);
    const pagado = await readPagadoPorFactura([nit]);
    const pagos = await readPagosLab(nit);

    const pagosPorFactura = new Map<string, typeof pagos>();
    for (const p of pagos) {
      const k = claveFactura(p.nit, p.codigoTransaccion, p.documento);
      pagosPorFactura.set(k, [...(pagosPorFactura.get(k) ?? []), p]);
    }

    return NextResponse.json({
      ok: true,
      nit,
      desde,
      hasta,
      tablaPagos,
      puedeRegistrar: puedeRegistrar && tablaPagos,
      facturas: facturas.map((f) => {
        const k = claveFactura(f.nit, f.codigoTransaccion, f.documento);
        return { ...f, ...estadoFactura(f.costo, pagado.get(k)), pagos: pagosPorFactura.get(k) ?? [] };
      }),
    });
  } catch (err) {
    console.error('[api/descuentos/facturas]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudieron leer las facturas con precio cero' }, { status: 500 });
  }
}
