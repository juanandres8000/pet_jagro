import { NextResponse } from 'next/server';
import { armarInforme, validarParametros } from '@/lib/hgi/rotacion/consulta';
import { hojasRotacion, nombreArchivoRot } from '@/lib/hgi/rotacion/reporte';
import { construirXlsx } from '@/lib/xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Rotación de inventario en Excel, con los mismos parámetros que /api/rotacion.
 *   GET /api/rotacion/reporte?desde=YYYY-MM&hasta=YYYY-MM&bodega=01&dias=30[&proveedor=NIT]
 * Sesión obligatoria (middleware.ts). La ruta no termina en extensión (matcher).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = validarParametros(url);
  if (!v.ok) return NextResponse.json({ ok: false, mensaje: v.mensaje }, { status: 400 });
  const proveedor = url.searchParams.get('proveedor');
  if (proveedor !== null && !/^\d{0,15}$/.test(proveedor)) {
    return NextResponse.json({ ok: false, mensaje: 'proveedor debe ser un NIT' }, { status: 400 });
  }
  try {
    const inf = await armarInforme(v.p);
    if (!inf.completo) {
      return NextResponse.json({ ok: false, mensaje: 'El periodo todavía no tiene todos los meses cargados' }, { status: 409 });
    }
    const productos = proveedor === null ? inf.productos : inf.productos.filter((p) => p.nitProveedor === proveedor);
    const nombreProv = proveedor === null ? null : (inf.proveedores.find((p) => p.nit === proveedor)?.nombre ?? 'Sin proveedor');
    const xlsx = construirXlsx(hojasRotacion(inf, productos, nombreProv));
    const archivo = nombreArchivoRot(inf, nombreProv);
    // ArrayBuffer exacto del archivo: BodyInit no acepta Uint8Array<ArrayBufferLike>.
    const cuerpo = xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer;
    return new NextResponse(cuerpo, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('[api/rotacion/reporte]', (err as Error).message);
    return NextResponse.json({ ok: false, mensaje: 'No se pudo generar el reporte' }, { status: 500 });
  }
}
