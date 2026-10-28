import { NextResponse } from 'next/server';
import { readMesesOk, readReportePrecioCero, readResumenLabs } from '@/lib/hgi/descuentos/store';
import { mesesHasta } from '@/lib/hgi/descuentos/refresh';
import { hojasReporte, nombreArchivo } from '@/lib/hgi/descuentos/resumen';
import { construirXlsx } from '@/lib/xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Reporte descargable "PRECIO CERO <LAB> <periodo>" (.xlsx), el mismo que
 * Jotagro arma a mano factura por factura para cobrarle al laboratorio.
 *
 *   GET /api/descuentos/reporte?nit=<NIT del laboratorio>&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *
 * Sólo lee de Supabase. Sesión obligatoria (middleware.ts). La ruta NO termina en
 * extensión: el matcher del middleware excluye rutas con extensión de imagen.
 */

const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NIT = /^\d{5,15}$/;
// Mismo tope que /api/descuentos (24 meses): la vista arma el enlace con su rango.
const MAX_DIAS = 731;
/** YYYY-MM-DD que además EXISTE en el calendario (Date.parse convierte 02-30 en 03-02). */
const fechaReal = (s: string) => FECHA.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const nit = url.searchParams.get('nit') ?? '';
  const desde = url.searchParams.get('desde') ?? '';
  const hasta = url.searchParams.get('hasta') ?? '';
  if (!NIT.test(nit) || !fechaReal(desde) || !fechaReal(hasta) || desde > hasta) {
    return NextResponse.json({ ok: false, mensaje: 'Parámetros: nit (dígitos), desde y hasta (YYYY-MM-DD, desde ≤ hasta)' }, { status: 400 });
  }
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(dias) || dias > MAX_DIAS) {
    return NextResponse.json({ ok: false, mensaje: `Rango máximo: ${MAX_DIAS} días` }, { status: 400 });
  }

  try {
    // Meses del periodo sin ingesta ok: el .xlsx se usa para cobrar, así que si está
    // incompleto lo dice en la primera fila (y en un header para quien lo consuma).
    const conDatos = new Set(await readMesesOk());
    const sinDatos = mesesHasta(hasta, desde.slice(0, 7)).filter((m) => !conDatos.has(m));
    const lineas = await readReportePrecioCero(nit, desde, hasta);
    // Nombre del laboratorio: del resumen del periodo (el mismo nombre que la vista).
    const labs = await readResumenLabs(desde.slice(0, 7), hasta.slice(0, 7), []);
    const nombre = labs.find((l) => l.nit === nit)?.nombre || nit;
    const xlsx = construirXlsx(hojasReporte({ nit, nombre }, desde, hasta, lineas, sinDatos));
    const archivo = nombreArchivo(nombre, desde, hasta);
    // ArrayBuffer exacto del archivo: BodyInit no acepta Uint8Array<ArrayBufferLike>.
    const cuerpo = xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer;
    return new NextResponse(cuerpo, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Meses-Sin-Datos': sinDatos.join(','),
      },
    });
  } catch (err) {
    console.error('[api/descuentos/reporte]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo generar el reporte' }, { status: 500 });
  }
}
