import { NextResponse } from 'next/server';
import { armarInforme, validarParametros } from '@/lib/hgi/rotacion/consulta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Sólo lee de Supabase: el cron `rotacion` es el que habla con HGINet.
export const maxDuration = 30;

/**
 * Rotación de inventario (docs/ROTACION.md).
 *
 *   GET /api/rotacion?desde=YYYY-MM&hasta=YYYY-MM&bodega=01|02|03|0|todas&dias=15|30|45|60|90
 *
 * Por producto: inicial, entradas, salidas, final, días en inventario, rotación,
 * existencia actual, cobertura y sugerido de compra para `dias`; totales por
 * proveedor y KPIs. Si falta algún mes entre `desde` y hoy, `completo: false` y
 * SIN cifras (inicial y final se calculan hacia atrás desde la existencia actual).
 * Sesión obligatoria (middleware.ts).
 */
export async function GET(req: Request) {
  const v = validarParametros(new URL(req.url));
  if (!v.ok) return NextResponse.json({ ok: false, mensaje: v.mensaje }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await armarInforme(v.p)) });
  } catch (err) {
    console.error('[api/rotacion]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo leer la rotación de inventario' }, { status: 500 });
  }
}
