import { NextResponse } from 'next/server';
import { anularPago, existeFacturaP0, insertarPago, tablaPagosExiste } from '@/lib/hgi/descuentos/pagosStore';
import { validarPago } from '@/lib/hgi/descuentos/pagos';
import { sesionPagos } from '@/lib/hgi/descuentos/sesion';
import { hoyColombia } from '@/lib/hgi/ventas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Registro de pagos del precio cero, factura por factura
 * (docs/DESCUENTOS.md § "Pagos confirmados").
 *
 *   POST   /api/descuentos/pagos         { nit, codigoTransaccion, documento, fechaPago,
 *                                          forma, valor, salda, referencia?, observacion? }
 *   DELETE /api/descuentos/pagos?id=N    anula (no borra) el pago
 *
 * Sólo los correos de lib/hgi/descuentos/permisos.ts; el resto recibe 403. El
 * middleware ya exige sesión.
 */

async function autorizar(): Promise<{ email: string } | NextResponse> {
  const { email, puedeRegistrar } = await sesionPagos();
  if (!email) return NextResponse.json({ ok: false, mensaje: 'Sin sesión' }, { status: 401 });
  if (!puedeRegistrar) {
    return NextResponse.json({ ok: false, mensaje: 'Su usuario no está autorizado para registrar pagos' }, { status: 403 });
  }
  if (!(await tablaPagosExiste())) {
    return NextResponse.json({ ok: false, mensaje: 'El registro de pagos todavía no está habilitado' }, { status: 503 });
  }
  return { email };
}

export async function POST(req: Request) {
  try {
    const auth = await autorizar();
    if (auth instanceof NextResponse) return auth;

    const body = await req.json().catch(() => null);
    const v = validarPago(body, hoyColombia());
    if (!v.ok) return NextResponse.json({ ok: false, mensaje: v.mensaje }, { status: 400 });
    const p = v.pago;
    if (!(await existeFacturaP0(p.nit, p.codigoTransaccion, p.documento))) {
      return NextResponse.json({ ok: false, mensaje: 'Esa factura no tiene precio cero de ese laboratorio' }, { status: 404 });
    }
    const pago = await insertarPago(p, auth.email);
    return NextResponse.json({ ok: true, pago });
  } catch (err) {
    console.error('[api/descuentos/pagos POST]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo registrar el pago' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await autorizar();
    if (auth instanceof NextResponse) return auth;

    const id = Number(new URL(req.url).searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, mensaje: 'id inválido' }, { status: 400 });
    if (!(await anularPago(id, auth.email))) {
      return NextResponse.json({ ok: false, mensaje: 'El pago no existe o ya estaba anulado' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/descuentos/pagos DELETE]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo anular el pago' }, { status: 500 });
  }
}
