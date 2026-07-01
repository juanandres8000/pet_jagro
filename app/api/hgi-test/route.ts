import { NextResponse } from 'next/server';
import { hgiGet, HgiError } from '@/lib/hgi/client';

// Ejecutar siempre en Node (no edge) y sin caché: cada llamada toca HGINet/Neon.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ruta de humo para validar el cliente de HGINet de punta a punta:
 * autentica (o reusa token de Neon) y consulta las líneas de productos.
 */
export async function GET() {
  try {
    const lineas = await hgiGet<unknown[]>('LineasProductos', 'Obtener', { codigo: '*' });
    return NextResponse.json({
      ok: true,
      count: Array.isArray(lineas) ? lineas.length : null,
      data: lineas,
    });
  } catch (err) {
    if (err instanceof HgiError) {
      return NextResponse.json(
        { ok: false, tipo: 'HgiError', codigo: err.codigo, mensaje: err.message, fecha: err.fecha },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, tipo: 'Error', mensaje: (err as Error).message },
      { status: 500 },
    );
  }
}
